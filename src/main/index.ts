import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  session,
  Menu,
  screen,
  shell,
  Tray
} from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { defaultSocketPath, NobilisClient } from './nobilis-client'
import { NobilisProcess } from './nobilis-process'
import { Prefs } from './prefs'
import { Notifier } from './notifications'
import { browserLogin, LOGIN_FLOWS } from './browser-login'
import { solveCaptcha } from './captcha'
import { IPC, POPOUT_FLAG, type PopoutState } from '../shared/ipc'
import { clearnetLinks } from '../shared/clearnet'
import { readCapped, pictureNamedIn } from './imagepage'
import { DEEP_LINK_SCHEMES, isDeepLink } from '../shared/deeplink'
import { allowPickedFile, allowRoot, installMediaHandler, registerMediaScheme } from './media-protocol'
import { defaultDownloadDir, saveMedia } from './downloads'
import type { Buffer as ChatBuffer } from '../shared/wire'
import { log } from './log'

registerMediaScheme()

/**
 * One client per profile. Launching moho again - from a launcher, a terminal,
 * a desktop file - should raise the window that already exists rather than
 * start a second copy.
 *
 * Stacked copies are not merely untidy: they contend for the same daemon,
 * whose own flock lets exactly one nobilis own the socket, so the extras sit
 * there half-working. They also each hold their own notification and tray
 * state, so unread counts and alerts diverge between windows.
 *
 * The lock is per user-data directory, so an explicit `--user-data-dir` still
 * gets its own instance. That is deliberate: it keeps a throwaway profile
 * usable for testing without disturbing a running client.
 */
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
}

/**
 * An `irc://` link that arrived before there was a window to give it to.
 *
 * Clicking one in a browser while moho is closed launches it with the link as
 * an argument, so the link exists a second or two before anything can act on
 * it. Held here and handed over once the renderer is listening, rather than
 * dropped for arriving early.
 */
let pendingDeepLink: string | null = null

/** The first argument that is a link this client handles, if any. */
function deepLinkIn(argv: string[]): string | null {
  return argv.find((a) => isDeepLink(a)) ?? null
}

/**
 * Passes a link to the window, or keeps it until there is one.
 *
 * The scheme is checked again here even though the desktop only sends us the
 * ones we registered for: this comes in as a command-line argument, and an
 * argument is not a promise about its own contents.
 */
function deliverDeepLink(url: string | null): void {
  if (!url || !isDeepLink(url)) return
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(IPC.deepLink, url)
    return
  }
  pendingDeepLink = url
}

let mainWindow: BrowserWindow | null = null

/**
 * Conversations opened in a window of their own, by buffer id.
 *
 * One window per conversation rather than a free-for-all: the point of popping
 * a channel out is to watch it, and two windows watching the same channel
 * would each mark it read and each argue about where its window belongs. So
 * asking for one that is already out raises it instead.
 */
const popouts = new Map<string, BrowserWindow>()

let tray: Tray | null = null
let prefs: Prefs
let nobilis: NobilisProcess
let client: NobilisClient
let notifier: Notifier
let registeredHotkey: string | null = null

/**
 * Where the bundled icons and other resources actually are.
 *
 * Packaged, that is simply process.resourcesPath. Unpackaged it is not
 * app.getAppPath(): Electron given a script reports that script's *directory*
 * as the app path, which for `electron out/main/index.js` is out/main, and
 * resources live two levels up from there. Guessing wrong is quiet in the
 * worst way - the tray falls back to an empty image and the panel draws a
 * broken-icon placeholder where the icon should be - so this looks for the
 * directory rather than assuming where it is.
 */
function resourceRoot(): string {
  if (app.isPackaged) return process.resourcesPath
  let dir = app.getAppPath()
  for (let up = 0; up < 4; up++) {
    const candidate = path.join(dir, 'resources')
    if (fs.existsSync(path.join(candidate, 'icons'))) return candidate
    dir = path.dirname(dir)
  }
  return path.join(app.getAppPath(), 'resources')
}

