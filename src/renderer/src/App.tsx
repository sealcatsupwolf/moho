import { useEffect, useRef, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { BufferList } from './components/BufferList'
import { ServerRail } from './components/ServerRail'
import { MessageList } from './components/MessageList'
import { MentionsInbox } from './components/MentionsInbox'
import { MentionsPage } from './components/MentionsPage'
import { INVITE_PREFIX } from './lib/groups'
import { Composer } from './components/Composer'
import { MembershipGate } from './components/MembershipGate'
import { NickList } from './components/NickList'
import { ThreadPanel } from './components/ThreadPanel'
import { InvitePanel } from './components/InvitePanel'
import { VerificationDialog } from './components/VerificationDialog'
import { ProfileCard } from './components/ProfileCard'
import { ConversationTools } from './components/ConversationTools'
import { AccountsPanel } from './components/AccountsPanel'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { DownloadsPanel } from './components/DownloadsPanel'
import { JoinPanel } from './components/JoinPanel'
import { Toasts } from './components/Toasts'
import { IncomingCallPanel } from './components/IncomingCallPanel'
import { CallStage, IncomingMatrixCall, ScreenPicker } from './components/CallStage'
import { StreamStage } from './components/StreamStage'
import { DiscordModal } from './components/DiscordModal'
import { FileDrop } from './components/FileDrop'
import { TransferPanel } from './components/TransferPanel'
import { Icon, IconButton } from './components/Icon'
import { ConversationMenu } from './components/ConversationMenu'
import { watchDelta, watchedKickBuffers } from './lib/kickwatch'
import { useActiveBuffer, useChat, usePref, usePrefsReady, useStore } from './state/hooks'
import { bufferDisplayName } from './lib/util'
import type { BufferEntry } from './state/store'
import { loadLocalEmotes } from './lib/emotecache'

export default function App(): JSX.Element {
  const store = useStore()
  const prefsReady = usePrefsReady()
  const [booted, setBooted] = useState(false)

  const accounts = useChat((s) => s.accounts)
  const allBuffers = useChat((s) => s.buffers)
  const activePanel = useChat((s) => s.activePanel)
  const activeBufferId = useChat((s) => s.activeBufferId)
  // A call whose conversation is not the one on screen. The stage lives in
  // the conversation; this is the corner it retreats to.
  const activeCall = useChat((s) => s.activeCall)
  const activeGroupId = useChat((s) => s.activeGroupId)
  // A stream being watched, which walks away the same way a call does.
  const watching = useChat((s) => s.watching)
  const joinPanelAccountId = useChat((s) => s.joinPanelAccountId)
  const buffer = useActiveBuffer()
  const joinAccount = accounts.find((a) => a.id === joinPanelAccountId)
  // Shown in the corner only when the conversation it belongs to is not the
  // one being read - and not while a panel is covering the log either, since
  // that is walking away from it too.
  const callElsewhere = !!activeCall && (activeCall.bufferId !== activeBufferId || activePanel !== '')
  const streamElsewhere = !!watching && (watching.bufferId !== activeBufferId || activePanel !== '')

  const [sidebarFolded, setSidebarFolded] = usePref<boolean>('ui.sidebarFolded', false)
  const [userListFolded, setUserListFolded] = usePref<boolean>('ui.userListFolded', false)
  const [savedBufferId] = usePref<string>('ui.activeBufferId', '')
  const [savedGroupId] = usePref<string>('ui.activeGroupId', '')

  // Boot once prefs have loaded, so the restored buffer selection is available
  // before the store asks nobilis for its backlog.
  useEffect(() => {
    if (!prefsReady || booted) return
    setBooted(true)
    void store.init(savedBufferId, savedGroupId)
    // What the daemon has already shrunk, asked for once. Without it every
    // Kick emote would be drawn at its full 500x500 once per session before
    // its small copy was noticed - the cache is on disk and outlives the
    // window, so there is no reason to rediscover it a megabyte at a time.
    void loadLocalEmotes()
    return () => store.dispose()
  }, [prefsReady, booted, savedBufferId, savedGroupId, store])

  // Which Kick channels are actually being watched, told to the daemon as it
  // changes. Kick counts watch time from an authenticated subscription and
  // only this side knows what is on screen - see lib/kickwatch.ts for why it
  // is exactly the open conversation plus anything playing video, and nothing
  // more.
  const watchedRef = useRef<string[]>([])
  useEffect(() => {
    if (!booted) return
    // The whole list, not just the open one: picture-in-picture plays a
    // channel that is deliberately not the conversation on screen, and
    // looking it up in a list of one would have silently skipped exactly the
    // case the scoping promises to cover.
    const serviceOf = (id: string): string | undefined =>
      accounts.find((a) => a.id === allBuffers.find((b) => b.id === id)?.accountId)?.service
    const now = watchedKickBuffers(
      allBuffers,
      activePanel === '' ? activeBufferId : '',
      watching?.bufferId,
      serviceOf
    )
    const { start, stop } = watchDelta(watchedRef.current, now)
    watchedRef.current = now
    for (const bufferId of stop) {
      void window.moho.rpc('setKickWatching', { bufferId, watching: false }).catch(() => {})
    }
    for (const bufferId of start) {
      // Quietly: a channel that is not live cannot be watched, which the
      // daemon answers rather than treats as a failure.
      void window.moho.rpc('setKickWatching', { bufferId, watching: true }).catch(() => {})
    }
  }, [booted, allBuffers, accounts, activeBufferId, activePanel, watching])

  const openThread = useChat((s) => s.openThread)

  // A stale restored id is harmless: it simply resolves to no buffer and the
  // empty state shows, exactly as it would for "".
  const showNickList =
    !userListFolded && activePanel === '' && buffer?.kind === 'channel'

  const headerTitle =
    activePanel === 'accounts'
      ? 'Accounts'
      : activePanel === 'settings'
        ? 'Settings'
        : activePanel === 'downloads'
        ? 'Downloads'
        : activePanel === 'join'
        ? `Join · ${joinAccount?.displayName ?? ''}`
        : activePanel === 'mentions'
        ? 'Mentions'
        : buffer
          ? bufferDisplayName(buffer.name)
          : ''

  return (
    <div className="app">
      <TitleBar />

      <div className="app-body">
        {!sidebarFolded && (
          <>
            {/* The rail folds away with the channel list: they are one
                navigation surface, and leaving a strip of server icons beside
                a collapsed sidebar would be a column that selects something
                you cannot see. */}
            <ServerRail />
            <div className="sidebar">
              <BufferList />
            </div>
            <div className="divider-v" />
          </>
        )}

        <div className="main-column">
          <div className="main-header">
            <IconButton
              name={sidebarFolded ? 'chevron_right' : 'chevron_left'}
              title={sidebarFolded ? 'Show sidebar' : 'Hide sidebar'}
              onClick={() => setSidebarFolded(!sidebarFolded)}
            />
            {/* A conversation is headed by whoever it is with, the same way
                its row in the list is - the picture and the name together,
                and both are the way into its menu. The row in the list is
                somewhere you go to find a conversation; this is where you
                already are when you want to do something to the one you are
                reading. */}
            {activePanel === '' && buffer ? (
              <ConversationMenu buffer={buffer} />
            ) : (
              <span className="main-header-title ellipsis">{headerTitle}</span>
            )}

            {/* The face, the search and the call button all act on the open
                conversation, which the mentions page is not showing - leaving
                them there would offer to search a channel that isn't on
                screen. */}
            {activePanel === '' && buffer && (
              <ConversationTools buffer={buffer} />
            )}

            {/* The inbox is about everywhere rather than about this
                conversation, so it sits outside the conversation's own tools -
                but beside them, because the header is where the things you
                glance at live. Shown on every page for the same reason: a
                mention does not stop mattering because you are reading a
                direct message. */}
            {activePanel === '' && <MentionsInbox />}

            {activePanel === '' && buffer?.kind === 'channel' && (
              <IconButton
                name={userListFolded ? 'group' : 'group_off'}
                title={userListFolded ? 'Show members' : 'Hide members'}
                onClick={() => setUserListFolded(!userListFolded)}
              />
            )}

            {/* Beside the member list toggle rather than among the
                conversation's own tools: both of these are about how this
                conversation is being shown, not about the conversation. Last,
                because it is the one that opens something. */}
            {activePanel === '' && buffer && <PopOutButton buffer={buffer} />}
            {activePanel !== '' && (
              <IconButton
                name="close"
                title="Back to chat"
                onClick={() => store.setActivePanel('')}
              />
            )}
          </div>

          <div className="main-body">
            <Body
              activePanel={activePanel}
              hasAccounts={accounts.length > 0}
              hasBuffer={!!activeBufferId}
              activeGroupId={activeGroupId}
            />
          </div>

          {activePanel === '' && activeBufferId !== '' && (
            <>
              {/* Above the box, saying why it will not work here yet. */}
              {buffer && <MembershipGate buffer={buffer} />}
              <Composer />
            </>
          )}
        </div>

        {/* A thread stands where the member list would, and closes it while
            it is open: both are a column beside the conversation, and two of
            them at once leaves the conversation itself too narrow to read. */}
        {openThread && (
          <>
            <div className="divider-v" />
            <ThreadPanel />
          </>
        )}

        {!openThread && showNickList && (
          <>
            <div className="divider-v" />
            <div className="nicklist-pane">
              <NickList />
            </div>
          </>
        )}
      </div>

      {/* Over everything: an answer to something just asked. */}
      <ProfileCard />

      {/* Over everything, because a verification can now start somewhere
          else entirely - another of your sessions, or another person in a
          room you share - and a dialog only the account panel can show is a
          request nobody can answer. */}
      <VerificationDialog />

      {/* Over everything: a call arrives while you are looking elsewhere. */}
      <IncomingCallPanel />
      {/* A Matrix call rings here too, but is answered by this window rather
          than by the daemon - the media is the window's. */}
      <IncomingMatrixCall />
      <ScreenPicker />
      {/* A form a Discord bot asked for. Over everything, because it is the
          answer to something just pressed and it expires. */}
      <DiscordModal />
      {/* Where a call goes when you walk away from it: a corner of its own,
          the way a phone keeps the picture in the corner. In the conversation
          it belongs to it sits above the log instead - see MessageList - so
          the two are never both on screen. */}
      {callElsewhere && <CallStage mode="pip" />}
      {/* A stream keeps playing when you go and read something else, and goes
          to the same corner - it is the same surface, differently fed. */}
      {streamElsewhere && <StreamStage mode="pip" />}
      {/* Over everything for the same reason: a file is offered while you are
          reading something else, and often in a conversation you are not. */}
      <TransferPanel />
      <FileDrop />
      <Toasts />
    </div>
  )
}

/**
 * Sends this conversation to a window of its own, or raises the one it has.
 *
 * One window per conversation: two views of the same channel would each mark
 * it read and each have an opinion about where its window belongs, so asking
 * again for one that is already out brings it forward instead.
 */
function PopOutButton({ buffer }: { buffer: BufferEntry }): JSX.Element {
  const store = useStore()
  const popouts = useChat((s) => s.popouts)
  const out = popouts.open.includes(buffer.id)
  return (
    <IconButton
      name="open_in_new"
      title={out ? 'Show this conversation’s window' : 'Watch this in a window of its own'}
      className={out ? 'active' : undefined}
      onClick={() => store.popOut(buffer.id)}
    />
  )
}

function Body({
  activePanel,
  hasAccounts,
  hasBuffer,
  activeGroupId
}: {
  activePanel: string
  hasAccounts: boolean
  hasBuffer: boolean
  activeGroupId: string
}): JSX.Element {
  if (activePanel === 'settings') return <SettingsPanel />
  // Above the no-accounts case below: a finished download is still worth
  // looking at on a machine whose accounts have since been removed.
  if (activePanel === 'downloads') return <DownloadsPanel />
  // With no accounts at all, the accounts panel is the only useful thing to
  // show - there is nothing to chat in yet.
  if (activePanel === 'accounts' || !hasAccounts) return <AccountsPanel />
  if (activePanel === 'join') return <JoinPanel />
  // The mentions page replaces the log rather than sitting beside it: it is a
  // list of places to go, and every row leads into a conversation.
  if (activePanel === 'mentions') return <MentionsPage />
  // An invitation stands where the conversation would, because it is the
  // conversation being offered.
  if (activeGroupId.startsWith(INVITE_PREFIX)) return <InvitePanel groupId={activeGroupId} />
  if (hasBuffer) return <MessageList />
  return <Placeholder icon="forum" text="Select or join a channel" />
}

function Placeholder({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <div className="placeholder muted">
      <Icon name={icon} size={32} />
      <span>{text}</span>
    </div>
  )
}