function resourcePath(...parts: string[]): string {
  return path.join(resourceRoot(), ...parts)
}

/**
 * The Sneedchat smiley images live in the nobilis repository, next to the table
 * that names them, so the daemon's shortcode list and the files it refers to
 * can't drift apart. Packaging copies them out of the submodule; in
 * development they are read from the checkout in place.
 */
function smiliesPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sneedchat-smilies')
    : path.join(app.getAppPath(), 'nobilis', 'resources', 'sneedchat-smilies')
}

/**
 * The image format a file's own leading bytes call for, or null.
 *
 * By content rather than by extension: the picker filters on names, which say
 * nothing about what is actually inside.
 */
function sniffImage(head: Buffer): string | null {
  const ascii = head.subarray(0, 12).toString('latin1')
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
  if (ascii.startsWith('GIF8')) return 'gif'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp'
  if (ascii.slice(4, 8) === 'ftyp' && ascii.slice(8, 12).startsWith('avi')) return 'avif'
  // SVG is text, so there are no magic bytes - look for the root element.
  if (/^\s*(<\?xml|<svg)/i.test(ascii)) return 'svg'
  return null
}

/** Every window with a renderer in it, main and popped-out conversations alike. */
function liveWindows(): BrowserWindow[] {
  const all = mainWindow ? [mainWindow, ...popouts.values()] : [...popouts.values()]
  return all.filter((w) => !w.isDestroyed())
}

/**
 * A daemon event, to every window.
 *
 * Each window runs its own copy of the renderer's store, so each has to be
 * told separately - a popped-out channel that only main heard about would sit
 * there frozen at whatever it held when it opened.
 */
function send(channel: string, ...args: unknown[]): void {
  for (const w of liveWindows()) w.webContents.send(channel, ...args)
}

/** The window an IPC call came from, so a handler acts on its own caller. */
function callerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * Put a window on screen, once.
 *
 * Not `ready-to-show` alone, which is what every one of these used to be.
 * That event is the first frame the compositor accepted, and a GPU process
 * that restarts underneath it can leave that frame - and so the event - never
 * arriving. The window then exists, holds its buffer, answers IPC and is
 * simply invisible: moho looks like it failed to start, or a conversation
 * popped out looks like a click that did nothing until a second click finds it
 * already open and raises it.
 *
 * So whichever of "painted" and "loaded" comes first is taken as good enough.
 * The gap between them is a fraction of a second of the background colour,
 * which is a far better failure than no window at all.
 */
function revealOnce(win: BrowserWindow, focus = false): void {
  let done = false
  const reveal = (): void => {
    if (done || win.isDestroyed()) return
    done = true
    win.show()
    if (focus) win.focus()
  }
  win.once('ready-to-show', reveal)
  win.webContents.once('did-finish-load', reveal)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 480,
    minHeight: 360,
    show: false,
    // The title bar is drawn by the renderer (TitleBar.tsx) so it can carry
    // the same surface treatment as the rest of the app, matching how the
    // original floating window looked.
    frame: false,
    backgroundColor: '#101418',
    icon: resourcePath('icons', 'moho.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  revealOnce(mainWindow)

  // A link that arrived before this window existed - from the click that
  // launched moho - goes over once the renderer is listening for it. Cleared
  // as it goes, so it is acted on once rather than again on every reload.
  mainWindow.webContents.on('did-finish-load', () => {
    if (!pendingDeepLink) return
    const url = pendingDeepLink
    pendingDeepLink = null
    mainWindow?.webContents.send(IPC.deepLink, url)
  })
  mainWindow.on('maximize', () => mainWindow?.webContents.send(IPC.maximizeChanged, true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send(IPC.maximizeChanged, false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow)
}

/**
 * The directory this machine keeps throwaway files in.
 *
 * Asked of Electron, which knows the platform's answer - `~/.cache`,
 * `%LOCALAPPDATA%`, `~/Library/Caches` - but does not list `cache` among the
 * names in `getPath`'s typings, hence the widened signature and the guard.
 *
 * The fallback is the XDG rule, and it is a fallback rather than the rule
 * because on Windows it produces `C:\Users\<name>\.cache`: a dotfile
 * directory in the profile root, which works and is not where anything else on
 * that system looks. nobilis learned that one the hard way with its own data
 * directory - see `default_data_dir` there.
 */
function cacheRoot(): string {
  try {
    return (app.getPath as (name: string) => string)('cache')
  } catch {
    return process.env['XDG_CACHE_HOME'] || path.join(app.getPath('home'), '.cache')
  }
}

function loadRenderer(win: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** What is popped out, and what of it is actually on screen. */
function popoutState(): PopoutState {
  const open: string[] = []
  const watched: string[] = []
  for (const [bufferId, win] of popouts) {
    if (win.isDestroyed()) continue
    open.push(bufferId)
    if (win.isVisible() && !win.isMinimized()) watched.push(bufferId)
  }
  return { open, watched }
}

function publishPopouts(): void {
  send(IPC.popoutsChanged, popoutState())
  // The tray counts what is unread, and a watched conversation is not.
  notifier?.publish()
}

/**
 * Where this conversation's window was last left.
 *
 * Remembered per conversation rather than one size for all of them, because
 * the reason to pop several out is to arrange them - and an arrangement that
 * has to be rebuilt every session is not one worth making.
 *
 * A remembered position is only honoured if some display still contains it.
 * Monitors get unplugged, and a window restored onto one that is no longer
 * there opens somewhere nobody can reach.
 */
function savedPopoutBounds(bufferId: string): Partial<Electron.Rectangle> {
  const all = prefs.get<Record<string, Electron.Rectangle>>('ui.popoutBounds', {}) ?? {}
  const b = all[bufferId]
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return {}
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return { width: b.width, height: b.height }

  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    // Overlap rather than containment: half off the edge of a display is a
    // position somebody chose, and dragging it back is trivial. Entirely
    // outside every display is not.
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  })
  return onScreen ? b : { width: b.width, height: b.height }
}

function rememberPopoutBounds(bufferId: string, win: BrowserWindow): void {
  // A maximised or minimised window's bounds are the state it is in, not the
  // size it should come back as.
  if (win.isDestroyed() || win.isMaximized() || win.isMinimized() || !win.isVisible()) return
  const all = { ...(prefs.get<Record<string, Electron.Rectangle>>('ui.popoutBounds', {}) ?? {}) }
  all[bufferId] = win.getBounds()
  prefs.set('ui.popoutBounds', all)
}

/**
 * Opens a conversation in a window of its own, or raises the one it has.
 *
 * The window loads the same renderer as everything else and is told which
 * conversation it is; what makes it a popout is only that its store is pinned
 * to that one buffer, so every part of a conversation - the log, the composer,
 * the member list, dropping a file on it - is the same code doing the same job
 * in a smaller frame.
 */
function openPopout(bufferId: string, title?: string): void {
  const existing = popouts.get(bufferId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 320,
    minHeight: 240,
    ...savedPopoutBounds(bufferId),
    show: false,
    frame: false,
    backgroundColor: '#101418',
    icon: resourcePath('icons', 'moho.png'),
    title: title ?? 'moho',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`${POPOUT_FLAG}${bufferId}`]
    }
  })
  popouts.set(bufferId, win)

  // Focused as well as shown: unlike the main window at startup, this one was
  // asked for just now.
  revealOnce(win, true)

  // Sent to this window rather than broadcast: every window draws its own
  // title bar, and they are not maximised together.
  win.on('maximize', () => win.webContents.send(IPC.maximizeChanged, true))
  win.on('unmaximize', () => win.webContents.send(IPC.maximizeChanged, false))
  // Whether this conversation counts as watched changes with the window, so
  // every one of these has to be answered - a minimised popout badges and
  // alerts again, and a restored one stops.
  win.on('show', publishPopouts)
  win.on('hide', publishPopouts)
  win.on('minimize', publishPopouts)
  win.on('restore', publishPopouts)
  // Coming back into view is reading it: whatever piled up while this window
  // was minimised has now been looked at, and should stop lighting the tray.
  const seen = (): void => notifier?.clear(bufferId)
  win.on('show', seen)
  win.on('restore', seen)
  win.on('focus', seen)
  win.on('resize', () => rememberPopoutBounds(bufferId, win))
  win.on('move', () => rememberPopoutBounds(bufferId, win))
  win.on('closed', () => {
    popouts.delete(bufferId)
    publishPopouts()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win)
  publishPopouts()
}

function toggleWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function trayIcon(hasAlert: boolean): Electron.NativeImage {
  const file = resourcePath('icons', hasAlert ? 'tray-alert.png' : 'tray.png')
  const img = nativeImage.createFromPath(file)
  // A missing icon file would otherwise produce an invisible tray entry the
  // user can never click; fall back to the app icon so the entry still exists.
  return img.isEmpty() ? nativeImage.createFromPath(resourcePath('icons', 'moho.png')) : img
}

function createTray(): void {
  tray = new Tray(trayIcon(false))
  tray.setToolTip('moho')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show/hide', click: toggleWindow },
      { label: 'Restart daemon', click: () => nobilis.restart() },
      {
        label: 'Stop daemon',
        // Deliberately separate from Quit: stopping the daemon disconnects
        // every account, which is worth asking for explicitly rather than
        // making it a side effect of closing a window.
        click: () => {
          void stopDaemon()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        }
      }
    ])
  )
  tray.on('click', toggleWindow)
}

function updateTray(unreadCount: number, hasAlert: boolean): void {
  if (!tray) return
  tray.setImage(trayIcon(hasAlert))
  tray.setToolTip(unreadCount > 0 ? `moho - ${unreadCount} unread` : 'moho')
  send(IPC.link, client.linkUp)
}

const SOCKET_PATH = defaultSocketPath()

/**
 * Stop the daemon and wait for it to be gone. Asking over the socket is what
 * reaches a daemon this process adopted; a spawned one is signalled directly.
 * Either way nobilis sends real QUITs to every connected network on the way
 * out, so this waits rather than cutting them short.
 */
async function stopDaemon(): Promise<void> {
  await nobilis.stopAndWait(SOCKET_PATH, () => client.request('shutdown'))
  client.stop()
  send(IPC.link, false)
}

function applyHotkey(accelerator: string): void {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey)
    registeredHotkey = null
  }
  if (!accelerator) return
  try {
    if (globalShortcut.register(accelerator, toggleWindow)) registeredHotkey = accelerator
    else log.warn('[hotkey] refused by the system:', accelerator)
  } catch (e) {
    log.warn('[hotkey] invalid accelerator:', accelerator, (e as Error).message)
  }
}

function wireIpc(): void {
  ipcMain.handle(IPC.rpc, async (_e, method: string, params: Record<string, unknown>) => {
    try {
      return { ok: true, result: await client.request(method, params) }
    } catch (err) {
      // Surfaced as a value rather than a rejection so the renderer sees
      // nobilis's own error text (which is often the actionable part - "account
      // not connected", "no such buffer") instead of a generic IPC failure.
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.prefsGetAll, () => prefs.all())
  ipcMain.handle(IPC.prefsSet, (e, key: string, value: unknown) => {
    prefs.set(key, value)
    // Every window keeps its own cache of these, so a setting changed in one
    // is stale in the others until they are told. That is not cosmetic once
    // there are several windows: muting a conversation, or switching the log
    // to compact, would apply to whichever window happened to be asked.
    // Not echoed to the window that set it - it already knows, and has drawn.
    for (const w of liveWindows()) {
      if (w.webContents !== e.sender) w.webContents.send(IPC.prefsChanged, key, value)
    }
    // Pins and mutes feed the tray/notification rules, which live here.
    if (key === 'pinnedBuffers' || key === 'mutedBuffers') notifier.publish()
    if (key === 'hotkey.toggle') applyHotkey(String(value))
  })

  ipcMain.handle(IPC.markBufferRead, (_e, bufferId: string) => notifier.clear(bufferId))

  // Every window draws its own title bar, so these act on whichever window
  // asked rather than on the main one - a popout's minimise button used to
  // minimise the window behind it.
  ipcMain.handle(IPC.windowMinimize, (e) => callerWindow(e)?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, (e) => {
    const win = callerWindow(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle(IPC.windowClose, (e) => {
    const win = callerWindow(e)
    if (!win) return
    // Closing the main window hides it to the tray, which is where moho's
    // lifetime lives. A popout has no such role: closing one is meant to be
    // closing it, and hiding it instead would leave a conversation marked as
    // watched with no window to watch it in.
    if (win === mainWindow) win.hide()
    else win.close()
  })
  ipcMain.handle(IPC.windowIsMaximized, (e) => callerWindow(e)?.isMaximized() ?? false)

  ipcMain.handle(IPC.popoutOpen, (_e, bufferId: string, title?: string) => {
    if (typeof bufferId === 'string' && bufferId) openPopout(bufferId, title)
  })
  ipcMain.handle(IPC.popoutClose, (_e, bufferId: string, andShow?: boolean) => {
    const win = popouts.get(bufferId)
    if (win && !win.isDestroyed()) win.close()
    // Putting a conversation back means it should still be in front of you.
    if (!andShow || !mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send(IPC.activateBuffer, bufferId)
  })
  ipcMain.handle(IPC.popoutList, () => popoutState())

  /**
   * Which picture a page is showing.
   *
   * Forum posts wrap a thumbnail in a link to the image host's *page* - the
   * picture is one thing on it - so the only address the message carries for
   * the full-size copy is a page address. Every such host says what it is
   * showing in an OpenGraph tag, because every one of them wants a preview
   * when the link is pasted into a chat window, so one request and one tag
   * answers it for all of them with no per-host knowledge.
   *
   * In the main process because a `file://` document cannot read a
   * cross-origin reply, and asked only when somebody opens a picture - never
   * as a message arrives.
   */
  ipcMain.handle(IPC.resolveImagePage, async (_e, raw: string): Promise<string | null> => {
    let page: URL
    try {
      page = new URL(clearnetLinks(raw))
    } catch {
      return null
    }
    if (page.protocol !== 'https:') return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(page, { signal: controller.signal, redirect: 'follow' })
      // Only a page has the tag, and only a page is small enough to read
      // without asking how big it is first. Anything else - a file, a stream,
      // a download - is refused before a byte of the body is touched.
      if (!res.ok || !(res.headers.get('content-type') || '').startsWith('text/html')) return null
      const html = await readCapped(res)
      return pictureNamedIn(html, page)
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle(IPC.openExternal, (_e, raw: string) => {
    // The forum's onion address, sent to the browser as the clearnet one it is
    // the same site as. Here as well as in the window because a link is not
    // always something a message said: a picture fetched from the site carries
    // an address of its own, and "open in browser" on one of those would hand
    // the system a name it cannot resolve.
    const url = clearnetLinks(raw)
    // Only ever hand the OS a real web/mail link - a message body is fully
    // attacker-controlled, and shell.openExternal will happily launch things
    // like `file://` or a custom app scheme otherwise.
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
  })

  // Where to write something the app is about to produce - a key export, so
  // far. Separate from pickFile because the two dialogs ask opposite
  // questions, and a save dialog that cannot name a default file is a save
  // dialog people cancel.
  // What could be shared into a call. Thumbnails at a size worth looking at
  // but not worth waiting for - this is a picker, not a preview.
  ipcMain.handle(IPC.screenSources, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL()
    }))
  })

  ipcMain.handle(IPC.pickSavePath, async (e, suggested?: string) => {
    const parent = callerWindow(e) ?? mainWindow
    if (!parent) return null
    const res = await dialog.showSaveDialog(parent, { defaultPath: suggested })
    return res.canceled || !res.filePath ? null : res.filePath
  })

  ipcMain.handle(IPC.pickFile, async (e) => {
    const parent = callerWindow(e) ?? mainWindow
    if (!parent) return null
    const res = await dialog.showOpenDialog(parent, { properties: ['openFile'] })
    if (res.canceled || !res.filePaths[0]) return null
    // The renderer draws a thumbnail of what was staged, and that goes back
    // through the guarded media scheme like every other local file. Where
    // somebody keeps their pictures is not an allowed root and should not
    // become one, so the picked file is permitted on its own.
    allowPickedFile(res.filePaths[0])
    return res.filePaths[0]
  })

  ipcMain.handle(IPC.pickDirectory, async (e) => {
    const parent = callerWindow(e) ?? mainWindow
    if (!parent) return null
    const res = await dialog.showOpenDialog(parent, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // Where downloads land when the user hasn't chosen somewhere. Electron
  // resolves this per-platform - XDG_DOWNLOAD_DIR on Linux, FOLDERID_Downloads
  // on Windows - with one guard for where that lookup degrades; see
  // defaultDownloadDir.
  ipcMain.handle(IPC.defaultDownloadDir, () => defaultDownloadDir(app.getPath('downloads')))

  ipcMain.handle(IPC.downloadMedia, async (_e, source: string, filename?: string) =>
    saveMedia(
      source,
      filename,
      String(prefs.get('downloads.directory', '') || defaultDownloadDir(app.getPath('downloads'))),
      // Electron's net rather than global fetch: it follows the app's own
      // proxy and certificate settings, which a plain fetch would not.
      async (url) => {
        const res = await net.fetch(url)
        return {
          ok: res.ok,
          status: res.status,
          bytes: async () => new Uint8Array(await res.arrayBuffer())
        }
      }
    )
  )

  /**
   * Picks an image and keeps a copy as a rail entry's icon.
   *
   * Copied into the app's own directory rather than referenced where it sits:
   * the original may be on removable media, in a temp folder, or simply moved
   * later, and an icon that silently disappears is worse than none. That
   * directory is already a permitted media root, so the renderer can load it
   * back through the same guarded scheme as everything else.
   */
  ipcMain.handle(IPC.importGroupIcon, async (e, groupId: string) => {
    const parent = callerWindow(e) ?? mainWindow
    if (!parent) return { error: 'no window' }
    const res = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'] }]
    })
    if (res.canceled || !res.filePaths[0]) return {}
    try {
      const source = res.filePaths[0]
      // Trust the bytes, not the extension - a file named .png that isn't one
      // would render as a broken tile with nothing to explain why.
      const head = await fsp.readFile(source, { flag: 'r' }).then((b) => b.subarray(0, 16))
      const kind = sniffImage(head)
      if (!kind) return { error: 'that file is not an image moho can display' }

      const dir = path.join(app.getPath('userData'), 'group-icons')
      await fsp.mkdir(dir, { recursive: true })
      // Named for the group, so replacing an icon leaves nothing behind, with
      // a cache-buster since the path is what the renderer keys on.
      const safe = groupId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80)
      for (const stale of await fsp.readdir(dir).catch(() => [])) {
        if (stale.startsWith(`${safe}.`)) await fsp.rm(path.join(dir, stale)).catch(() => {})
      }
      const target = path.join(dir, `${safe}.${Date.now()}.${kind}`)
      await fsp.copyFile(source, target)
      return { path: target }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.readClipboardImage, () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const dir = path.join(os.tmpdir(), 'moho-paste')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `paste-${Date.now()}.png`)
    fs.writeFileSync(file, img.toPNG())
    return file
  })

  // Putting something on the clipboard from here rather than through the
  // page's own `navigator.clipboard`, which wants a secure context and a
  // permission this app has no way to grant itself. Text only: the renderer
  // has no business writing anything else onto the system clipboard.
  ipcMain.handle(IPC.writeClipboardText, (_e, text: string) => {
    if (typeof text === 'string' && text.length > 0) clipboard.writeText(text)
  })

  ipcMain.handle(IPC.restartDaemon, () => nobilis.restart())
  ipcMain.handle(IPC.daemonStatus, () => ({
    binaryPath: nobilis.binaryPath,
    available: nobilis.available(),
    linkUp: client.linkUp
  }))
  /**
   * Sign in through the service's own login page.
   *
   * The captured credential goes straight from the login window to the daemon
   * and is never returned here, so it never enters the renderer at all - only
   * whether it worked comes back. Nothing in this path is logged: an error
   * from the daemon is passed through, but the token never appears in one.
   */
  ipcMain.handle(IPC.browserLogin, async (_e, service: string, accountId?: string) => {
    const flow = LOGIN_FLOWS[service]
    if (!flow) return { ok: false, error: `No browser sign-in is defined for ${service}` }
    const outcome = await browserLogin(service)
    if (!outcome.ok || !outcome.value) return { ok: false, error: outcome.error }
    try {
      await client.request(flow.finish.method, {
        [flow.finish.param]: outcome.value,
        ...(outcome.extra ? { [outcome.extra.param]: outcome.extra.value } : {}),
        ...(accountId ? { accountId } : {})
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * Discord's captcha, answered in a window belonging to the one that asked.
   *
   * Parented so it sits over the window somebody is working in rather than
   * appearing somewhere else on the desktop - the challenge belongs to the
   * action, and the action belongs to a window.
   */
  ipcMain.handle(IPC.solveCaptcha, async (e, request: { sitekey: string; rqdata?: string | null }) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    return await solveCaptcha(request, parent)
  })

  ipcMain.handle(IPC.smiliesDir, () => smiliesPath())
}

app.whenReady().then(() => {
  // A losing second instance is on its way out; it must not spawn a daemon,
  // claim a tray icon or register a hotkey on the way.
  if (!isPrimaryInstance) return

  // On Debian systems, if the AppImage is run, the Electron process may run
  // silently in an unsafe `--no-sandbox` mode. We check for this and provide
  // guidance for using the deb package instead.
  if (app.commandLine.hasSwitch('no-sandbox') && !process.env.MOHO_ALLOW_NO_SANDBOX) {
    dialog.showErrorBox(
      'Sandbox Disabled',
      'Moho refused to start because Chromium sandboxing is disabled (--no-sandbox).\n\n' +
      'Running without a sandbox exposes your system to security risks.\n\n' +
      '• On Ubuntu/Debian: Please install the .deb package, which includes full AppArmor sandbox support.\n' +
      '• To bypass this check at your own risk, set MOHO_ALLOW_NO_SANDBOX=1.'
    )
    app.quit()
    return
  }

  // Before anything worth logging happens. Everything the daemon says is
  // piped through `log`, and in a launched build stdout is /dev/null - so
  // without this there is no record of a backend failing, anywhere, ever.
  log.toDirectory(path.join(cacheRoot(), 'moho'))
  log.info('moho starting, logging to', log.file() ?? '(nowhere)')

  electronApp.setAppUserModelId('com.salastil.moho')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // A call needs a microphone, and Chromium will not hand one over without
  // being asked. Unanswered, the request does not fail - it hangs, which is
  // what a call that never started looked like: no error, no ringing, nothing.
  //
  // Granted only to this application's own windows, on the default session.
  // A sign-in window loads somebody else's page and runs in a partition of
  // its own, which this handler never sees.
  const allowed = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))

  // Someone tried to launch a second copy: treat it as "show me moho", which
  // is almost always what they meant - especially when the window is hidden
  // to the tray and looks like nothing is running.
  app.on('second-instance', (_event, argv) => {
    // The desktop launches a fresh copy to open a link and lets the running
    // one take it, so the link arrives here rather than at startup on every
    // click after the first.
    const link = deepLinkIn(argv)
    if (!mainWindow) {
      pendingDeepLink = link ?? pendingDeepLink
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    deliverDeepLink(link)
  })

  // macOS does not use argv for this; it wakes a running app with an event.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    deliverDeepLink(url)
  })

  // Asks the desktop to send us irc:// links. Registered every start rather
  // than once: an association can be taken by something else installed later,
  // and re-registering is how every other client keeps it.
  for (const scheme of DEEP_LINK_SCHEMES) {
    // In development the executable is Electron itself, so the entry point has
    // to be named too or the desktop would launch a bare Electron.
    if (is.dev && process.platform === 'win32') {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1] ?? '')])
    } else {
      app.setAsDefaultProtocolClient(scheme)
    }
  }

  // One that came in on the command line, from a click that started moho.
  pendingDeepLink = deepLinkIn(process.argv) ?? pendingDeepLink

  // Bundled Sneedchat smilies are served through the same guarded scheme as
  // nobilis's cached media, so the renderer needs no file access of its own.
  allowRoot(resourcePath())
  allowRoot(smiliesPath())
  installMediaHandler()

  prefs = new Prefs()
  nobilis = new NobilisProcess()
  client = new NobilisClient()

  notifier = new Notifier(
    prefs,
    updateTray,
    (bufferId) => {
      // If this conversation has a window of its own, that window is what the
      // click asked for. Raising the main one and switching it would move
      // somebody away from whatever they were reading in order to show them a
      // conversation that was already open on their screen.
      const popout = popouts.get(bufferId)
      if (popout && !popout.isDestroyed()) {
        if (popout.isMinimized()) popout.restore()
        popout.show()
        popout.focus()
        return
      }
      mainWindow?.show()
      mainWindow?.focus()
      mainWindow?.webContents.send(IPC.activateBuffer, bufferId)
    },
    () => mainWindow?.webContents ?? null,
    (bufferId) => popoutState().watched.includes(bufferId)
  )

  client.on('link', (up) => {
    send(IPC.link, up)
    if (!up) return
    // The daemon usually outlives this process, so its buffers were announced
    // long before this connection existed and no bufferListChange is coming
    // for them. Without asking outright, main knows of no conversations at
    // all - and it has to know which ones are direct messages to light the
    // tray for them, and which group each belongs to for the mute rules.
    void client
      .request('listBuffers')
      .then((list: ChatBuffer[]) => {
        for (const b of list) notifier.trackBuffer(b, false)
        notifier.publish()
      })
      .catch(() => {
        // Not fatal: live events still fill this in as things change.
      })
  })
  client.on('push', (frame) => {
    // Main watches two event kinds of its own: the buffer list (so mute
    // cascade can find an account's server buffer) and notifications (tray +
    // desktop alerts, which must keep working while the window is closed).
    if (frame.event === 'bufferListChange') {
      notifier.trackBuffer(frame.data as ChatBuffer, !!frame.data?.removed)
    } else if (frame.event === 'notification') {
      void notifier.handle(frame.data)
    }
    send(IPC.event, frame)
  })

  wireIpc()
  // Adopt a daemon that is already listening rather than launching a second
  // one that would immediately lose the flock race and exit.
  void nobilis.ensureRunning(SOCKET_PATH).then(() => client.start())
  createWindow()
  createTray()
  applyHotkey(prefs.get<string>('hotkey.toggle'))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The tray is the app's real lifetime anchor: closing the window hides it, so
// there is nothing to quit on last-window-closed on any platform.
app.on('window-all-closed', () => {})

/**
 * Quitting takes the daemon with it, adopted or not.
 *
 * will-quit is synchronous, which is not enough here: nobilis needs a moment
 * to send QUITs to every connected network before exiting, and a bare kill
 * leaves ghost sessions holding nicks until the server's ping timeout notices.
 * So the quit is deferred until the daemon is actually gone.
 */
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  globalShortcut.unregisterAll()
  prefs?.flushNow()
  void stopDaemon()
    .catch((e) => log.warn('[nobilis] stop on quit failed:', (e as Error).message))
    .finally(() => app.exit(0))
})
