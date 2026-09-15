import type {
  Account,
  AudioDevice,
  Buffer as WireBuffer,
  BufferGroup,
  CustomEmoji,
  IncomingCall,
  DccTransfer,
  DiscordFriend,
  MatrixInvite,
  MatrixVerification,
  Member,
  Message,
  NobilisEvent,
  MessageReader,
  Profile,
  Reaction,
  RoomPermissions,
  SneedchatSmilie,
  VoiceChannel,
  VoicePrefs,
  VoiceSession
} from '../../../shared/wire'
import { buildSmilieIndex, type SmilieEntry, type SmilieIndex } from '../lib/format'
import { bufferDisplayName, isImageFile, resolveMediaUrl } from '../lib/util'
import { runExport } from '../lib/exporter'
import { DM_GROUP_ID, isDirectMessage } from '../lib/groups'
import { ircNetworkFor } from '../lib/networks'
import { parseDeepLink, type IrcLink } from '../../../shared/deeplink'
import { MatrixCalls, type CallMember, type MatrixCallEvent, type RingingCall } from '../lib/matrixcall'
import type { CallPhase } from '../lib/webrtc'
import { Levels } from '../lib/levels'
import type { PopoutState } from '../../../shared/ipc'

/**
 * The whole client-side model, held in one immutable object that is replaced
 * on every change. Components read slices of it through useSyncExternalStore,
 * so a selector that returns a field reference stays referentially stable
 * between unrelated updates and doesn't re-render on them.
 *
 * Event semantics here mirror the original QML frontend exactly; where a rule
 * is non-obvious the reason is noted at the handler.
 */

/** A wire Buffer plus the local-only counters nobilis doesn't track. */
export interface BufferEntry extends WireBuffer {
  unread: number
  highlight: boolean
  /**
   * Left unread on purpose, rather than merely not read yet.
   *
   * Separate from `unread` because it outlives the count: a room marked this
   * way stays marked after its messages have been seen, which is the whole
   * point - it is a note to come back, not a tally. Matrix only, since it is
   * the one service here with an account-level place to keep it, which is what
   * lets the mark follow somebody to their phone.
   */
  markedUnread?: boolean
}

/** A wire Message plus local optimistic-send bookkeeping. */
/** One person in a call, as the call view draws them. */
export interface CallTile {
  id: string
  label: string
  stream: MediaStream | null
  /** Whether there is a live picture, as opposed to a name and a microphone. */
  hasVideo: boolean
  /** This end, which is drawn silent and is the one that can be muted here. */
  self?: boolean
  muted?: boolean
  speaking?: boolean
}

export interface ChatMessage extends Message {
  /** Set on a locally-echoed message that nobilis hasn't confirmed yet. */
  pending?: boolean
  /** Set once the send definitively failed or timed out. */
  failed?: boolean
  errorText?: string
  /** The body as typed, kept so a retry can resend the original text. */
  pendingBody?: string
  pendingReplyTo?: string
  /** The staged file, kept for the same reason as the body. */
  pendingAttachment?: string
}

/**
 * Whether two hostnames are the same place to chat.
 *
 * Not string equality: a network is a pool of servers, and somebody connected
 * through `irc.eu.libera.chat` who clicks a link to `irc.libera.chat` is
 * already there. Falls back to comparing the names where neither is a network
 * this client knows, which is the best that can be said about a host nothing
 * has ever heard of.
 */
export function sameIrcNetwork(a: string, b: string): boolean {
  const left = a.toLowerCase().replace(/:\d+$/, '')
  const right = b.toLowerCase().replace(/:\d+$/, '')
  if (left === right) return true
  const na = ircNetworkFor(left)
  const nb = ircNetworkFor(right)
  return !!na && !!nb && na.id === nb.id
}

/** A thread, as it is being read: what was fetched, and whether it still is. */
export interface OpenThread {
  bufferId: string
  rootId: string
  messages: ChatMessage[]
  loading: boolean
}

/**
 * Buffer ids for rooms being joined, which exist only in this window.
 *
 * Prefixed rather than flagged so that anything walking the list can tell one
 * from a real buffer without being taught about joining at all - and so an id
 * can never collide with a daemon's, which are "account|name".
 */
const JOINING_PREFIX = 'joining:'

/** How long a stand-in waits for its room before admitting nothing came. */
const JOIN_GIVE_UP_MS = 30_000

export function isJoining(buffer: { id: string }): boolean {
  return buffer.id.startsWith(JOINING_PREFIX)
}

/** The channels in an account's autojoin string, however it was written. */
function autojoinList(autojoin: string | undefined): string[] {
  return (autojoin ?? '')
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean)
}

/** What a Kick channel is broadcasting, as the daemon last asked. */
/**
 * One option in a poll, or one outcome in a prediction.
 *
 * `votes` carries both: a poll counts people, a prediction counts points, and
 * the card draws the same bar either way.
 */
/**
 * The one message a channel has pinned above its chat.
 *
 * Kick only, for now. `id` is the pinned message's own, which is what a
 * dismissal is keyed on - putting this one away must not put the next one
 * away, and the next one is the whole reason a channel pins anything.
 */
export interface PinnedMessage {
  id: string
  from: string
  body: string
}

export interface LiveCardOption {
  /**
   * Whatever the service calls this answer.
   *
   * A number on a Kick poll, a ULID string on a Kick prediction - the card
   * only ever hands it back where it came from, so it is carried rather than
   * converted.
   */
  id: string | number
  label: string
  votes: number
  /** How many people are behind it, where the service counts that too. */
  backers?: number | null
  /** A prediction's payout, as the service words it: "1:2.8". */
  odds?: string | null
  winner?: boolean
}

/**
 * A poll or a prediction: one question, a set of answers, and a clock.
 *
 * Not named for any service. Kick is the first to send one, but Discord and
 * Matrix both have polls of their own, and the card that draws this is
 * whatever the protocol underneath it happens to be.
 *
 * `remaining` is the seconds left when the daemon heard about it, and
 * `receivedAt` is when that was - the card counts down from the pair rather
 * than asking every second.
 */
export interface LiveCard {
  bufferId: string
  kind: 'poll' | 'prediction'
  id: string
  title: string
  options: LiveCardOption[]
  duration: number
  remaining: number
  resultDisplayDuration: number
  hasVoted: boolean
  votedOptionId: string | number | null
  /** What this account has riding on it, in points. */
  stake?: number | null
  /** Points left to bet with, where the service says. */
  balance?: number | null
  /** The smallest bet the service will take. */
  minBet?: number | null
  /** A prediction's pot, in points. */
  total?: number | null
  /** What this account stands to get back, where the service says. */
  yourReturn?: number | null
  /** "open", "locked", "resolved" - whatever the service calls it. */
  state?: string | null
  /**
   * Whether it is still taking answers, where the service says so outright.
   *
   * Kick's polls run on a clock and this is absent; a Matrix poll runs until
   * somebody ends it, so the countdown would never start and the card would
   * open closed.
   */
  open?: boolean
  /**
   * When the daemon heard this, in unix seconds.
   *
   * The countdown reads from here rather than from when the event happened
   * to arrive: `remaining` was true at a moment, and a card replayed into a
   * window that opened later would otherwise appear to have its whole time
   * still left.
   */
  asOf?: number
  /** The same moment on the client's own clock, in milliseconds. */
  receivedAt: number
  /** When it happened, on history rows read back from storage. */
  ts?: number
  /**
   * The service has taken it down.
   *
   * The card stays anyway, showing how it went, until the reader folds it
   * away - a result nobody has looked at yet is worth more than the space it
   * occupies, and one that vanishes the instant it closes is one you never
   * saw the answer to.
   */
  closed?: boolean
}

/**
 * When a card was true, on this machine's clock.
 *
 * The daemon stamps every card with the second it heard it, so a card that
 * has been sitting in the daemon - replayed into a window opening now, or
 * read back out of storage - counts down from when it happened rather than
 * from when it arrived here. Falls back to now for anything unstamped, which
 * is the old behaviour and the best guess available.
 */
export function cardHeardAt(card: LiveCard): number {
  return card.asOf ? card.asOf * 1000 : Date.now()
}

/** Where a card lives in state: one poll and one prediction per channel. */
export function cardSlot(bufferId: string, kind: string): string {
  return `${bufferId}|${kind}`
}

export interface KickStream {
  bufferId: string
  live: boolean
  title?: string | null
  category?: string | null
  viewers?: number | null
  /** Unix seconds the stream started, for "live for 2h 14m". */
  startedTs?: number | null
  followers?: number | null
  /**
   * Whether this account follows the channel, or absent when it cannot say -
   * a Kick account that is not signed in reads chat and knows nothing about
   * follows, and a button offering to follow there would fail when pressed.
   */
  following?: boolean | null
  /**
   * Where the video is: a signed Amazon IVS playlist, good for watching in
   * this window rather than in a browser tab beside it.
   *
   * Replaced on every refresh, because the signature in it expires - so
   * whoever is playing it reads the current one rather than the one they
   * started with.
   */
  playbackUrl?: string | null
}

/** One box on a form a Discord bot sent. */
export interface DiscordModalField {
  customId: string
  label: string
  /** Several lines rather than one - Discord's "paragraph" style. */
  long: boolean
  placeholder?: string
  value?: string
  required?: boolean
  minLength?: number | null
  maxLength?: number | null
}

export interface DiscordModal {
  accountId: string
  bufferId: string
  id?: string
  customId: string
  applicationId?: string
  title: string
  fields: DiscordModalField[]
}

export type ActivePanel = '' | 'accounts' | 'settings' | 'join' | 'downloads' | 'mentions'

export interface ChatState {
  /** Who is composing, per buffer, with when to stop believing it. */
  typingByBuffer: Record<string, { nicks: string[]; until: number }>
  /**
   * Who has read up to which message, per buffer.
   *
   * Keyed by message id because that is where the marker is drawn, and a
   * person appears under exactly one of them - the whole set for a room
   * arrives at once and replaces what was there, so somebody moving forward
   * cannot leave a copy of themselves behind on an older message.
   */
  readersByBuffer: Record<string, Record<string, MessageReader[]>>
  /**
   * The thread being read, if any.
   *
   * One at a time, and held here rather than in the panel's own state so that
   * opening a thread from a message survives the panel being closed and
   * reopened, and so the composer can send into it.
   */
  openThread: OpenThread | null
  linkUp: boolean
  accounts: Account[]
  buffers: BufferEntry[]
  /** Rail entries - guilds, spaces, DM collections and account entries. */
  groups: BufferGroup[]
  /** Which rail entry the channel pane is showing. */
  activeGroupId: string
  /**
   * Why an account is in the state it is, per account.
   *
   * The daemon reports this on every reconnection cycle - what failed and how
   * long until the next attempt - and it used to be dropped on the floor,
   * which is why an account could sit at "connecting" for five minutes with
   * nothing to read.
   */
  connectionDetail: Record<string, string>
  /** Sound devices and whether voice is silenced, as the daemon sees them. */
  voicePrefs: VoicePrefs
  audioDevices: AudioDevice[]
  /** The selected guild's voice channels, and who is in each. */
  voiceChannels: VoiceChannel[]
  /** Which guild `voiceChannels` describes, so a stale update is ignorable. */
  voiceGuildId: string
  /** Live voice connections, so the pane can show what you are in. */
  voiceSessions: VoiceSession[]
  /** Conversations ringing right now, newest last. */
  incomingCalls: IncomingCall[]
  /**
   * A link waiting for an account to be made for it.
   *
   * Set only where following one could not be finished: there is no account
   * on that network yet, so the accounts page opens with what the link
   * already knew filled in. Cleared once that form has been through.
   */
  pendingLink: IrcLink | null
  /**
   * Who the next message is being whispered to, if anybody.
   *
   * Beside `replyingTo` and behaving like it, because from where somebody is
   * sitting these are the same kind of thing: a target the composer is aimed
   * at until they change their mind.
   */
  whisperingTo: string | null
  /** Files offered over IRC, newest first, offers and transfers together. */
  transfers: DccTransfer[]
  /**
   * Transfers put out of the way, by id.
   *
   * Only about the floating card - a minimised transfer is still running and
   * still listed under Downloads. Kept in the store rather than in the panel
   * so it survives the panel unmounting when the last card goes away.
   */
  minimisedTransfers: string[]
  /**
   * Everything that has mentioned you, newest first, across every service.
   *
   * Held here rather than fetched by the inbox when it opens, because the
   * button carries a count and a count that only becomes true once looked at
   * is no use. Seeded from the daemon - the point of an inbox is the mention
   * in a channel nobody opened, which this client has never seen - and kept
   * current from the live stream afterwards.
   */
  mentions: Message[]
  /**
   * When each buffer was last read, in seconds.
   *
   * Mirrored into state as well as onto disk because the store writes this
   * one through to main directly rather than through the preference hook, so
   * nothing in the renderer's preference cache ever learns it changed. A
   * component reading it from there would have shown whatever was on disk at
   * startup and never moved - which for the mentions inbox meant a mention
   * staying unread after its channel had been opened and read.
   */
  lastReadTs: Record<string, number>
  /**
   * A message the view should scroll to once it has rendered.
   *
   * Held here rather than scrolled to directly, because the log decides its
   * own scroll position - it pins itself to the bottom while you are reading
   * there, and a jump has to turn that off rather than fight it. Cleared by
   * the log once it has done so.
   */
  jumpTarget: string
  activeBufferId: string
  /**
   * Conversations open in a window of their own.
   *
   * `open` is every one of them; `watched` is those whose window is on screen,
   * which is the set that needs no unread badge here because somebody is
   * already looking at it somewhere else.
   */
  popouts: PopoutState
  /** Set in a popped-out window, naming the one conversation it may show. */
  pinnedBufferId: string
  activePanel: ActivePanel
  joinPanelAccountId: string
  messagesByBuffer: Record<string, ChatMessage[]>
  presenceByBuffer: Record<string, Member[]>
  /** Buffers whose initial backlog fetch has completed. */
  loadedBuffers: Record<string, true>
  loadingMore: Record<string, true>
  /** Reading forward, towards the present, from somewhere jumped to. */
  loadingNewer: Record<string, true>
  /**
   * Where a conversation is missing its middle, as the id of the last message
   * before the hole.
   *
   * Set by arriving somewhere directly - a pinned message, a search result -
   * which puts one moment of a conversation on screen above a present that
   * belongs to a different week. Without it a reader scrolling down out of
   * that moment steps over the gap without being told there was one.
   */
  historyGapAfter: Record<string, string>
  /** Per-buffer "New messages" divider timestamp, snapshotted on open. */
  dividerTsByBuffer: Record<string, number>
  matrixPermissions: Record<string, RoomPermissions>
  /**
   * What each Kick channel is broadcasting, by buffer.
   *
   * A Kick channel is a stream as much as a chat, and moho showed only the
   * chat - so the title, the game and the number of people watching, which is
   * most of what a viewer wants to know, were nowhere.
   */
  kickStreams: Record<string, KickStream>
  /** The poll and prediction running in each channel, by `cardSlot`. */
  livePolls: Record<string, LiveCard>
  /**
   * What each Kick channel has pinned above its chat, by buffer.
   *
   * Standing state rather than a stream of events: a channel has one pin at a
   * time and it stays until it is replaced, so this is the current answer
   * rather than a log of answers.
   */
  pinnedByBuffer: Record<string, PinnedMessage>
  /** Cards the reader has folded away, by card id. */
  /** An old poll or prediction being read back, over the conversation. */
  reviewCard: LiveCard | null
  /** Which messages each Matrix room has pinned, newest last. */
  /** Which messages a conversation has pinned, where the service says so. */
  pinnedMessages: Record<string, string[]>
  /** Friends and pending requests per Discord account, as they change. */
  discordFriends: Record<string, DiscordFriend[]>
  /**
   * A Matrix call: the one ringing, and the one that is up.
   *
   * Held here rather than in a component because a call outlives whatever is
   * on screen - navigating away from the conversation does not end it, and
   * the panel that shows it has to be able to find it again.
   */
  ringingCall: RingingCall | null
  /** The call put away without being hung up. */
  callMinimized: boolean
  /**
   * Who is in each room's call, by buffer.
   *
   * A group call has no invitation - it is a piece of room state saying
   * people are in one - so this is how a room offers a call to join.
   */
  callMembers: Record<string, CallMember[]>
  /**
   * The Kick stream being watched, if any.
   *
   * Beside the call rather than inside it: they draw into the same surface
   * and only one of them can have it, but a stream is a broadcast being
   * received and a call is a conversation being held, and the daemon knows
   * nothing about this one - it is a URL and a video element.
   */
  watching: { bufferId: string; accountId: string; title: string } | null
  /** The stream put away without being stopped. */
  watchMinimized: boolean
  /**
   * A form a Discord bot asked for, while it is being filled in.
   *
   * One at a time: a modal is the answer to something just pressed, and a
   * second arriving while one is open is a bot talking over itself.
   */
  discordModal: DiscordModal | null
  /** The screens and windows on offer, while somebody is choosing one. */
  screenSources: { id: string; name: string; thumbnail: string }[] | null
  activeCall: {
    accountId: string
    bufferId: string
    phase: CallPhase
    /** Whether this end offered a camera. */
    video: boolean
    muted: boolean
    sharingScreen: boolean
  } | null
  /** Who each Matrix account has asked never to hear from. */
  ignoredByAccount: Record<string, string[]>
  /** Rooms each Matrix account has been invited to and not answered. */
  matrixInvites: Record<string, MatrixInvite[]>
  /**
   * The profile being shown, or null.
   *
   * One at a time, and held here rather than in the card: the answer arrives
   * from the daemon as an event some time after the question was asked, so
   * whatever draws it cannot be the thing that asked.
   */
  profile: Profile | null
  replyingTo: { id: string; from: string; body: string } | null
  toasts: Toast[]

  /** Sneedchat's site-wide smiley table, fetched once and memoised. */
  smilies: SmilieEntry[]
  smilieIndex: SmilieIndex | null
  /** Per-buffer Discord guild emoji, fetched lazily per buffer. */
  bufferEmoji: Record<string, CustomEmoji[]>
  /** The one in-flight Matrix verification, if any (nobilis allows one per account). */
  matrixVerification: MatrixVerification | null

  // Login flows
  discordQrPath: string
  discordLoginStatus: string
  /** Set when a Discord password login stops at the two-factor step. */
  discordMfa: { loginId: string; totp: boolean; sms: boolean; backup: boolean } | null
  /** The account being re-authenticated, or '' for a brand-new one. */
  discordReauthAccountId: string
  sneedChatLoginStatus: string
  matrixLoginStatus: string
}

export interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

const INITIAL: ChatState = {
  linkUp: false,
  accounts: [],
  buffers: [],
  groups: [],
  activeGroupId: '',
  connectionDetail: {},
  voicePrefs: { micMuted: false, deafened: false },
  audioDevices: [],
  voiceChannels: [],
  voiceGuildId: '',
  voiceSessions: [],
  incomingCalls: [],
  transfers: [],
  minimisedTransfers: [],
  pendingLink: null,
  whisperingTo: null,
  mentions: [],
  lastReadTs: {},
  jumpTarget: '',
  activeBufferId: '',
  popouts: { open: [], watched: [] },
  pinnedBufferId: '',
  activePanel: '',
  joinPanelAccountId: '',
  messagesByBuffer: {},
  presenceByBuffer: {},
  loadedBuffers: {},
  loadingMore: {},
  loadingNewer: {},
  historyGapAfter: {},
  dividerTsByBuffer: {},
    typingByBuffer: {},
  readersByBuffer: {},
  openThread: null,
  matrixPermissions: {},
  kickStreams: {},
  livePolls: {},
  pinnedByBuffer: {},
  reviewCard: null,
  pinnedMessages: {},
  discordFriends: {},
  ringingCall: null,
  callMinimized: false,
  callMembers: {},
  watching: null,
  watchMinimized: false,
  screenSources: null,
  discordModal: null,
  activeCall: null,
  ignoredByAccount: {},
  matrixInvites: {},
  profile: null,
  replyingTo: null,
  toasts: [],
  smilies: [],
  smilieIndex: null,
  bufferEmoji: {},
  matrixVerification: null,
  discordQrPath: '',
  discordLoginStatus: '',
  discordMfa: null,
  discordReauthAccountId: '',
  sneedChatLoginStatus: '',
  matrixLoginStatus: ''
}

/**
 * A call whose failure is not worth reporting and not worth retrying here.
 *
 * Subscribing is the case this exists for: it is re-issued for every buffer
 * each time the buffer list loads, so one that fails because the daemon link
 * is momentarily down repairs itself on reconnect. Left as a bare `void` these
 * became unhandled rejections - one per buffer, on every buffer list load and
 * every channel opened - which fills the console and buries real errors. A
 * toast each would be worse still, since a dropped link fails all of them at
 * once.
 */
/**
 * Whether a message that arrived is the one we just sent.
 *
 * Normally the bodies are identical. A reply on a service with no reply field
 * is the exception: Sneedchat answers somebody by opening the message with an
 * "@Name," mention, which the daemon adds on the way out, so what comes back
 * is longer than what was typed. Matching those strictly left the sent message
 * showing as failed while its own echo appeared beside it as a new message.
 *
 * The looser match is deliberately narrow - only for a message that was sent
 * as a reply, and only when the arriving body ends with exactly what was
 * typed - so an unrelated message that happens to share a suffix cannot
 * swallow somebody's pending send.
 */
function echoMatches(echo: ChatMessage, real: Message): boolean {
  if (echo.pendingBody === real.body) return true
  // A file is posted as markup the daemon builds - a BBCode image tag on
  // Sneedchat, a bare link on IRC - so what comes back is never what was
  // typed, and usually nothing was typed at all. Matching on the whole body
  // could not succeed, so every upload sat pending until it was swept up as
  // having timed out: reported as a failure while the picture was on screen
  // in the same conversation.
  //
  // A caption is still checked where there was one, since it survives into
  // what was posted; without one, the next message back from us in that
  // conversation is it.
  if (echo.pendingAttachment) {
    return !echo.pendingBody || real.body.includes(echo.pendingBody)
  }
  return !!echo.pendingReplyTo && !!echo.pendingBody && real.body.endsWith(echo.pendingBody)
}

/**
 * Trims a failure report down to the part that explains anything.
 *
 * These arrive with the full request URL in them, and a Matrix sync URL
 * carries a sync token longer than the rest of the message combined - which
 * matters because the actual reason and the retry countdown are at the *end*,
 * so a line truncated to fit shows nothing but an opaque token.
 */
function tidyDetail(detail: string): string {
  return detail.replace(/(https?:\/\/[^\s)]+?)\?[^\s)]*/g, '$1')
}

/** The upload host the person chose, or the default if they never did. */
/**
 * Every host the daemon offers, fetched once.
 *
 * Cached because it is asked on every send with an attachment and cannot
 * change while the daemon is up - the list is compiled into it.
 */
let hostListing: Promise<{ id: string; accepts: string[] | null }[]> | null = null

async function uploadHosts(): Promise<{ id: string; accepts: string[] | null }[]> {
  if (!hostListing) {
    hostListing = window.moho
      .rpc<{ id: string; accepts: string[] | null }[]>('listUploadHosts')
      // An older daemon says nothing about what a host takes; assume it
      // takes whatever it is given, which is what happened before this.
      .catch(() => [])
  }
  return hostListing
}

/** Whether this host will take this file, by the daemon's own account. */
async function hostAccepts(hostId: string, path: string): Promise<boolean> {
  const host = (await uploadHosts()).find((h) => h.id === hostId)
  if (!host || !host.accepts) return true
  const ext = (path.split(/[\\/]/).pop() || '').split('.').pop()?.toLowerCase() ?? ''
  return host.accepts.includes(ext)
}

/**
 * Where this file should go, for this service.
 *
 * Chosen by service and by whether the file is a picture, because the answer
 * differs on both counts: postimg.cc is the convention on Sneedchat and
 * meaningless on IRC, and it takes images and nothing else. Read at send
 * time, since it is a preference somebody may change between one message and
 * the next.
 *
 * A host that will not take this particular file is routed around rather
 * than allowed to refuse it - postimg does not accept avif, which is an
 * image by any ordinary reading. It goes to the host already chosen for
 * everything else, not to one invented here: that is a decision somebody
 * made, and a file should not turn up at a third party they never named.
 *
 * The old single setting is the fallback for anyone who chose a host before
 * this was split in two.
 */
async function uploadHost(service: string | undefined, attachmentPath: string): Promise<string> {
  const kind = isImageFile(attachmentPath) ? 'images' : 'media'
  const perService = service === 'sneedchat' ? 'sneedchat' : 'irc'
  try {
    const prefs = await window.moho.prefs.getAll()
    const legacy = prefs['uploads.host'] as string | undefined
    // postimg takes images and nothing else, so a stored choice of it is
    // carried forward for pictures and not for anything else.
    const legacyUsable = legacy === 'postimg' ? kind === 'images' : !!legacy
    const fallback = kind === 'images' && perService === 'sneedchat' ? 'postimg' : 'catbox'
    const chosen =
      (prefs[`uploads.${perService}.${kind}`] as string | undefined) ||
      (legacyUsable ? legacy : undefined) ||
      fallback

    if (await hostAccepts(chosen, attachmentPath)) return chosen

    const other = prefs[`uploads.${perService}.media`] as string | undefined
    if (other && other !== chosen && (await hostAccepts(other, attachmentPath))) return other
    return 'catbox'
  } catch {
    return 'catbox'
  }
}

/**
 * This account's own reaction added to or taken off a tally.
 *
 * Only ever moves our own vote: the count follows because we are one of the
 * reactors, and everyone else's stays where it is. A tally that reaches zero
 * disappears, the same as it does when the service reports it, so an
 * optimistic row and a real one look alike.
 */
function applyOwnReaction(list: Reaction[], emoji: string, add: boolean): Reaction[] {
  const existing = list.find((r) => r.emoji === emoji)
  if (!existing) {
    return add ? [...list, { emoji, count: 1, me: true }] : list
  }
  // Already in the state being asked for - the service will say the same.
  if (existing.me === add) return list
  const count = Math.max(0, existing.count + (add ? 1 : -1))
  if (count === 0) return list.filter((r) => r.emoji !== emoji)
  return list.map((r) => (r.emoji === emoji ? { ...r, count, me: add } : r))
}

/**
 * Whether this conversation's service can be asked for one message directly.
 *
 * Discord and Matrix both will (`?around=`, `/context`); IRC, Kick and
 * Sneedchat have no such thing, so reaching a message there is still a walk
 * backwards through what they do offer.
 */
function canFetchAround(bufferId: string): boolean {
  return bufferId.startsWith('discord:') || bufferId.startsWith('matrix:')
}

function bestEffort(work: Promise<unknown>, what: string): void {
  void work.catch((e: Error) => console.debug(`[moho] ${what}:`, e.message))
}

/**
 * Scrollback kept in memory per buffer. Older messages stay in nobilis's SQLite
 * store and come back through getBacklog when the user scrolls up, so this cap
 * bounds memory without losing history.
 */
const MAX_MESSAGES_PER_BUFFER = 500
/**
 * How much a buffer may grow to when history has been deliberately loaded.
 *
 * The cap above is what a conversation settles at; this is the ceiling a live
 * message is allowed to trim it back to. They differ because of what trimming
 * does after a jump: reaching a pinned message puts fifty old rows at the top
 * of the list, and in a busy room the very next message would have thrown them
 * straight back out - so the reader arrives somewhere and is moved off it by
 * the first person to speak.
 */
const MAX_MESSAGES_AFTER_LOADING = 2000
/**
 * What a conversation keeps once somebody is reading a different one.
 *
 * A window subscribed to four hundred buffers was holding every one of them at
 * the ceiling above, which is a ceiling meant for the conversation on screen -
 * so an evening of traffic became a few hundred thousand messages that nothing
 * was drawing and nothing would release. This is the tail a buffer is cut back
 * to when it stops being the one in view: enough to fill the screen the moment
 * it is opened again, with everything behind it read back out of the daemon's
 * store by the same paging that already serves scrolling upwards.
 */
const MAX_MESSAGES_IDLE = 200
/** As many mentions as the inbox will hold; the daemon's own limit matches. */
const MAX_MENTIONS = 100
const BACKLOG_PAGE = 200
const SEND_TIMEOUT_MS = 10000

export class ChatStore {
  private state: ChatState = INITIAL
  private listeners = new Set<() => void>()
  private sendSeq = 0
  /** clientId -> the optimistic message awaiting its real echo. */
  private pendingSends = new Map<string, { bufferId: string; ts: number }>()
  private toastSeq = 0
  /** Who is talking in a call this window is holding. */
  private levels = new Levels()
  /**
   * The Matrix call engine, one per window.
   *
   * Built here rather than per component so a call survives the panel that
   * started it: walking away from a conversation does not hang up, and the
   * bar that follows a call around has to find the same call.
   */
  private matrixCalls = new MatrixCalls({
    send: (bufferId, type, content) => {
      void window.moho
        .rpc('sendMatrixCallEvent', { bufferId, type, content })
        .catch((e: Error) => this.toast('error', `Call signalling failed: ${e.message}`))
    },
    iceServers: async (accountId) => {
      try {
        const answer = await window.moho.rpc<{ uris?: string[]; username?: string; password?: string }>(
          'matrixTurnServers',
          { accountId }
        )
        const uris = answer.uris ?? []
        if (uris.length === 0) return []
        // One entry carrying every uri, which is how a browser wants them:
        // the credentials are the same for all of a homeserver's relays.
        return [{ urls: uris, username: answer.username, credential: answer.password }]
      } catch {
        // No relay is a working configuration for two people on the same
        // network, and a call worth trying is better than a refusal.
        return []
      }
    },
    // A group call is joined rather than answered, so this end says it is in
    // the room's call and reads back who else is - see matrixcall.ts.
    joinMembership: async (bufferId) => {
      try {
        return await window.moho.rpc<{ userId: string; deviceId: string }>('setMatrixCallMembership', {
          bufferId,
          joined: true
        })
      } catch (e) {
        this.toast('error', `Couldn't join the call: ${(e as Error).message}`)
        return null
      }
    },
    leaveMembership: async (bufferId) => {
      await window.moho.rpc('setMatrixCallMembership', { bufferId, joined: false }).catch(() => {})
    },
    // The daemon holds the encryption, so it is what hands a media key to the
    // devices in the call - one Olm-encrypted event each, the way Element
    // does it.
    sendCallKey: async (bufferId, key, index) => {
      await window.moho.rpc('sendMatrixCallKey', { bufferId, key, index }).catch((e: Error) => {
        this.toast('error', `Couldn't share the call key: ${e.message}`)
      })
    },
    callMembers: async (bufferId) =>
      window.moho.rpc<CallMember[]>('listMatrixCallMembers', { bufferId }).catch(() => []),
    onRinging: (call) => this.set({ ringingCall: call }),
    onPhase: (phase, call) => {
      // A group call reports with no `call` of its own, because it is not one
      // connection but several - the room is the call. Its phase moves the
      // same state the one-to-one path does, and only leaving clears it.
      const group = this.matrixCalls.currentGroup
      if (group && phase !== 'ended') {
        this.set({
          activeCall: {
            accountId: group.accountId,
            bufferId: group.bufferId,
            phase,
            video: group.video,
            muted: this.state.activeCall?.muted ?? false,
            sharingScreen: false
          }
        })
        return
      }
      if (!call || phase === 'ended') {
        this.set({ activeCall: null })
        return
      }
      this.set({
        callMinimized: this.state.activeCall ? this.state.callMinimized : false,
        activeCall: {
          accountId: call.accountId,
          bufferId: call.bufferId,
          phase,
          video: call.video,
          muted: this.state.activeCall?.muted ?? false,
          sharingScreen: call.call.sharingScreen
        }
      })
    },
    onError: (message) => this.toast('error', message)
  })
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private mentionsTimer: ReturnType<typeof setTimeout> | null = null

  getSnapshot = (): ChatState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // --- lifecycle ------------------------------------------------------

  /**
   * Pins this window to one conversation, for a popped-out window.
   *
   * Everything a conversation needs already reads the open buffer, so a popout
   * is not a second implementation of the log and the composer - it is this
   * store with the open buffer nailed down. What that nail has to stop is the
   * handful of things that would otherwise move it: a notification click, a
   * link from somewhere else on the machine, a jump from a search result in
   * another window.
   */
  pinTo(bufferId: string): void {
    this.set({ pinnedBufferId: bufferId, activeBufferId: bufferId })
  }

  /**
   * Opens a conversation in a window of its own, or raises the one it has.
   *
   * The name goes with it only so the window has something to be called before
   * its renderer has loaded and found the conversation for itself.
   */
  popOut(bufferId: string): void {
    const buffer = this.state.buffers.find((b) => b.id === bufferId)
    void window.moho.popout.open(bufferId, buffer ? bufferDisplayName(buffer.name) : undefined)
  }

  /** Puts a popped-out conversation back, optionally opening it here. */
  dock(bufferId: string, andShow = false): void {
    void window.moho.popout.close(bufferId, andShow)
  }

  async init(initialBufferId: string, initialGroupId = ''): Promise<void> {
    this.set({ activeBufferId: initialBufferId, activeGroupId: initialGroupId })

    void window.moho.popout.list().then((popouts) => this.set({ popouts }))
    window.moho.popout.onChange((popouts) => this.set({ popouts }))

    const stored = await window.moho.prefs.getAll()
    this.set({ lastReadTs: (stored.lastReadTs as Record<string, number>) ?? {} })

    window.moho.onLinkChange((up) => {
      this.set({ linkUp: up })
      if (up) void this.refreshAll()
    })
    window.moho.onEvent((frame) => this.handleEvent(frame))
    // Both of these arrive from outside and mean "go and look at this", which
    // a window pinned to one conversation has no way to honour. The main
    // window gets them instead; main routes them there.
    if (!this.state.pinnedBufferId) {
      window.moho.onActivateBuffer((id) => void this.selectBuffer(id))
      window.moho.onDeepLink((url) => this.followDeepLink(url))
    }

    this.sweepTimer = setInterval(() => this.sweepPendingSends(), 2000)

    // The link may already be up before this renderer finished loading (main
    // connects at startup), in which case no 'link' event is coming.
    const status = await window.moho.daemonStatus()
    this.set({ linkUp: status.linkUp })
    if (status.linkUp) await this.refreshAll()
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.mentionsTimer) clearTimeout(this.mentionsTimer)
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([
      this.refreshAccounts(),
      this.refreshBuffers(),
      this.refreshGroups(),
      this.refreshVoicePrefs(),
      // A call outlives this window: the daemon holds it, so a reconnecting
      // or restarted client has to pick the connection back up rather than
      // showing nothing while audio is still flowing.
      this.refreshVoiceSessions(),
      this.refreshIncomingCalls()
    ])
    if (this.state.activeBufferId) await this.selectBuffer(this.state.activeBufferId)
  }

  /**
   * The mentions that arrived before this client did.
   *
   * A failure here is silent rather than a toast: an empty inbox is a mild
   * disappointment, and interrupting someone to say so - on every reconnect,
   * which is when this runs - would be worse than the missing list.
   */
  async refreshMentions(): Promise<void> {
    try {
      this.set({ mentions: await window.moho.rpc<Message[]>('getMentions', { limit: MAX_MENTIONS }) })
    } catch {
      // Leave whatever is already there; a reconnect should not empty it.
    }
  }

  async dismissMention(msgId: string): Promise<void> {
    try {
      await window.moho.rpc('dismissMention', { msgId })
      this.set({ mentions: this.state.mentions.filter((m) => m.id !== msgId) })
    } catch (e) {
      this.toast('error', `Couldn't dismiss mention: ${(e as Error).message}`)
    }
  }

  async dismissAllMentions(): Promise<void> {
    const ids = this.state.mentions.map((m) => m.id)
    this.set({ mentions: [] })
    for (const msgId of ids) {
      void window.moho.rpc('dismissMention', { msgId }).catch(() => {})
    }
  }

  async refreshAccounts(): Promise<void> {
    try {
      this.set({ accounts: await window.moho.rpc<Account[]>('listAccounts') })
      void this.refreshInvites()
    } catch (e) {
      this.toast('error', `Couldn't list accounts: ${(e as Error).message}`)
    }
  }

  /**
   * What each Matrix account has been invited to.
   *
   * Read when the accounts are, rather than only when some panel that shows
   * invitations happens to be opened: an invitation nobody has seen is an
   * invitation nobody can answer, and it was previously only fetched inside
   * the join panel.
   */
  async refreshInvites(): Promise<void> {
    for (const account of this.state.accounts.filter((a) => a.service === 'matrix')) {
      try {
        const invites = await window.moho.rpc<MatrixInvite[]>('listMatrixInvites', {
          accountId: account.id
        })
        this.set({ matrixInvites: { ...this.state.matrixInvites, [account.id]: invites } })
      } catch {
        // An older daemon has no such method, and no invites to show.
      }
    }
  }

  /** Accepts an invitation, or turns it down. */
  answerMatrixInvite(accountId: string, roomId: string, accept: boolean): void {
    void window.moho
      .rpc(accept ? 'acceptMatrixInvite' : 'declineMatrixInvite', { accountId, roomId })
      // Not removed here: the next sync stops listing it, which is what
      // actually confirms the server agreed.
      .catch((e: Error) => this.toast('error', e.message))
  }

  /**
   * The rail. Kept in nobilis's order (its own `position`, then name), which
   * for Discord is the order the user arranged their servers in.
   */
  async refreshGroups(): Promise<void> {
    try {
      const groups = await window.moho.rpc<BufferGroup[]>('listBufferGroups')
      this.set({ groups })
      // A session saved before direct messages were folded into one page may
      // still name a per-account DM group, which no longer has a tile. Point
      // it at the page that replaced it rather than letting the pane fall back
      // to whatever entry happens to be first.
      const active = groups.find((g) => g.id === this.state.activeGroupId)
      if (active?.kind === 'dms') this.selectGroup(DM_GROUP_ID)
      // Land somewhere sensible on first run rather than an empty pane.
      if (!this.state.activeGroupId && groups.length) {
        this.set({ activeGroupId: this.groupOfActiveBuffer() || groups[0].id })
      }
    } catch (e) {
      this.toast('error', `Couldn't list servers: ${(e as Error).message}`)
    }
  }

  /** Keeps the rail selection on whatever buffer is already open. */
  private groupOfActiveBuffer(): string {
    const active = this.state.buffers.find((b) => b.id === this.state.activeBufferId)
    return active?.groupId || ''
  }

  /**
   * A guild arriving, or one re-registering once its icon finished
   * downloading. Replaced by id rather than appended, then re-sorted so a
   * late arrival lands in the right place instead of at the end.
   */
  /**
   * Takes a rail entry away, after leaving what it stood for.
   *
   * Also moves off it if it was the one being read: the pane below would
   * otherwise be showing the channels of somewhere that no longer exists.
   */
  private removeGroup(groupId: string): void {
    const groups = this.state.groups.filter((g) => g.id !== groupId)
    this.set({ groups })
    if (this.state.activeGroupId === groupId) {
      this.set({ activeGroupId: groups[0]?.id ?? '', activeBufferId: '' })
    }
  }

  private upsertGroup(group: BufferGroup): void {
    const rest = this.state.groups.filter((g) => g.id !== group.id)
    const groups = [...rest, group].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name)
    )
    this.set({ groups })
    if (!this.state.activeGroupId) this.set({ activeGroupId: groups[0].id })
  }

  /**
   * Sets how an account presents itself.
   *
   * Refreshes the account list rather than patching state locally: nobilis
   * reports whether it could actually apply the status, and for a
   * disconnected account or a protocol with no presence concept the answer is
   * no - showing it as set anyway would be a lie.
   */
  /**
   * The microphone and speaker state, which the daemon owns.
   *
   * Read back rather than assumed: a mute survives a restart, so the button
   * has to show what is actually in force rather than what this window last
   * set.
   */
  async refreshVoicePrefs(): Promise<void> {
    try {
      this.set({ voicePrefs: await window.moho.rpc<VoicePrefs>('getVoicePrefs') })
    } catch {
      // Voice is optional; a daemon that cannot answer just means no controls.
    }
  }

  async refreshAudioDevices(): Promise<void> {
    try {
      this.set({ audioDevices: await window.moho.rpc<AudioDevice[]>('listAudioDevices') })
    } catch (e) {
      this.toast('error', `Couldn't list sound devices: ${(e as Error).message}`)
    }
  }

  async setVoiceMuted(next: { micMuted?: boolean; deafened?: boolean }): Promise<void> {
    // Applied optimistically: a mute button that waits for a round trip feels
    // broken, and the daemon's reply corrects it either way.
    this.set({ voicePrefs: { ...this.state.voicePrefs, ...next } })
    try {
      this.set({ voicePrefs: await window.moho.rpc<VoicePrefs>('setVoiceMuted', next) })
    } catch (e) {
      this.toast('error', `Couldn't change audio: ${(e as Error).message}`)
      await this.refreshVoicePrefs()
    }
  }

  async setVoiceDevice(kind: 'input' | 'output', deviceId: string): Promise<void> {
    try {
      this.set({ voicePrefs: await window.moho.rpc<VoicePrefs>('setVoiceDevice', { kind, deviceId }) })
    } catch (e) {
      this.toast('error', `Couldn't select that device: ${(e as Error).message}`)
    }
  }

  /**
   * The voice channels of whichever guild is on screen.
   *
   * Fetched per guild rather than kept for all of them: membership changes
   * constantly across every server someone is in, and only the one being
   * looked at is worth tracking.
   */
  async refreshVoiceChannels(accountId: string, guildId: string): Promise<void> {
    try {
      const channels = await window.moho.rpc<VoiceChannel[]>('listVoiceChannels', { accountId, guildId })
      this.set({ voiceChannels: channels, voiceGuildId: guildId })
    } catch {
      // Only Discord has these; anything else legitimately has none.
      this.set({ voiceChannels: [], voiceGuildId: guildId })
    }
  }

  async refreshVoiceSessions(): Promise<void> {
    try {
      this.set({ voiceSessions: await window.moho.rpc<VoiceSession[]>('getVoiceSession') })
    } catch {
      this.set({ voiceSessions: [] })
    }
  }

  /**
   * What is ringing, asked for at startup.
   *
   * The daemon holds the connection while this window is shut, so a call can
   * begin ringing before there is anything to show it - opening the window
   * mid-call would otherwise be silent while the caller waits.
   */
  async refreshIncomingCalls(): Promise<void> {
    try {
      this.set({ incomingCalls: await window.moho.rpc<IncomingCall[]>('getIncomingCalls') })
      // A window opened while a transfer is already running should show it,
      // not start from empty and only notice the next one.
      this.set({ transfers: await window.moho.rpc<DccTransfer[]>('listTransfers') })
    } catch {
      // An older daemon has no such method; no calls is the honest answer.
      this.set({ incomingCalls: [] })
    }
  }

  /**
   * Leaves a guild or space for real.
   *
   * The daemon takes the rail entry away once the server has agreed, so
   * nothing is removed here on optimism - leaving is the one action where
   * showing it as done before it is would be worse than a moment's delay.
   */
  async leaveGroup(groupId: string): Promise<void> {
    try {
      await window.moho.rpc('leaveGroup', { groupId })
    } catch (e) {
      this.toast('error', `Couldn't leave: ${(e as Error).message}`)
    }
  }

  /** Asks the log to scroll to a message, and to stop following the tail. */
  setJumpTarget(messageId: string): void {
    this.set({ jumpTarget: messageId })
  }

  private setRinging(call: IncomingCall): void {
    const others = this.state.incomingCalls.filter((c) => c.bufferId !== call.bufferId)
    this.set({ incomingCalls: call.ringing ? [...others, call] : others })
  }

  /** Answers a ringing call, and opens the conversation it is in. */
  async acceptCall(bufferId: string): Promise<void> {
    // Optimistic: the ringing stops the instant it is answered, rather than a
    // round trip later with the ringtone still going.
    this.setRinging({ ...this.callFor(bufferId), ringing: false })
    try {
      await window.moho.rpc('acceptCall', { bufferId })
      await this.selectBuffer(bufferId, true)
      await this.refreshVoiceSessions()
    } catch (e) {
      this.toast('error', `Couldn't answer: ${(e as Error).message}`)
    }
  }

  async declineCall(bufferId: string): Promise<void> {
    this.setRinging({ ...this.callFor(bufferId), ringing: false })
    try {
      await window.moho.rpc('declineCall', { bufferId })
    } catch (e) {
      this.toast('error', `Couldn't decline: ${(e as Error).message}`)
    }
  }

  private callFor(bufferId: string): IncomingCall {
    const known = this.state.incomingCalls.find((c) => c.bufferId === bufferId)
    return known ?? { accountId: '', bufferId, channelId: '', ringing: false }
  }

  async joinVoice(accountId: string, guildId: string, channelId: string): Promise<void> {
    try {
      // soloOnly is off here because a person clicking a channel in a list
      // that shows them who is already in it has chosen to join those people.
      await window.moho.rpc('joinVoiceChannel', { accountId, guildId, channelId, soloOnly: false, transmit: true })
      await Promise.all([this.refreshVoiceSessions(), this.refreshVoiceChannels(accountId, guildId)])
    } catch (e) {
      this.toast('error', `Couldn't join voice: ${(e as Error).message}`)
    }
  }

  /**
   * Calls whoever is on the other end of a conversation.
   *
   * Takes a buffer rather than a user because that is what both callers have
   * - a row in the list, or the conversation on screen - and the daemon
   * resolves it to the channel the call happens in.
   */
  async callBuffer(bufferId: string): Promise<void> {
    try {
      await window.moho.rpc('startDiscordCall', { bufferId })
      await this.refreshVoiceSessions()
    } catch (e) {
      this.toast('error', `Couldn't call: ${(e as Error).message}`)
    }
  }

  /**
   * Puts a transfer's card away without touching the transfer.
   *
   * The distinction the buttons have to make plain: this hides something that
   * keeps running, and cancelling stops it. Getting those two confused costs
   * somebody a download they were most of the way through.
   */
  minimiseTransfer(id: string): void {
    if (this.state.minimisedTransfers.includes(id)) return
    this.set({ minimisedTransfers: [...this.state.minimisedTransfers, id] })
  }

  /**
   * Opens the one-to-one conversation with somebody, and goes to it.
   *
   * One call for every service that has them: which method each wants, and
   * whether it needs an id or a name, is the daemon's business. Both are
   * passed because IRC has only a nick to go on while Discord and Matrix have
   * real ids, and a display name is not something to look somebody up by.
   */
  async openDirectMessage(accountId: string, userId: string, nick: string): Promise<void> {
    try {
      const r = await window.moho.rpc<{ bufferId: string }>('openDirectMessage', { accountId, userId, nick })
      this.selectBuffer(r.bufferId)
    } catch (e) {
      this.toast('error', `Couldn't open a conversation: ${(e as Error).message}`)
    }
  }

  /**
   * Acts on an `irc://` link, from a browser or from a message.
   *
   * Two outcomes, and which it is depends on whether this is a network the
   * client is already on. If it is, there is nothing to set up: the channel is
   * joined on that connection and opened, which is what somebody clicking a
   * link to a channel wanted. If it is not, the accounts page opens with the
   * host, port and channel already filled in - the only thing such a link
   * cannot supply is who you are there.
   */
  followDeepLink(url: string): void {
    const link = parseDeepLink(url)
    if (!link) {
      this.toast('error', 'That link is not one moho understands')
      return
    }

    // A kick.com link names a streamer, and clicking one means both things:
    // the stream goes to the browser, which is where video is watched, and
    // the chat opens here, which is what this client is for. Doing only the
    // second was the old behaviour and it swallowed the link - somebody
    // clicking through to watch ended up with a chat and no stream.
    //
    // Any Kick account will do for the chat: they all read the same public
    // one, and the signed-in one is preferred only because it can also talk.
    if (link.service === 'kick') {
      void window.moho.openExternal(url)
      const account =
        this.state.accounts.find((a) => a.service === 'kick' && a.hasPassword) ??
        this.state.accounts.find((a) => a.service === 'kick')
      if (!account) {
        // The stream is already opening; only the chat is missing, and
        // saying so is better than a silence that looks like half of it
        // failed.
        this.toast('info', 'Add a Kick account to open that chat here too')
        return
      }
      this.set({ activePanel: '' })
      void window.moho
        .rpc('joinBuffer', { accountId: account.id, name: link.handle })
        .then(() => this.awaitBuffer(account.id, link.handle))
        .catch((e: Error) => this.toast('error', `Couldn't open ${link.handle}: ${e.message}`))
      return
    }

    // An IRC account is identified as "nick@host", which is the only place the
    // host survives out here - the wire account carries what to show, not what
    // it connected to.
    const existing = this.state.accounts.find(
      (a) => a.service === 'irc' && sameIrcNetwork(a.id.slice(a.id.indexOf('@') + 1), link.host)
    )
    if (!existing) {
      this.set({ pendingLink: link, activePanel: 'accounts' })
      return
    }

    if (link.channels.length === 0) {
      // A link to the network itself names nothing to join, so it shows the
      // connection it points at.
      const group = this.state.groups.find((g) => g.accountId === existing.id && g.kind === 'account')
      if (group) this.selectGroup(group.id)
      return
    }

    this.set({ activePanel: '' })
    for (const channel of link.channels) {
      void window.moho
        .rpc('joinBuffer', { accountId: existing.id, name: channel })
        .catch((e: Error) => this.toast('error', `Couldn't join ${channel}: ${e.message}`))
    }
    // The first one named, being the one they clicked towards.
    this.awaitBuffer(existing.id, link.channels[0])
  }

  /**
   * Sends a private message to one person on Sneedchat.
   *
   * Stays where you are. This used to go and find a "Whispers" buffer and open
   * it, which took somebody out of the room they were talking in every time
   * they answered a whisper - and Sneedchat has no such conversation anyway.
   * The whisper now appears in the room, marked as one, which is where the
   * site puts it and where the person who sent it is still looking.
   */
  async sendWhisper(accountId: string, target: string, body: string): Promise<void> {
    if (!body.trim()) return
    try {
      // Where it was sent from, so it lands in the conversation you were
      // having rather than in every room this account is in.
      await window.moho.rpc('sendWhisper', {
        accountId,
        target,
        body,
        bufferId: this.state.activeBufferId
      })
    } catch (e) {
      this.toast('error', `Couldn't whisper ${target}: ${(e as Error).message}`)
    }
  }

  /** Clears a link once the account form it opened is done with it. */
  clearPendingLink(): void {
    if (this.state.pendingLink) this.set({ pendingLink: null })
  }

  /**
   * Selects a channel once the server has confirmed the join.
   *
   * A join is a request rather than a fact: the buffer appears when the server
   * says it has, which may be a moment later or never - the channel could be
   * invite-only. Gives up quietly rather than leaving somebody waiting on a
   * conversation that was never opened.
   */
  awaitBuffer(accountId: string, name: string, tries = 20): void {
    const found = this.state.buffers.find(
      (b) => b.accountId === accountId && b.name.toLowerCase() === name.toLowerCase()
    )
    if (found) {
      this.selectBuffer(found.id)
      return
    }
    if (tries <= 0) return
    setTimeout(() => this.awaitBuffer(accountId, name, tries - 1), 250)
  }

  /**
   * Offers somebody a file, asking for one first.
   *
   * The picker is the system's own, so it looks and behaves like every other
   * open dialog on that machine - and picking a file is consent to send that
   * one, which is why the path never comes from anywhere but here.
   */
  async sendFileTo(accountId: string, nick: string): Promise<void> {
    const path = await window.moho.pickFile()
    if (!path) return
    try {
      await window.moho.rpc('sendFile', { accountId, nick, path })
      this.toast('info', `Offering that file to ${nick}…`)
    } catch (e) {
      this.toast('error', `Couldn't send to ${nick}: ${(e as Error).message}`)
    }
  }

  /** Takes a file that has been offered. */
  async acceptTransfer(id: string): Promise<void> {
    try {
      await window.moho.rpc('acceptTransfer', { id })
    } catch (e) {
      this.toast('error', `Couldn't accept that file: ${(e as Error).message}`)
    }
  }

  /**
   * Turns down an offer, or stops one already running.
   *
   * The same call for both: from where the person is sitting these are one
   * request - they want it to stop - and the daemon knows which it was.
   */
  async cancelTransfer(id: string): Promise<void> {
    try {
      await window.moho.rpc('cancelTransfer', { id })
    } catch (e) {
      this.toast('error', `Couldn't stop that transfer: ${(e as Error).message}`)
    }
  }

  /**
   * Leaves a room unread on purpose.
   *
   * Set optimistically as well as sent, because the answer arrives back
   * through sync rather than as a reply - waiting for it would leave the row
   * looking unchanged for a whole sync cycle after somebody pressed the thing.
   */
  async markUnread(bufferId: string): Promise<void> {
    this.set({
      buffers: this.state.buffers.map((b) => (b.id === bufferId ? { ...b, markedUnread: true } : b))
    })
    try {
      await window.moho.rpc('setMatrixMarkedUnread', { bufferId, unread: true })
    } catch (e) {
      this.set({
        buffers: this.state.buffers.map((b) => (b.id === bufferId ? { ...b, markedUnread: false } : b))
      })
      this.toast('error', `Couldn't mark that unread: ${(e as Error).message}`)
    }
  }

  /** Puts an export down between pages, or picks it back up. */
  async pauseTransfer(id: string, paused: boolean): Promise<void> {
    try {
      await window.moho.rpc('pauseTransfer', { id, paused })
    } catch (e) {
      this.toast('error', `Couldn't ${paused ? 'pause' : 'resume'} that: ${(e as Error).message}`)
    }
  }

  /**
   * Writes a conversation to disk as a folder of HTML.
   *
   * The loop is in the window because the formatting is - see lib/exporter.ts.
   * What this adds is where it goes (the downloads folder somebody chose, or
   * the platform's own) and saying how it went, since the export itself
   * reports progress through the transfer list like any other long job.
   */
  async exportConversation(
    bufferId: string,
    range: { since: number; until: number },
    opts: { media: boolean }
  ): Promise<void> {
    const buffer = this.state.buffers.find((b) => b.id === bufferId)
    if (!buffer) return
    const account = this.accountFor(bufferId)
    try {
      const prefs = await window.moho.prefs.getAll()
      const into =
        (prefs['downloads.directory'] as string | undefined) || (await window.moho.defaultDownloadDir())
      const answer = await runExport(
        (method, params) => window.moho.rpc(method, params),
        {
          bufferId,
          accountId: buffer.accountId,
          service: account?.service,
          title: bufferDisplayName(buffer.name)
        },
        range,
        into,
        opts
      )
      this.toast('info', `Exported ${answer.messages.toLocaleString()} messages to ${answer.path}`)
    } catch (e) {
      this.toast('error', `Export failed: ${(e as Error).message}`)
    }
  }

  async leaveVoice(accountId: string): Promise<void> {
    try {
      await window.moho.rpc('leaveVoiceChannel', { accountId })
      await this.refreshVoiceSessions()
    } catch (e) {
      this.toast('error', `Couldn't leave voice: ${(e as Error).message}`)
    }
  }

  /**
   * Connects or disconnects an account.
   *
   * The same thing the Accounts page does; exposed here because presence and
   * connection are one choice to a person - "offline" is not a mood, it is
   * being gone.
   */
  async setAccountConnected(accountId: string, connected: boolean): Promise<void> {
    try {
      await window.moho.rpc('setAccountConnected', { accountId, connected })
      await this.refreshAccounts()
    } catch (e) {
      this.toast('error', `Couldn't ${connected ? 'connect' : 'disconnect'}: ${(e as Error).message}`)
    }
  }

  /**
   * How this account should present itself, including not at all.
   *
   * Online and idle on a disconnected account connect it first - choosing to
   * appear online while signed out otherwise does nothing visible, which is
   * the kind of switch people press twice and then distrust. The status is
   * recorded either way and applied when the connection comes up.
   */
  async setPresence(
    accountId: string,
    status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
  ): Promise<void> {
    if (status === 'offline') return this.setAccountConnected(accountId, false)

    const state = this.state.accounts.find((a) => a.id === accountId)?.state
    await this.setAccountStatus(accountId, status)
    if (state === 'connected') return

    // An attempt already running is stopped before starting another. Without
    // this, choosing a status on an account stuck retrying did nothing
    // visible: the state was "connecting" before and after, so the only way
    // out was the Accounts page - which had the same dead button.
    if (state === 'connecting') await this.setAccountConnected(accountId, false)
    await this.setAccountConnected(accountId, true)
  }

  async setAccountStatus(
    accountId: string,
    status: 'online' | 'idle' | 'dnd' | 'invisible'
  ): Promise<void> {
    try {
      await window.moho.rpc('setAccountStatus', { accountId, status })
      await this.refreshAccounts()
    } catch (e) {
      this.toast('error', `Couldn't set status: ${(e as Error).message}`)
    }
  }

  selectGroup(groupId: string): void {
    if (groupId === this.state.activeGroupId) return
    this.set({ activeGroupId: groupId })
    if (!this.state.pinnedBufferId) void window.moho.prefs.set('ui.activeGroupId', groupId)
  }

  async refreshBuffers(): Promise<void> {
    try {
      const wire = await window.moho.rpc<WireBuffer[]>('listBuffers')
      const existing = new Map(this.state.buffers.map((b) => [b.id, b]))
      const buffers = wire.map((b) => ({
        unread: existing.get(b.id)?.unread ?? 0,
        highlight: existing.get(b.id)?.highlight ?? false,
        ...b
      }))
      this.set({ buffers })
      // "message" is a scoped event - nobilis only delivers it for buffers this
      // connection explicitly subscribed to. Without subscribing to every
      // buffer up front, one that's never been opened would never bump its
      // own unread count.
      for (const b of buffers)
        bestEffort(window.moho.rpc('subscribe', { bufferId: b.id }), `subscribe ${b.id}`)
      // The daemon answers "what mentioned me" over the channels it currently
      // knows about, and at startup that is almost none of them - the accounts
      // are still connecting. This first ask is worth making anyway for a
      // reconnect, where they are all already there; the arrival of each
      // channel schedules another.
      void this.refreshMentions()
    } catch (e) {
      this.toast('error', `Couldn't list buffers: ${(e as Error).message}`)
    }
  }

  // --- push events ----------------------------------------------------

  /**
   * Tells the service a conversation has been read.
   *
   * The preference is read here rather than mirrored into state, because the
   * window that changes a preference is deliberately not told about its own
   * change - so a mirror is stale in exactly the window somebody just used
   * the toggle in, which is the one place it has to be right.
   *
   * Off does not mean silence: it asks for a private receipt instead, which
   * this account's own other devices still see. Saying nothing at all would
   * leave a room read here unread on your phone forever.
   */
  private async ackRead(bufferId: string): Promise<void> {
    const prefs = await window.moho.prefs.getAll()
    await window.moho.rpc('markBufferRead', {
      bufferId,
      public: prefs['matrix.sendReadReceipts'] !== false
    })
  }

  /**
   * Opens a thread and reads it from the service.
   *
   * The panel shows what is stored the moment it opens and fills in behind
   * that, because a thread whose replies are already in scrollback should not
   * blank out while the server confirms them.
   */
  async openThreadPanel(bufferId: string, rootId: string): Promise<void> {
    const known = (this.state.messagesByBuffer[bufferId] || []).filter(
      (m) => m.id === rootId || (m.replyTo?.thread && m.replyTo.id === rootId)
    )
    this.set({ openThread: { bufferId, rootId, messages: known, loading: true } })
    try {
      const result = (await window.moho.rpc('fetchThread', { bufferId, rootId })) as {
        messages?: ChatMessage[]
      }
      // Somebody may have closed it, or opened a different one, while this
      // was in flight - answering into that would swap the thread under them.
      const open = this.state.openThread
      if (!open || open.bufferId !== bufferId || open.rootId !== rootId) return
      this.set({ openThread: { bufferId, rootId, messages: result.messages ?? known, loading: false } })
    } catch {
      const open = this.state.openThread
      if (open && open.bufferId === bufferId && open.rootId === rootId) {
        this.set({ openThread: { ...open, loading: false } })
      }
    }
  }

  closeThreadPanel(): void {
    this.set({ openThread: null })
  }

  /** Says something into a thread, rather than into the room around it. */
  async sendToThread(body: string): Promise<void> {
    const open = this.state.openThread
    if (!open || !body.trim()) return
    const root = open.messages.find((m) => m.id === open.rootId)
    await this.dispatchSend(open.bufferId, body, {
      id: open.rootId,
      from: root?.from ?? '',
      body: root?.body ?? '',
      thread: true
    })
  }

  /**
   * Asks who somebody is, and opens the card on what is known meanwhile.
   *
   * The card opens before the answer arrives because the answer is a request
   * over a network - to a homeserver, to Discord, to an IRC server that may
   * take a second to reply - and a menu item that appears to do nothing for
   * a second is a menu item people press twice.
   */
  showProfile(bufferId: string, nick: string, userId?: string): void {
    void window.moho
      .rpc<Profile>('requestProfile', { bufferId, nick, ...(userId ? { userId } : {}) })
      .then((opening) => this.set({ profile: opening }))
      .catch((e: Error) => this.toast('error', e.message))
  }

  closeProfile(): void {
    this.set({ profile: null })
  }

  /**
   * Whether an IRC account rejoins this channel when it connects.
   *
   * The daemon keeps it as one comma-separated string on the account, which
   * is how IRC clients have always stored it; this reads that string as the
   * list it is.
   */
  autojoins(accountId: string, channel: string): boolean {
    const account = this.state.accounts.find((a) => a.id === accountId)
    return autojoinList(account?.autojoin).some((c) => c.toLowerCase() === channel.toLowerCase())
  }

  /** Adds this channel to that list, or takes it out. */
  toggleAutojoin(accountId: string, channel: string): void {
    const account = this.state.accounts.find((a) => a.id === accountId)
    if (!account) return
    const current = autojoinList(account.autojoin)
    const has = current.some((c) => c.toLowerCase() === channel.toLowerCase())
    const next = has ? current.filter((c) => c.toLowerCase() !== channel.toLowerCase()) : [...current, channel]
    void window.moho
      .rpc('setAccountAutojoin', { accountId, channels: next.join(',') })
      .then(() => this.refreshAccounts())
      .then(() => this.toast('info', has ? `Will not rejoin ${channel}` : `Will rejoin ${channel} on connect`))
      .catch((e: Error) => this.toast('error', e.message))
  }

  /**
   * Votes in the poll on screen.
   *
   * The card redraws from the daemon's answer, which carries the poll with
   * this vote already in it - so the bars move on the click rather than when
   * Kick's broadcast catches up.
   */
  votePoll(bufferId: string, optionId: string | number): void {
    // Both spellings of the same answer: Kick numbers its options and Matrix
    // gives them ids of their own, and which one the daemon reads follows
    // from which service the conversation belongs to.
    void window.moho
      .rpc('votePoll', { bufferId, optionId: Number(optionId), answerId: String(optionId) })
      .catch((e: Error) => this.toast('error', e.message))
  }

  /**
   * Puts points on an outcome.
   *
   * The daemon answers with the prediction this bet landed in, so the card
   * redraws from the reply - the odds move with every bet, and the one you
   * just placed should be the first thing to move them on your screen.
   */
  betPrediction(bufferId: string, optionId: string | number, amount: number): void {
    void window.moho
      .rpc('betPrediction', { bufferId, optionId: String(optionId), amount })
      .catch((e: Error) => this.toast('error', e.message))
  }

  /** Takes the poll down, which the service allows whoever it allows. */
  endPoll(bufferId: string): void {
    void window.moho
      .rpc('endPoll', { bufferId })
      .catch((e: Error) => this.toast('error', e.message))
  }

  /** What this conversation has voted on before, newest first. */
  async listPolls(bufferId: string, kind: 'poll' | 'prediction'): Promise<LiveCard[]> {
    try {
      const rows = await window.moho.rpc<LiveCard[]>('listPolls', { bufferId, kind, limit: 25 })
      // Read back rather than live: every one of these is over, whatever
      // seconds it was carrying when it was written down.
      //
      // The conversation is stamped on the way out as well as on the way in,
      // because rows written before the daemon carried one would otherwise be
      // recalled into a card that belongs to no channel and so draws nothing.
      return rows.map((card) => ({ ...card, bufferId, receivedAt: cardHeardAt(card), closed: true }))
    } catch (e) {
      this.toast('error', (e as Error).message)
      return []
    }
  }

  /** Puts an old one back on screen, to be read rather than answered. */
  reviewPoll(card: LiveCard | null): void {
    this.set({ reviewCard: card })
  }

  /**
   * Who this account is ignoring, asked of the daemon.
   *
   * `listIgnored` rather than `listMatrixIgnored`: the daemon answers for
   * every service - the homeserver's list for Matrix, its own for the
   * protocols that have nowhere to keep one - and asking the Matrix-only
   * question was why ignoring on IRC, Discord and Kick was a one-way door.
   */
  refreshIgnored(accountId: string): void {
    void window.moho
      .rpc<string[]>('listIgnored', { accountId })
      .then((users) => this.noteIgnored(accountId, users ?? []))
      // Quietly: an account still connecting has no answer yet, and this runs
      // whenever a panel opens.
      .catch(() => {})
  }

  /** Seeds the ignore list from a direct read, before any event arrives. */
  noteIgnored(accountId: string, users: string[]): void {
    this.set({ ignoredByAccount: { ...this.state.ignoredByAccount, [accountId]: users } })
  }

  /**
   * Ignores somebody, or stops. Every service, not only Matrix.
   *
   * The account's own list rather than this window's `blockedNicks`: where the
   * service has one it travels to every client signed in, which is what
   * blocking somebody means, and it agrees with Element.
   */
  setIgnored(accountId: string, target: string, ignored: boolean): void {
    void window.moho
      .rpc<{ scope?: string }>('setIgnored', { accountId, target, ignored })
      .then((answer) => {
        // Where it holds is the part worth saying. On Matrix and Discord the
        // service itself is told, so it holds everywhere that account is
        // signed in; on IRC, Kick and Sneedchat there is nobody to tell, and
        // this is moho refusing to show what still arrives.
        const scope = answer?.scope === 'account' ? '' : ' here'
        this.toast('info', ignored ? `Ignoring ${target}${scope}` : `No longer ignoring ${target}`)
        // Read back rather than patched locally. Matrix pushes its list on
        // sync, but for the services whose list this daemon keeps itself
        // nothing announces a change, so the panel would go on showing what
        // was true when it opened.
        this.refreshIgnored(accountId)
      })
      .catch((e: Error) => this.toast('error', e.message))
  }

  /**
   * Pins a message where the service has pins, or takes the pin off.
   *
   * Offered to everybody rather than gated on a permission read here: the
   * server decides, and it says no in words worth showing. Hiding the action
   * from somebody who could have used it is the worse mistake.
   */
  setPinned(bufferId: string, messageId: string, pinned: boolean): void {
    void window.moho
      .rpc('setPinned', { bufferId, messageId, pinned })
      .then(() => this.toast('info', pinned ? 'Pinned' : 'Unpinned'))
      .catch((e: Error) => this.toast('error', e.message))
  }

  /**
   * Presses a button on a message, or answers one of its menus.
   *
   * Nothing is echoed here. Whatever the bot does about it arrives the way
   * anything else does - a message, or an edit to the one that was pressed -
   * and guessing at it would mean showing an answer that never came.
   */
  useComponent(bufferId: string, messageId: string, customId: string, select: boolean, values: string[]): void {
    void window.moho
      .rpc('useDiscordComponent', { bufferId, messageId, customId, select, values })
      .catch((e: Error) => this.toast('error', e.message))
  }

  /**
   * Rings whoever is in this Matrix conversation.
   *
   * Its own method rather than part of callBuffer, which is Discord's: the two
   * do genuinely different things - Discord's call is a channel the daemon
   * joins, and this one is a connection this window makes.
   */
  async callMatrix(bufferId: string, video: boolean): Promise<void> {
    const account = this.accountFor(bufferId)
    if (!account) return
    await this.matrixCalls.place(account.id, bufferId, video)
  }

  async answerMatrixCall(video: boolean): Promise<void> {
    await this.matrixCalls.answer(video)
  }

  declineMatrixCall(): void {
    this.matrixCalls.decline()
  }

  /** Puts the call away, or brings it back. It keeps running either way. */
  setCallMinimized(minimized: boolean): void {
    this.set({ callMinimized: minimized })
  }

  /**
   * Starts watching a Kick channel's stream in this window.
   *
   * Only what is on air: the playlist for an offline channel is a signed URL
   * to nothing, and a player pointed at it fails a few seconds later with an
   * error about segments rather than saying the obvious thing.
   *
   * One at a time, and never beside a call - both draw into the same surface,
   * and a call is the one that cannot be restarted with a click.
   */
  watchStream(bufferId: string): void {
    const stream = this.state.kickStreams[bufferId]
    const buffer = this.state.buffers.find((b) => b.id === bufferId)
    if (!buffer) return
    if (!stream?.live || !stream.playbackUrl) {
      this.toast('info', `${bufferDisplayName(buffer.name)} is not streaming right now`)
      return
    }
    if (this.state.activeCall) {
      this.toast('info', 'Finish the call first - the picture has one place to go')
      return
    }
    this.set({
      watchMinimized: false,
      watching: {
        bufferId,
        accountId: buffer.accountId,
        title: stream.title || bufferDisplayName(buffer.name)
      }
    })
  }

  stopWatching(): void {
    this.set({ watching: null, watchMinimized: false })
  }

  setWatchMinimized(minimized: boolean): void {
    this.set({ watchMinimized: minimized })
  }

  /** What is actually arriving in a call held on a media server, if one is
   *  up: a check that the media is readable rather than merely connected. */
  async callArrivals(): Promise<unknown> {
    const group = this.matrixCalls.currentGroup
    return group?.sfu ? group.sfu.arriving() : []
  }

  closeDiscordModal(): void {
    this.set({ discordModal: null })
  }

  /**
   * Sends a filled-in form back to the bot that asked for it.
   *
   * Closed on success rather than on sending: a refusal is worth showing
   * with what was typed still on screen, since retyping a form somebody has
   * just filled in is the worst way to learn a field was too long.
   */
  async submitDiscordModal(values: Record<string, string>): Promise<void> {
    const modal = this.state.discordModal
    if (!modal) return
    try {
      await window.moho.rpc('submitDiscordModal', {
        bufferId: modal.bufferId,
        customId: modal.customId,
        applicationId: modal.applicationId,
        id: modal.id,
        values: modal.fields.map((field) => ({
          customId: field.customId,
          value: values[field.customId] ?? ''
        }))
      })
      this.set({ discordModal: null })
    } catch (e) {
      this.toast('error', (e as Error).message)
    }
  }

  hangUpMatrixCall(): void {
    // Whichever kind is up: leaving a room's call withdraws the membership
    // that says this end is in it, as well as hanging up on everybody.
    if (this.matrixCalls.currentGroup) {
      this.matrixCalls.leaveGroup()
      this.set({ activeCall: null })
      return
    }
    this.matrixCalls.end()
  }

  /**
   * Joins the call in this room, starting one if nobody is in it.
   *
   * Joining is starting: publishing this end's membership is what makes a
   * call exist, and the difference is only whether anybody was there first.
   */
  async joinMatrixGroupCall(bufferId: string, video: boolean): Promise<void> {
    const account = this.accountFor(bufferId)
    if (!account) return
    // The stage goes up before the joining rather than after it: connecting
    // to a media server takes a moment, and a window that shows nothing for
    // that moment looks like a button that did nothing. Set first so the
    // phases the call reports afterwards land on top of it rather than
    // underneath - reporting "connected" and then overwriting it with
    // "connecting" was exactly the bug this shape avoids.
    this.set({
      callMinimized: false,
      activeCall: {
        accountId: account.id,
        bufferId,
        phase: 'connecting',
        video,
        muted: false,
        sharingScreen: false
      }
    })
    await this.matrixCalls.joinGroup(account.id, bufferId, video)
    if (!this.matrixCalls.currentGroup) this.set({ activeCall: null })
  }

  /**
   * Puts the screen picker on screen and waits for a choice.
   *
   * A promise held here because the choosing is a component's job and the
   * sharing is this one's - the alternative is the picker knowing how to
   * start a screen share, which would put a call's mechanics in a dialog.
   */
  private screenChoice: ((source: { id: string; name: string } | null) => void) | null = null

  private askForScreenSource(
    sources: { id: string; name: string; thumbnail: string }[]
  ): Promise<{ id: string; name: string } | null> {
    return new Promise((resolve) => {
      this.screenChoice = resolve
      this.set({ screenSources: sources })
    })
  }

  /** The picker answering, with a source or with nothing. */
  chooseScreenSource(source: { id: string; name: string } | null): void {
    const resolve = this.screenChoice
    this.screenChoice = null
    this.set({ screenSources: null })
    resolve?.(source)
  }

  /**
   * Everybody in the call, one entry per tile.
   *
   * A list rather than "ours and theirs", because a call is not always two
   * people: a 1:1 Matrix call is the two below, and a group call - when there
   * is one - is the same list, longer. The view draws whatever it is given
   * and does not need to learn anything new to draw five.
   */
  /** Somebody's name in a room, or their id where the roster has not said. */
  private matrixDisplayName(bufferId: string, userId: string): string {
    const roster = this.state.presenceByBuffer[bufferId] ?? []
    return roster.find((m) => m.userId === userId)?.nick ?? userId
  }

  callTiles(): CallTile[] {
    // A call between everybody in a room: one tile for this end and one per
    // person answered, which is what the fitted grid was built for.
    const group = this.matrixCalls.currentGroup
    if (group) {
      // This end's own capture, which exists whether or not anybody has
      // answered yet - it is opened once for the whole call rather than per
      // connection.
      const ours = group.local
      this.levels.watch('self', ours)
      const tiles: CallTile[] = [
        {
          id: 'self',
          label: this.ownNameIn(group.bufferId) || 'You',
          stream: ours,
          hasVideo: !!ours?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted),
          self: true,
          muted: !!this.state.activeCall?.muted,
          speaking: !this.state.activeCall?.muted && this.levels.speaking('self')
        }
      ]
      // On a media server, everybody arrives from the server rather than from
      // a connection of their own - the same tiles either way.
      for (const person of group.sfuPeople) {
        this.levels.watch(person.key, person.stream)
        tiles.push({
          id: person.key,
          label: this.matrixDisplayName(group.bufferId, person.userId),
          stream: person.stream,
          hasVideo: person.hasVideo,
          speaking: this.levels.speaking(person.key)
        })
      }
      for (const peer of group.peers.values()) {
        this.levels.watch(peer.key, peer.remote)
        // Only once there is something to show: a tile for somebody who has
        // not answered yet is a picture of nobody.
        if (!peer.remote) continue
        tiles.push({
          id: peer.key,
          label: this.matrixDisplayName(group.bufferId, peer.userId),
          stream: peer.remote,
          hasVideo: peer.remote.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted),
          speaking: this.levels.speaking(peer.key)
        })
      }
      return tiles
    }

    const call = this.matrixCalls.current
    if (!call) {
      this.levels.dispose()
      return []
    }
    const active = this.state.activeCall
    const live = (stream: MediaStream | null): boolean =>
      !!stream?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted)
    const ours = call.call.stream
    const theirs = call.remote
    const them = this.state.buffers.find((b) => b.id === call.bufferId)?.name
    // Who is talking, measured here because the audio is here - the daemon
    // does this for a Discord call because it holds that connection.
    this.levels.watch('self', call.call.localAudio)
    this.levels.watch('them', theirs)
    const tiles: CallTile[] = [
      {
        id: 'self',
        label: this.ownNameIn(call.bufferId) || 'You',
        stream: ours,
        hasVideo: live(ours),
        self: true,
        muted: !!active?.muted,
        // A muted microphone is not a quiet one, and lighting it up would be
        // telling somebody they are being heard when they are not.
        speaking: !active?.muted && this.levels.speaking('self')
      }
    ]
    // Only once there is somebody there: a tile for a person who has not
    // answered is a picture of nobody.
    if (theirs) {
      tiles.push({
        id: 'them',
        label: them ? bufferDisplayName(them) : 'Them',
        stream: theirs,
        hasVideo: live(theirs),
        speaking: this.levels.speaking('them')
      })
    }
    return tiles
  }

  toggleCallMute(): void {
    if (!this.state.activeCall) return
    // Three kinds of call reach this button and the button does not care:
    // one to one, a mesh in a room, and a room call held on a media server.
    const group = this.matrixCalls.currentGroup
    if (group?.sfu) {
      void group.sfu.toggleMute().then((muted) => {
        if (this.state.activeCall) this.set({ activeCall: { ...this.state.activeCall, muted } })
      })
      return
    }
    if (group) {
      // Every leg carries the same capture, so muting it mutes all of them.
      const track = group.local?.getAudioTracks()[0]
      if (!track) return
      track.enabled = !track.enabled
      this.set({ activeCall: { ...this.state.activeCall, muted: !track.enabled } })
      return
    }
    const call = this.matrixCalls.current
    if (!call) return
    const muted = call.call.toggleMute()
    this.set({ activeCall: { ...this.state.activeCall, muted } })
  }

  /**
   * Shares a screen or a window into the call.
   *
   * The picker is the desktop's rather than the browser's: Electron will not
   * answer getDisplayMedia without being told which source, and a list of the
   * windows somebody actually has open is the only way to choose one.
   */
  async toggleScreenShare(): Promise<void> {
    if (!this.state.activeCall) return
    // On a media server the picker is LiveKit's own job, and Electron's
    // source list is what answers it - see the permission handler in main.
    const group = this.matrixCalls.currentGroup
    if (group?.sfu) {
      const sharing = await group.sfu.toggleScreen().catch((e: Error) => {
        this.toast('error', e.message)
        return false
      })
      this.set({ activeCall: { ...this.state.activeCall, sharingScreen: sharing } })
      return
    }
    const call = this.matrixCalls.current
    if (!call) return
    try {
      if (call.call.sharingScreen) {
        await call.call.shareScreen()
        this.set({ activeCall: { ...this.state.activeCall, sharingScreen: false } })
        return
      }
      const sources = await window.moho.screenSources()
      if (sources.length === 0) {
        this.toast('info', 'Nothing to share')
        return
      }
      // Chosen in the window rather than here: the picker is a component, and
      // this waits for it to answer.
      const source = await this.askForScreenSource(sources)
      if (!source) return
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // Chromium's own desktop-capture constraint, which is how an
          // Electron window turns a source id into a stream.
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id }
        }
      } as unknown as MediaStreamConstraints)
      await call.call.shareScreen(stream)
      this.set({ activeCall: { ...this.state.activeCall, sharingScreen: true } })
    } catch (e) {
      this.toast('error', `Couldn't share the screen: ${(e as Error).message}`)
    }
  }

  /** Follows a Kick channel, or stops. The header reads the answer back. */
  setFollowing(bufferId: string, follow: boolean): void {
    void window.moho
      .rpc('setKickFollowing', { bufferId, follow })
      .catch((e: Error) => this.toast('error', e.message))
  }

  private handleEvent(frame: NobilisEvent): void {
    const { event, data } = frame
    switch (event) {
      case 'message':
        // An echo of our own send resolves the optimistic row in place; only
        // an unmatched message is a genuinely new one to append.
        if (!data.isOwn || !this.reconcileOwnEcho(data)) this.appendMessage(data.bufferId, data)
        break

      // One end of a Matrix call: an offer, an answer, the network paths, or
      // a hangup. The media is this window's; the daemon only carries these.
      case 'matrixCall':
        this.matrixCalls.handle(data as unknown as MatrixCallEvent)
        break

      // Friends, and requests either way, as they change. Discord announces
      // these rather than expecting a client to poll - which is what makes a
      // request that arrives while the panel is open appear in it.
      case 'discordFriends':
        this.set({
          discordFriends: {
            ...this.state.discordFriends,
            [data.accountId as string]: (data.friends as DiscordFriend[]) || []
          }
        })
        break

      // Buttons and menus, which arrive a moment after the message they are
      // on: the row has to exist before they can be written onto it.
      case 'messageComponents':
        this.mapMessage(data.bufferId as string, data.messageId as string, (m) => ({
          ...m,
          components: data.components as ChatMessage['components']
        }))
        break

      // Who wrote a forwarded message, once the daemon has read the original:
      // the row above it says "Forwarded" until then, since Discord sends a
      // forward without an author.
      case 'messageReplyRenamed': {
        this.mapMessage(data.bufferId, data.id, (m) =>
          m.replyTo ? { ...m, replyTo: { ...m.replyTo, from: data.from } } : m
        )
        break
      }

      case 'messageUpdated':
        // `edited` comes from the event rather than being hardcoded true: a
        // backend-internal body rewrite (Sneedchat swapping in a Tor-fetched
        // local copy of an attachment) reuses this event with edited:false and
        // must not show the "(edited)" label. OR'd with the current value so a
        // genuine earlier edit isn't clobbered by a later silent rewrite.
        this.mapMessage(data.bufferId, data.id, (m) => ({
          ...m,
          // A thumbnail landing or links being re-signed carries attachments
          // only - no body, no embeds - so those must not be blanked out.
          body: data.body ?? m.body,
          edited: m.edited || !!data.edited,
          embeds: data.embeds ?? m.embeds ?? [],
          attachments: data.attachments ?? m.attachments
        }))
        break

      case 'messageDeleted':
        this.setMessages(
          data.bufferId,
          (this.state.messagesByBuffer[data.bufferId] || []).filter((m) => m.id !== data.id)
        )
        break

      case 'reactionsChanged':
        this.mapMessage(data.bufferId, data.id, (m) => ({ ...m, reactions: data.reactions }))
        break

      case 'bufferListChange':
        this.handleBufferListChange(data)
        break

      // Somebody is writing. Discord names one person per event and Matrix
      // sends the whole set, including an empty one to say everybody
      // stopped - so a list replaces, and a single nick is merged in.
      // Somebody joined or left a room's call. Both the offer of a call to
      // join and, while in one, the signal to meet whoever just arrived.
      // A bot answering a slash command with a form to fill in.
      case 'discordModal': {
        this.set({ discordModal: data as unknown as DiscordModal })
        break
      }

      // Somebody's media key, for a call whose frames the server cannot read.
      case 'matrixCallKey': {
        void this.matrixCalls.takeKey(data.userId, data.deviceId, data.key, data.index ?? 0)
        break
      }

      case 'matrixCallMembers': {
        const members = (data.members ?? []) as CallMember[]
        this.set({ callMembers: { ...this.state.callMembers, [data.bufferId]: members } })
        void this.matrixCalls.meet(members)
        break
      }

      case 'typing': {
        const until = Date.now() + (data.expiresInMs ?? 10000)
        const current = this.state.typingByBuffer[data.bufferId]
        const nicks: string[] = data.nicks
          ? data.nicks
          : Array.from(new Set([...(current && current.until > Date.now() ? current.nicks : []), data.nick]))
        this.set({
          typingByBuffer: { ...this.state.typingByBuffer, [data.bufferId]: { nicks, until } }
        })
        break
      }

      // Where everybody else has read up to. A whole room's markers at
      // once, replacing what was there: see readersByBuffer.
      case 'readReceipts': {
        const byMessage: Record<string, MessageReader[]> = {}
        for (const reader of (data.readers ?? []) as (MessageReader & { messageId: string })[]) {
          const list = byMessage[reader.messageId] ?? (byMessage[reader.messageId] = [])
          list.push({ userId: reader.userId, nick: reader.nick, avatarUrl: reader.avatarUrl })
        }
        this.set({ readersByBuffer: { ...this.state.readersByBuffer, [data.bufferId]: byMessage } })
        break
      }

      // Read on another device. Discord echoes an ack to every session an
      // account has, including the one that sent it, so this settles our own
      // count as well as following somebody's phone.
      case 'bufferRead':
        this.set({
          buffers: this.state.buffers.map((b) =>
            // Reading a room is how a deliberate mark is taken off, so the
            // flag clears with the count. Anything else would need a second
            // gesture to undo the first, and nobody would find it.
            b.id === data.bufferId ? { ...b, unread: 0, highlight: false, markedUnread: false } : b
          )
        })
        break

      // Somebody left this room unread, here or on another client.
      case 'markedUnread':
        this.set({
          buffers: this.state.buffers.map((b) =>
            b.id === data.bufferId ? { ...b, markedUnread: !!data.unread } : b
          )
        })
        break

      case 'bufferGroupChange':
        // A leave arrives as a removal rather than a new shape. Passing that
        // to the upsert would add a rail entry with no name and no service.
        if (data.removed) this.removeGroup(data.id as string)
        else this.upsertGroup(data as BufferGroup)
        break

      // The call itself came up or went away. Separate from membership
      // because these fire for our own connection, which is what decides
      // whether the connected panel is on screen at all.
      case 'discordVoiceConnected':
      case 'discordVoiceLeft':
      case 'discordVoiceError':
        void this.refreshVoiceSessions()
        break

      // A conversation started or stopped ringing.
      case 'incomingCall':
        this.setRinging(data as IncomingCall)
        break

      // One event carries every state a transfer passes through, so the list
      // is updated in place rather than re-fetched on each step of a progress
      // bar that ticks several times a second.
      case 'dccTransfer': {
        const t = data as unknown as DccTransfer
        const rest = this.state.transfers.filter((x) => x.id !== t.id)
        this.set({ transfers: [t, ...rest] })
        break
      }

      // Somebody joined or left a voice channel in a guild we may be showing.
      case 'voiceMembershipChanged':
        if (data.guildId === this.state.voiceGuildId) {
          void this.refreshVoiceChannels(data.accountId, data.guildId)
        }
        void this.refreshVoiceSessions()
        break

      // The server said the message went nowhere. Recorded in the
      // conversation rather than as a toast: it belongs beside the message it
      // is about, and is still true when you scroll back to it tomorrow.
      case 'deliveryFailed':
        this.appendMessage(data.bufferId, {
          id: `notice-${++this.sendSeq}-${Date.now()}`,
          bufferId: data.bufferId,
          from: '',
          body: data.text,
          ts: Math.floor(Date.now() / 1000),
          isAction: false,
          isHighlight: false,
          kind: 'notice',
          isOwn: false
        })
        break

      // Another window, or the daemon itself, changed the audio state.
      case 'voicePrefsChanged':
        this.set({ voicePrefs: data as VoicePrefs })
        break

      // Somebody looked up. Shown as a card rather than as lines in the
      // buffer: it is an answer to a question, not part of the conversation.
      //
      // Ignored when it is not about whoever is on screen - two lookups in
      // quick succession would otherwise have the slower one win.
      case 'profile': {
        const answer = data as unknown as Profile
        const open = this.state.profile
        if (open && open.name.toLowerCase() !== answer.name.toLowerCase() && !answer.handle?.toLowerCase().includes(open.name.toLowerCase())) break
        this.set({ profile: answer })
        break
      }

      case 'matrixInvites':
        this.set({
          matrixInvites: {
            ...this.state.matrixInvites,
            [data.accountId as string]: (data.invites as MatrixInvite[]) || []
          }
        })
        break

      // The daemon's name for it, because only Matrix has a list the server
      // pushes; the state it lands in is every service's.
      case 'matrixIgnored':
        this.set({
          ignoredByAccount: {
            ...this.state.ignoredByAccount,
            [data.accountId as string]: (data.users as string[]) || []
          }
        })
        break

      case 'pinnedMessages':
        this.set({
          pinnedMessages: {
            ...this.state.pinnedMessages,
            [data.bufferId as string]: (data.pinned as string[]) || []
          }
        })
        break

      case 'pinnedMessage': {
        const bufferId = data.bufferId as string
        const pinned = { ...this.state.pinnedByBuffer }
        // A cleared pin arrives as an event with no id rather than as no
        // event at all - the bar is on screen and has to be told to go.
        if (data.id) {
          pinned[bufferId] = {
            id: String(data.id),
            from: String(data.from ?? ''),
            body: String(data.body ?? '')
          }
        } else {
          delete pinned[bufferId]
        }
        this.set({ pinnedByBuffer: pinned })
        break
      }

      case 'pollCard': {
        const bufferId = data.bufferId as string
        const kind = (data.kind as string) || 'poll'
        const card = data.poll as unknown as LiveCard | null
        const polls = { ...this.state.livePolls }
        const slot = cardSlot(bufferId, kind)
        const had = polls[slot]
        if (!card) {
          // Taken down, not forgotten: the card holds the result until it is
          // folded away.
          if (had) polls[slot] = { ...had, closed: true }
        } else {
          polls[slot] = {
            ...card,
            bufferId,
            kind: kind as LiveCard['kind'],
            receivedAt: cardHeardAt(card)
          }
        }
        this.set({ livePolls: polls })
        break
      }

      case 'kickStream': {
        const stream = data as unknown as KickStream
        this.set({ kickStreams: { ...this.state.kickStreams, [stream.bufferId]: stream } })
        break
      }

      case 'presenceChange':
        this.set({
          presenceByBuffer: { ...this.state.presenceByBuffer, [data.bufferId]: data.members }
        })
        break

      case 'connectionState':
        this.handleConnectionState(data)
        break

      // nobilis names these fields `qrCodePath` and `detail`; reading `path`
      // and `status` silently yielded empty strings, which is why the QR
      // never appeared and login progress text stayed blank.
      case 'discordLoginQr':
        this.set({ discordQrPath: data.qrCodePath || '', discordLoginStatus: 'Scan the code' })
        break
      case 'discordLoginScanned':
        this.set({ discordLoginStatus: 'Scanned - approve it on your phone' })
        break
      case 'discordLoginMfa':
        this.set({
          discordMfa: {
            loginId: data.loginId,
            totp: !!data.totp,
            sms: !!data.sms,
            backup: !!data.backup
          },
          discordLoginStatus: ''
        })
        break

      case 'discordLoginResult':
        this.set({
          discordQrPath: '',
          discordLoginStatus: data.error || '',
          // A failure leaves the form open to try again; success clears it.
          discordMfa: data.error ? this.state.discordMfa : null,
          discordReauthAccountId: data.error ? this.state.discordReauthAccountId : ''
        })
        if (!data.error) {
          void this.refreshAccounts()
          void this.refreshBuffers()
        }
        break

      case 'discordLoginStatus':
        this.set({ discordLoginStatus: data.detail || '' })
        break

      case 'sneedChatLoginStatus':
        this.set({ sneedChatLoginStatus: data.detail || '' })
        break
      case 'sneedChatLoginResult':
        this.set({ sneedChatLoginStatus: data.error || '' })
        // Refreshed either way. The daemon now saves the account before it
        // attempts the login, so a wrong password or a Tor bootstrap that
        // never finished leaves an account sitting there to correct and
        // retry - and refreshing only on success was what kept it invisible.
        void this.refreshAccounts()
        break

      // Verification is a multi-step flow whose steps all arrive as pushes:
      // a status change, then the emoji to compare, then a final result.
      // Somebody asking to verify, rather than us asking them. Nothing
      // handled this, so a request arriving from another session - or from
      // another person, now that those reach here at all - was recorded by
      // the daemon and shown nowhere.
      case 'matrixVerificationIncoming':
        this.set({
          matrixVerification: {
            accountId: data.accountId,
            verificationId: data.verificationId,
            state: 'requested',
            otherUser: data.fromUser,
            otherDevice: data.fromDevice,
            isSelf: data.isSelf
          }
        })
        this.toast(
          'info',
          data.isSelf === false
            ? `${data.fromUser} wants to verify with you`
            : 'Another of your sessions wants to verify'
        )
        break

      case 'matrixVerificationStatus':
        this.set({
          matrixVerification: { ...(this.state.matrixVerification || {}), ...data }
        })
        break
      case 'matrixVerificationEmoji':
        this.set({
          matrixVerification: {
            ...(this.state.matrixVerification || {}),
            ...data,
            state: 'emoji'
          }
        })
        break
      case 'matrixVerificationResult':
        if (data.success) {
          this.toast('info', 'Session verified')
          this.set({ matrixVerification: { ...data, state: 'done' } })
          // Clear the banner shortly after, once the panel has reacted to
          // "done" by refetching the (now verified) device list.
          setTimeout(() => this.set({ matrixVerification: null }), 1500)
        } else {
          this.toast('error', `Verification failed: ${data.error || 'cancelled'}`)
          this.set({ matrixVerification: null })
        }
        void this.refreshAccounts()
        break

      case 'matrixLoginStatus':
        this.set({ matrixLoginStatus: data.detail || '' })
        // An SSO sign-in arrives with the address of the server's own login
        // page. Opened in the real browser rather than in a window of ours:
        // it is where somebody's password manager, passkey and second factor
        // already live, and none of that should have to work in here.
        if (typeof data.url === 'string' && data.url) void window.moho.openExternal(data.url)
        break
      case 'matrixLoginResult':
        this.set({ matrixLoginStatus: data.error || '' })
        // Same as Sneedchat above: the account exists before the attempt, so
        // a failure has something to show and something to retry.
        void this.refreshAccounts()
        break

      default:
        break
    }
  }

  /**
   * Puts a room in the list the moment somebody asks to join it.
   *
   * Joining is two round trips before the daemon can name the room - the join
   * itself, then the room's state - and until they finished the click had
   * produced nothing anywhere on screen. This is the same optimistic echo an
   * outgoing message gets, and for the same reason: the wait is real and the
   * silence is what makes it feel broken.
   *
   * The stand-in is replaced by the real buffer when it arrives, matched on
   * the room id. It is not selectable in any useful sense yet - there is
   * nothing behind it - but it is visible, named, and plainly working.
   */
  async joinMatrixRoom(accountId: string, roomIdOrAlias: string, name: string, via: string[] = []): Promise<void> {
    const stand_in: BufferEntry = {
      id: `${JOINING_PREFIX}${accountId}|${roomIdOrAlias}`,
      accountId,
      kind: 'channel',
      name,
      lastActivityTs: Math.floor(Date.now() / 1000),
      groupId: `account:${accountId}`,
      remoteId: roomIdOrAlias,
      syncing: true,
      unread: 0,
      highlight: false
    }
    this.set({ buffers: [...this.state.buffers, stand_in] })
    try {
      await window.moho.rpc('joinMatrixRoom', { accountId, roomIdOrAlias, via })
    } catch (e) {
      // The row goes with the failure. Leaving it there would say the room is
      // still arriving, which is the one thing it is definitely not doing.
      this.dropJoining(stand_in.id)
      throw e
    }
    // A join that succeeded but whose room never turned up - a server that
    // accepted it and then said nothing - leaves the stand-in stranded, so it
    // gives up on the same schedule the daemon's own sync mark does.
    setTimeout(() => this.dropJoining(stand_in.id), JOIN_GIVE_UP_MS)
  }

  /**
   * Asks to be let into a room that is asked rather than entered.
   *
   * No stand-in row, unlike a join: knocking does not put you in the room and
   * a row in the list would say it had. The answer, when it comes, is an
   * invitation - which the invite list already shows.
   */
  async knockMatrixRoom(accountId: string, roomIdOrAlias: string, via: string[] = [], reason = ''): Promise<void> {
    await window.moho.rpc('knockMatrixRoom', { accountId, roomIdOrAlias, via, reason })
  }

  /**
   * Tells whoever runs the homeserver about a message.
   *
   * Needs no power in the room, which is what makes it the answer available to
   * everybody - see the moderation entries beside it, which do.
   */
  async reportMatrixMessage(bufferId: string, messageId: string, reason: string): Promise<void> {
    await window.moho.rpc('reportMatrixMessage', { bufferId, messageId, reason })
  }

  /** Puts a room in a space, or takes it out of one. */
  async setMatrixSpaceChild(spaceId: string, bufferId: string, child: boolean): Promise<void> {
    await window.moho.rpc('setMatrixSpaceChild', { spaceId, bufferId, child })
  }

  private dropJoining(id: string): void {
    if (!this.state.buffers.some((b) => b.id === id)) return
    this.set({ buffers: this.state.buffers.filter((b) => b.id !== id) })
  }

  private handleBufferListChange(data: WireBuffer & { removed?: boolean }): void {
    let { buffers } = this.state
    if (data.removed) {
      this.set({ buffers: buffers.filter((b) => b.id !== data.id) })
      return
    }
    // The room somebody asked to join has arrived for real. The stand-in goes
    // now rather than on its own timer, matched on the room id because the
    // real buffer's own id is derived from a name nothing knew when the join
    // was asked for.
    if (data.remoteId && buffers.some((b) => isJoining(b) && b.remoteId === data.remoteId)) {
      buffers = buffers.filter((b) => !isJoining(b) || b.remoteId !== data.remoteId)
      this.set({ buffers })
    }
    const known = buffers.find((b) => b.id === data.id)
    if (known) {
      // A re-broadcast of an already-known buffer (its lastActivityTs just
      // bumped). Merge the fresh server fields, keeping local-only unread and
      // highlight rather than resetting them.
      this.set({ buffers: buffers.map((b) => (b.id === data.id ? { ...b, ...data } : b)) })
      return
    }
    this.set({ buffers: [...buffers, { unread: 0, highlight: false, ...data }] })
    bestEffort(window.moho.rpc('subscribe', { bufferId: data.id }), `subscribe ${data.id}`)
    // A channel this client had not heard of may already hold mentions in the
    // stored history, so the inbox has to ask again now that the daemon can
    // see it. This is the only moment it can: channels register one at a time
    // as each account finishes connecting, long after the startup fetch.
    if (data.kind === 'channel') this.scheduleMentionsRefresh()
  }

  /**
   * Re-asks for mentions once the channels stop arriving.
   *
   * Debounced because they arrive in a burst - one event per channel, and a
   * Discord account alone can register a few hundred - and running the query
   * once per channel would mean hundreds of identical answers to reach the
   * same list the last one gives.
   */
  private scheduleMentionsRefresh(): void {
    if (this.mentionsTimer) clearTimeout(this.mentionsTimer)
    this.mentionsTimer = setTimeout(() => {
      this.mentionsTimer = null
      void this.refreshMentions()
    }, 1500)
  }

  private handleConnectionState(data: {
    accountId: string
    state: string
    error?: string
    detail?: string
  }): void {
    const { accounts } = this.state

    // Kept only while it explains something. A connected account's last
    // failure is history, and leaving it on screen reads as a current problem.
    const detail = { ...this.state.connectionDetail }
    if (data.detail && data.state !== 'connected') detail[data.accountId] = tidyDetail(data.detail)
    else delete detail[data.accountId]
    this.set({ connectionDetail: detail })
    // Upsert rather than map-update: this connection also observes accounts
    // added elsewhere (nobilis reconnecting saved accounts at startup, another
    // client) that this session's list never had to begin with.
    if (accounts.some((a) => a.id === data.accountId)) {
      this.set({
        accounts: accounts.map((a) => (a.id === data.accountId ? { ...a, state: data.state } : a))
      })
    } else {
      void this.refreshAccounts()
    }
    if (data.error) this.toast('error', `${data.accountId}: ${data.error}`)
  }

  // --- messages -------------------------------------------------------

  /**
   * The one place a buffer's list is replaced, and the one place ids are
   * guaranteed unique.
   *
   * Deduplicated here rather than trusted from the daemon, because the cost of
   * a repeat is out of all proportion to the mistake. The rendered rows are
   * keyed by message id; two rows sharing a key leave React unable to
   * reconcile the list, and switching conversations then strands some of the
   * old one's rows on screen above the new one's - which reads as one
   * channel's history leaking into another's rather than as a duplicate.
   * A message id names a message, so keeping the first of a repeated id loses
   * nothing.
   */
  private setMessages(bufferId: string, list: ChatMessage[]): void {
    const seen = new Set<string>()
    const unique = list.filter((m) => !seen.has(m.id) && (seen.add(m.id), true))
    this.set({ messagesByBuffer: { ...this.state.messagesByBuffer, [bufferId]: unique } })
  }

  /** How much of this buffer to keep, which depends on whether it is in view. */
  private retentionFor(bufferId: string): number {
    return bufferId === this.state.activeBufferId ? MAX_MESSAGES_AFTER_LOADING : MAX_MESSAGES_IDLE
  }

  /**
   * Cuts a conversation back to its tail now that something else is being
   * read.
   *
   * Nothing is lost by this: every message here was written to the daemon's
   * store as it arrived, and reopening the buffer pages it straight back. What
   * it costs is the one thing worth spending - the rest of a long scroll
   * upwards has to be fetched again if the reader returns to it, which is the
   * same fetch they would have made had they never been there.
   */
  private trimIdleBuffer(bufferId: string): void {
    const list = this.state.messagesByBuffer[bufferId]
    if (!list || list.length <= MAX_MESSAGES_IDLE) return
    this.setMessages(bufferId, list.slice(-MAX_MESSAGES_IDLE))
  }

  private mapMessage(
    bufferId: string,
    id: string,
    fn: (m: ChatMessage) => ChatMessage
  ): void {
    const list = this.state.messagesByBuffer[bufferId]
    if (!list) return
    this.setMessages(
      bufferId,
      list.map((m) => (m.id === id ? fn(m) : m))
    )
  }

  private appendMessage(bufferId: string, msg: Message): void {
    const existing = this.state.messagesByBuffer[bufferId] || []
    // nobilis can re-broadcast a message we already hold (a reconnect replaying
    // recent history); appending it again would show a visible duplicate.
    if (existing.some((m) => m.id === msg.id)) return

    const list = [...existing, msg as ChatMessage]
    // The generous ceiling is for the conversation being read, where it stops
    // a jump into history being thrown away by the next person to speak.
    // Everywhere else a message is arriving into a list nobody is looking at.
    this.setMessages(bufferId, list.slice(-this.retentionFor(bufferId)))

    // Being on screen in a window of its own counts as being open, because it
    // is: badging a channel somebody is watching in a second window asks them
    // to go and look at what they are already looking at.
    const isViewingBuffer = this.state.activePanel === '' && bufferId === this.state.activeBufferId
    if (!isViewingBuffer && !this.state.popouts.watched.includes(bufferId)) {
      const buffer = this.state.buffers.find((b) => b.id === bufferId)
      this.set({
        buffers: this.state.buffers.map((b) =>
          b.id === bufferId
            ? { ...b, unread: b.unread + 1, highlight: b.highlight || !!msg.isHighlight }
            : b
        )
      })
      // Channels only, matching the daemon's own rule for the seeded list: a
      // direct message is addressed to you in its entirety, so "mentioned"
      // adds nothing there, and it already has its own page and rail tile.
      //
      // Inside the not-the-open-buffer guard deliberately. A mention that
      // arrives in the conversation being read has been read, and badging an
      // inbox for it would ask someone to go and look at what is already in
      // front of them.
      if (msg.isHighlight && !msg.isOwn && buffer?.kind === 'channel') {
        this.set({ mentions: [msg, ...this.state.mentions].slice(0, MAX_MENTIONS) })
      }
    }
  }

  /**
   * Opens a buffer.
   *
   * `followGroup` moves the rail to wherever the buffer lives. That is right
   * for a selection arriving from outside the list - a notification click, a
   * freshly joined channel, the restored buffer at startup - which would
   * otherwise open something the sidebar isn't showing.
   *
   * It is wrong for a click on a row in the list, because that row is by
   * definition already on the page being shown. Following there dragged the
   * rail off the pinned and direct message pages onto whichever guild happened
   * to own the conversation, which is the opposite of what those pages are for.
   */
  async selectBuffer(bufferId: string, followGroup = true): Promise<void> {
    if (!this.state.buffers.some((b) => b.id === bufferId)) return
    // A popped-out window is one conversation, and quietly replacing it would
    // turn somebody's monitor for #channel into something else while they were
    // not looking at it. But the things that reach here in such a window are
    // all deliberate - opening a direct message with someone in the member
    // list, following a channel link in something they said - so the answer is
    // a window of its own rather than nothing happening.
    if (this.state.pinnedBufferId && bufferId !== this.state.pinnedBufferId) {
      this.popOut(bufferId)
      return
    }

    // Snapshot the divider before clearing unread, so the "New messages" line
    // lands where the user actually left off rather than at the bottom.
    const buffer = this.state.buffers.find((b) => b.id === bufferId)!
    const leaving = this.state.activeBufferId
    const dividerTs = this.state.dividerTsByBuffer[bufferId]
    const patch: Partial<ChatState> = {
      activeBufferId: bufferId,
      activePanel: '',
      replyingTo: null,
      buffers: this.state.buffers.map((b) =>
        b.id === bufferId ? { ...b, unread: 0, highlight: false } : b
      )
    }
    if (dividerTs === undefined && buffer.unread > 0) {
      const list = this.state.messagesByBuffer[bufferId] || []
      const firstUnread = list.length >= buffer.unread ? list[list.length - buffer.unread] : list[0]
      patch.dividerTsByBuffer = {
        ...this.state.dividerTsByBuffer,
        [bufferId]: firstUnread ? firstUnread.ts - 1 : 0
      }
    }
    this.set(patch)

    // The conversation just left goes back to holding a screenful. Done here
    // rather than on a timer because this is the moment its size stops being
    // anybody's business: it is no longer drawn, and what a reader who comes
    // back wants is the recent end of it, which is what it keeps.
    if (leaving && leaving !== bufferId) this.trimIdleBuffer(leaving)

    // Which conversation to reopen at startup is the main window's to
    // remember. A popout writing its own here would decide it for everyone.
    if (!this.state.pinnedBufferId) void window.moho.prefs.set('ui.activeBufferId', bufferId)
    if (followGroup && !this.state.pinnedBufferId) {
      const buffer = this.state.buffers.find((b) => b.id === bufferId)
      // A direct message's home group is the per-account one nobilis reports,
      // which the rail folds away in favour of the single cross-service page.
      // Selecting the folded id would land on a group with no tile, and the
      // pane falls back to the first entry - which is how a Discord DM opened
      // an unrelated guild.
      const group = buffer && isDirectMessage(buffer) ? DM_GROUP_ID : buffer?.groupId
      if (group && group !== this.state.activeGroupId) this.selectGroup(group)
    }
    void window.moho.markBufferRead(bufferId)
    bestEffort(this.markRead(bufferId), 'mark read')
    // And tell the service, where the service has anywhere to put it, so a
    // conversation read here stops being unread on somebody's phone. A no-op
    // on protocols with no read state, so it needs no test of which this is.
    bestEffort(this.ackRead(bufferId), 'ack read')
    bestEffort(window.moho.rpc('subscribe', { bufferId }), `subscribe ${bufferId}`)

    // Discord only sends a member list for the channel being looked at, and
    // answers per guild rather than per channel - so this is asked for on
    // open, one channel at a time, rather than for everything subscribed.
    bestEffort(window.moho.rpc('requestMemberList', { bufferId }), 'member list')

    if (!this.state.loadedBuffers[bufferId]) await this.loadBacklog(bufferId)
    void this.refreshMatrixPermissions(bufferId)

    const service = this.accountFor(bufferId)?.service
    if (service === 'sneedchat') void this.fetchSmilies()
    // Both services answer the same question about the open conversation -
    // what can go in a message here that isn't text - so both ask it the same
    // way. Kick's answer also depends on who is asking, since it carries which
    // of the streamer's emotes this account is subscribed to.
    if (service === 'discord' || service === 'kick') void this.fetchBufferEmoji(bufferId)
  }

  /**
   * nobilis returns a bare filename per smiley - the table is bundled with the
   * client, not fetched from the site, so resolving it against our own
   * resource directory is the client's job. Fetched once per session.
   */
  private smiliesFetched = false

  private async fetchSmilies(): Promise<void> {
    if (this.smiliesFetched) return
    this.smiliesFetched = true
    try {
      const [rows, dir] = await Promise.all([
        window.moho.rpc<SneedchatSmilie[]>('listSneedchatSmilies'),
        window.moho.smiliesDir()
      ])
      const smilies: SmilieEntry[] = rows.map((s) => ({
        ...s,
        url: resolveMediaUrl(`${dir}/${s.file}`)
      }))
      this.set({ smilies, smilieIndex: buildSmilieIndex(smilies) })
    } catch (e) {
      // Non-fatal: shortcodes just stay as plain text.
      console.warn('[smilies] fetch failed:', (e as Error).message)
      this.smiliesFetched = false
    }
  }

  private async fetchBufferEmoji(bufferId: string): Promise<void> {
    if (this.state.bufferEmoji[bufferId]) return
    try {
      const emoji = await window.moho.rpc<CustomEmoji[]>('listBufferEmoji', { bufferId })
      this.set({ bufferEmoji: { ...this.state.bufferEmoji, [bufferId]: emoji } })
    } catch {
      /* a guild with no custom emoji, or a buffer nobilis has no emoji for */
    }
  }

  /**
   * Asks nobilis to re-sign a Discord message's attachment links, which it
   * does by fetching the message again. Resolves to the fresh attachments;
   * the store is updated by the messageUpdated the daemon broadcasts.
   */
  async refreshAttachments(bufferId: string, messageId: string): Promise<void> {
    await window.moho.rpc('refreshDiscordAttachments', { bufferId, messageId })
  }

  /**
   * Opens the real Discord message in a browser - the last resort when even
   * a refresh cannot produce a working link.
   */
  async openInDiscord(bufferId: string, messageId: string): Promise<void> {
    try {
      const { url } = await window.moho.rpc<{ url: string }>('getDiscordMessageLink', {
        bufferId,
        messageId
      })
      void window.moho.openExternal(url)
    } catch (e) {
      this.toast('error', (e as Error).message)
    }
  }

  /**
   * Marks everything in a set of buffers as read.
   *
   * One preference write rather than one per buffer: a folder can hold a
   * dozen servers with hundreds of channels between them, and writing the
   * file that many times would be slow and would leave it half-updated if
   * anything failed midway.
   */
  async markBuffersRead(bufferIds: string[]): Promise<void> {
    if (bufferIds.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    try {
      const prefs = await window.moho.prefs.getAll()
      const lastReadTs = { ...((prefs.lastReadTs as Record<string, number>) || {}) }
      for (const id of bufferIds) {
        lastReadTs[id] = now
        void window.moho.markBufferRead(id)
      }
      void window.moho.prefs.set('lastReadTs', lastReadTs)
      this.set({ lastReadTs })
      // The counters are this client's own tally, so they have to be cleared
      // here too - the stored timestamp only decides what counts next time.
      this.set({
        buffers: this.state.buffers.map((b) =>
          bufferIds.includes(b.id) ? { ...b, unread: 0, highlight: false } : b
        )
      })
    } catch (e) {
      this.toast('error', `Couldn't mark as read: ${(e as Error).message}`)
    }
  }

  /**
   * What this account is called in this conversation, for a message being
   * sent before the service has said anything about it.
   *
   * Read from the last message you sent here rather than from the account's
   * display name, because those are not the same string and the difference
   * shows. An IRC account with no display name set reports its own id -
   * "nick@irc.example.org" - while the daemon records what you say under the
   * bare nick, so the echo was labelled with one and its replacement with the
   * other. It also broke grouping, since that compares author names: the
   * message you just sent would not group with the one before it, and then
   * would the moment it landed.
   *
   * The account's own identity is the fallback for the first thing ever said
   * in a buffer, where there is nothing to copy.
   */
  private ownNameIn(bufferId: string): string {
    const list = this.state.messagesByBuffer[bufferId] || []
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].isOwn && !list[i].pending && list[i].from) return list[i].from
    }
    const account = this.accountFor(bufferId)
    // The identity the service knows, not the local rename: this name is
    // compared against the echo when it lands, and a locally renamed one
    // would never match its own message.
    return account?.currentNick || account?.displayName || 'me'
  }

  private async markRead(bufferId: string): Promise<void> {
    const prefs = await window.moho.prefs.getAll()
    const lastReadTs = { ...((prefs.lastReadTs as Record<string, number>) || {}) }
    lastReadTs[bufferId] = Math.floor(Date.now() / 1000)
    void window.moho.prefs.set('lastReadTs', lastReadTs)
    this.set({ lastReadTs })
  }

  private async loadBacklog(bufferId: string): Promise<void> {
    try {
      const rows = await window.moho.rpc<Message[]>('getBacklog', { bufferId, before: 0, limit: BACKLOG_PAGE })
      const live = this.state.messagesByBuffer[bufferId] || []
      // Anything that arrived live while this fetch was in flight must survive
      // it - merge by id rather than replacing wholesale.
      const seen = new Set(rows.map((r) => r.id))
      const merged = [...rows, ...live.filter((m) => !seen.has(m.id))] as ChatMessage[]
      merged.sort((a, b) => a.ts - b.ts)
      this.setMessages(bufferId, merged.slice(-MAX_MESSAGES_PER_BUFFER))
      this.set({ loadedBuffers: { ...this.state.loadedBuffers, [bufferId]: true } })
    } catch (e) {
      this.toast('error', `Couldn't load history: ${(e as Error).message}`)
    }
  }

  /**
   * Loads backwards until a particular message is on screen.
   *
   * Search reads the whole stored conversation while the view holds only the
   * most recent slice of it, so a result from last month used to be findable
   * and unreachable at once - which raises the fair question of why it was
   * offered as a result at all.
   *
   * Paging backwards rather than fetching a window around the message: it
   * reuses the load-more path exactly, including the part that holds the
   * reading position while older messages are prepended, and for Discord that
   * same path pulls further history from the server, so a result older than
   * anything stored locally is still reachable. Bounded, because a message
   * that is genuinely thousands back is better refused than chased forever.
   *
   * Returns whether it got there.
   */
  async jumpToMessage(bufferId: string, messageId: string): Promise<boolean> {
    const loaded = (): boolean =>
      (this.state.messagesByBuffer[bufferId] || []).some((m) => m.id === messageId)
    if (loaded()) return true

    // Where the service will hand over one moment of a conversation, ask for
    // it rather than walking to it. Paging backwards through a busy Discord
    // channel to reach a pin from last year means dozens of round trips and
    // thousands of messages nobody asked to see - and it gave up before it
    // arrived, which is what "that message could not be reached" was.
    if (canFetchAround(bufferId)) return await this.fetchAround(bufferId, messageId)

    for (let page = 0; page < 12; page++) {
      const before = (this.state.messagesByBuffer[bufferId] || []).length
      await this.loadMoreHistory(bufferId)
      if (loaded()) return true
      // Nothing came back, so there is nothing older to find it in.
      if ((this.state.messagesByBuffer[bufferId] || []).length === before) return false
    }
    return loaded()
  }

  /**
   * Asks the service for the part of the conversation one message is in, and
   * puts it on screen.
   *
   * The window comes back with the call rather than being paged to afterwards:
   * however much history lies between here and there is beside the point,
   * because the reader is not going to read it. What lands is the message with
   * the conversation either side of it, above what was already on screen - so
   * the log reads as that moment, and then the present.
   */
  private async fetchAround(bufferId: string, messageId: string): Promise<boolean> {
    // The same flag scrolling up sets, so the same strip says so: this is a
    // round trip to the service and the reader is looking at a log that does
    // not visibly change until it lands.
    this.set({ loadingMore: { ...this.state.loadingMore, [bufferId]: true } })
    try {
      const answer = await window.moho.rpc<{ ts: number; messages: Message[] }>(
        'loadMessageContext',
        { bufferId, messageId }
      )
      const current = this.state.messagesByBuffer[bufferId] || []
      const seen = new Set(current.map((m) => m.id))
      const added = (answer.messages || []).filter((m) => !seen.has(m.id)) as ChatMessage[]
      if (added.length) {
        const merged = [...added, ...current]
        merged.sort((a, b) => a.ts - b.ts)
        this.setMessages(bufferId, merged)
        // Where the fetched moment stops and the log jumps to whatever was
        // already loaded. Only when something follows it: a window that
        // reaches the present has no hole after it.
        const last = added[added.length - 1]
        const follows = merged.findIndex((m) => m.id === last.id) < merged.length - 1
        if (follows) {
          this.set({ historyGapAfter: { ...this.state.historyGapAfter, [bufferId]: last.id } })
        }
      }
    } catch (e) {
      // Said rather than swallowed: "nothing happened when I clicked it" is
      // the complaint this whole path exists to answer.
      this.toast('error', `Couldn't reach that message: ${(e as Error).message}`)
      return false
    } finally {
      const loadingMore = { ...this.state.loadingMore }
      delete loadingMore[bufferId]
      this.set({ loadingMore })
    }
    return (this.state.messagesByBuffer[bufferId] || []).some((m) => m.id === messageId)
  }

  /**
   * Reads forward from the hole a jump left, and closes it when it meets what
   * is already on screen.
   *
   * Asked for by scrolling down into the gap rather than done as part of the
   * jump: the reader who wants the conversation that followed will go looking
   * for it, and the reader who was only checking one pinned message will not -
   * fetching the week in between for both would be the walk that arriving
   * directly exists to avoid.
   */
  async loadNewerHistory(bufferId: string): Promise<void> {
    const afterId = this.state.historyGapAfter[bufferId]
    if (!afterId || this.state.loadingNewer[bufferId]) return
    const list = this.state.messagesByBuffer[bufferId] || []
    const edge = list.find((m) => m.id === afterId)
    if (!edge) return

    this.set({ loadingNewer: { ...this.state.loadingNewer, [bufferId]: true } })
    try {
      const answer = await window.moho.rpc<{ added: number }>('loadNewerMessages', {
        bufferId,
        messageId: afterId
      })
      const rows = await window.moho.rpc<Message[]>('getBacklog', {
        bufferId,
        after: edge.ts,
        limit: BACKLOG_PAGE
      })
      const current = this.state.messagesByBuffer[bufferId] || []
      const seen = new Set(current.map((m) => m.id))
      const fresh = rows.filter((m) => !seen.has(m.id)) as ChatMessage[]
      if (fresh.length) {
        const merged = [...current, ...fresh]
        merged.sort((a, b) => a.ts - b.ts)
        this.setMessages(bufferId, merged)
      }
      // The hole is closed when the service has nothing more to give, or when
      // what came back runs into what was already here - either way there is
      // no longer anything missing between this message and the next.
      const met = rows.some((m) => seen.has(m.id))
      const gap = { ...this.state.historyGapAfter }
      if (answer.added === 0 || met || !fresh.length) delete gap[bufferId]
      else gap[bufferId] = fresh[fresh.length - 1].id
      this.set({ historyGapAfter: gap })
    } catch (e) {
      this.toast('error', `Couldn't load the rest: ${(e as Error).message}`)
    } finally {
      const loadingNewer = { ...this.state.loadingNewer }
      delete loadingNewer[bufferId]
      this.set({ loadingNewer })
    }
  }

  async loadMoreHistory(bufferId: string): Promise<void> {
    if (this.state.loadingMore[bufferId]) return
    const list = this.state.messagesByBuffer[bufferId] || []
    const oldest = list.find((m) => !m.pending)
    if (!oldest) return

    this.set({ loadingMore: { ...this.state.loadingMore, [bufferId]: true } })
    try {
      const rows = await window.moho.rpc<Message[]>('getBacklog', {
        bufferId,
        before: oldest.ts,
        limit: BACKLOG_PAGE
      })
      if (rows.length) {
        const current = this.state.messagesByBuffer[bufferId] || []
        const seen = new Set(current.map((m) => m.id))
        const older = rows.filter((r) => !seen.has(r.id)) as ChatMessage[]
        this.setMessages(bufferId, [...older, ...current])
      }
    } catch (e) {
      this.toast('error', `Couldn't load older messages: ${(e as Error).message}`)
    } finally {
      const loadingMore = { ...this.state.loadingMore }
      delete loadingMore[bufferId]
      this.set({ loadingMore })
    }
  }

  // --- sending --------------------------------------------------------

  /**
   * Optimistic local echo, the way Discord's own client does it: the message
   * appears dimmed the instant the user hits send, keyed by a client-generated
   * id since nobilis hasn't assigned a real one yet. It stays that way until
   * either the real "message" event echoes it back (reconcileOwnEcho) or the
   * timeout sweep gives up on it.
   */
  async sendMessage(bufferId: string, body: string, attachmentPath?: string): Promise<void> {
    // A fresh send takes its reply target from the composer, and consumes it.
    const reply = this.state.replyingTo
    this.set({ replyingTo: null })
    return this.dispatchSend(bufferId, body, reply, attachmentPath)
  }

  /**
   * The actual send, with everything it needs passed in rather than read from
   * current state.
   *
   * That distinction is the whole point: a retry happens some time after the
   * failure, by which point the composer's reply target has been cleared - and
   * may have been replaced by a different one. Reading it live meant a retried
   * message lost its reply, or worse, silently acquired someone else's.
   */
  private async dispatchSend(
    bufferId: string,
    body: string,
    reply: { id: string; from: string; body: string; thread?: boolean } | null,
    attachmentPath?: string
  ): Promise<void> {
    if (!body.trim() && !attachmentPath) return
    const replyToId = reply?.id
    const clientId = `pending-${++this.sendSeq}-${Date.now()}`
    const account = this.accountFor(bufferId)

    const echo: ChatMessage = {
      id: clientId,
      bufferId,
      from: this.ownNameIn(bufferId),
      body,
      ts: Math.floor(Date.now() / 1000),
      isAction: false,
      isHighlight: false,
      // A real chat kind, and not the "privmsg" this used to invent: nothing
      // anywhere produces that word, so isChatKind rejected it and every
      // message being sent was drawn as a system line - no avatar column, an
      // italic grey body, never grouped, and in bubbles mode on the wrong
      // side of the pane. It then jumped into place the moment the daemon's
      // own copy replaced it.
      //
      // "chat" and "message" are the two spellings the backends use and the
      // renderer treats them alike, so either does; this is not claiming to
      // be the one this account's service will send.
      kind: 'chat',
      isOwn: true,
      // Your own face, so the picture is there from the first frame rather
      // than a coloured initial that swaps to a photograph on arrival.
      ...(account?.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
      pending: true,
      pendingBody: body,
      pendingReplyTo: replyToId,
      pendingAttachment: attachmentPath,
      ...(reply ? { replyTo: reply } : {})
    }
    // Warn before the message rather than after it. On IRC a message to
    // somebody who is not connected is accepted by the server and thrown
    // away - there is no bounce, no queue and no delivery later - so without
    // saying so the conversation looks like it worked.
    const warning = this.undeliverableNotice(bufferId)
    if (warning) this.appendMessage(bufferId, warning)

    this.appendMessage(bufferId, echo)
    this.pendingSends.set(clientId, { bufferId, ts: Date.now() })

    try {
      await window.moho.rpc('sendMessage', {
        bufferId,
        body,
        // Where a file goes on a service that cannot carry one. Read at send
        // time rather than held in state: it is a preference somebody may
        // change between one message and the next, and the daemon falls back
        // to its own default if this is absent or unknown to it.
        ...(attachmentPath
          ? { attachmentPath, uploadHost: await uploadHost(account?.service, attachmentPath) }
          : {}),
        ...(replyToId ? { replyToId } : {}),
        // Into the thread rather than at the message: the daemon needs to be
        // told which, because Matrix says them with the same field.
        ...(reply?.thread ? { thread: true } : {})
      })
      // Success alone doesn't resolve the echo - only the real message event
      // does, since that's what carries nobilis's own id and timestamp.
    } catch (e) {
      this.markSendFailed(clientId, (e as Error).message)
    }
  }

  /**
   * A note that what is about to be sent will not arrive, or nothing.
   *
   * Only where the protocol genuinely discards it. Discord and Matrix hold a
   * message for someone who is offline and deliver it when they return, so
   * warning there would be false; IRC does not, and Sneedchat's rooms are not
   * conversations that can be missed in this way.
   */
  private undeliverableNotice(bufferId: string): ChatMessage | null {
    const buffer = this.state.buffers.find((b) => b.id === bufferId)
    const account = this.accountFor(bufferId)
    if (!buffer || buffer.kind !== 'dm' || account?.service !== 'irc') return null

    const roster = this.state.presenceByBuffer[bufferId]
    // Absent presence is not evidence of absence: say nothing until the poll
    // has actually answered for this person.
    if (roster?.length !== 1 || roster[0].status !== 'offline') return null

    return {
      id: `notice-${++this.sendSeq}-${Date.now()}`,
      bufferId,
      from: '',
      body: `${buffer.name} is offline and will not receive this message.`,
      ts: Math.floor(Date.now() / 1000),
      isAction: false,
      isHighlight: false,
      kind: 'notice',
      isOwn: false
    }
  }

  /**
   * Matches an inbound own-message against an outstanding optimistic echo by
   * body, replacing it in place. Returns true when it consumed one, so the
   * caller knows not to also append the message as new.
   */
  private reconcileOwnEcho(real: Message): boolean {
    for (const [clientId, info] of this.pendingSends) {
      if (info.bufferId !== real.bufferId) continue
      const list = this.state.messagesByBuffer[info.bufferId] || []
      const echo = list.find((m) => m.id === clientId)
      if (!echo || !echoMatches(echo, real)) continue
      this.pendingSends.delete(clientId)
      this.setMessages(
        info.bufferId,
        list.map((m) => (m.id === clientId ? (real as ChatMessage) : m))
      )
      return true
    }
    return false
  }

  private markSendFailed(clientId: string, errorText: string): void {
    const info = this.pendingSends.get(clientId)
    if (!info) return
    // Kept in pendingSends deliberately: a late echo can still resolve an
    // already-failed row rather than leaving a permanent phantom failure.
    this.mapMessage(info.bufferId, clientId, (m) => ({
      ...m,
      pending: false,
      failed: true,
      errorText
    }))
  }

  private sweepPendingSends(): void {
    const now = Date.now()
    for (const [clientId, info] of this.pendingSends) {
      if (now - info.ts < SEND_TIMEOUT_MS) continue
      const list = this.state.messagesByBuffer[info.bufferId] || []
      const echo = list.find((m) => m.id === clientId)
      if (echo?.pending) this.markSendFailed(clientId, 'timed out')
    }
  }

  retrySend(clientId: string): void {
    const info = this.pendingSends.get(clientId)
    if (!info) return
    const list = this.state.messagesByBuffer[info.bufferId] || []
    const echo = list.find((m) => m.id === clientId)
    if (!echo) return
    this.pendingSends.delete(clientId)
    this.setMessages(info.bufferId, list.filter((m) => m.id !== clientId))
    // Resend exactly what was sent: the original reply target and file, not
    // whatever the composer happens to hold now.
    void this.dispatchSend(
      info.bufferId,
      echo.pendingBody || echo.body,
      echo.replyTo ?? null,
      echo.pendingAttachment
    )
  }

  async editMessage(bufferId: string, messageId: string, body: string): Promise<void> {
    try {
      await window.moho.rpc('editMessage', { bufferId, messageId, body })
    } catch (e) {
      this.toast('error', `Edit failed: ${(e as Error).message}`)
    }
  }

  async deleteMessage(bufferId: string, messageId: string): Promise<void> {
    try {
      await window.moho.rpc('deleteMessage', { bufferId, messageId })
    } catch (e) {
      this.toast('error', `Delete failed: ${(e as Error).message}`)
    }
  }

  /**
   * Reacting, shown immediately rather than when the service agrees.
   *
   * The pill used to change only when the gateway echoed the reaction back,
   * which made a click on a reaction-role message look like it had done
   * nothing at all: those bots take the reaction off again the moment they
   * grant the role, so the add and the removal both arrive and the row ends
   * up exactly as it started. People click again, and again.
   *
   * Showing it at once separates "this did not register" from "this
   * happened and was undone by somebody else" - and a failure puts the row
   * back, so an optimistic view never outlives being wrong.
   */
  async toggleReaction(bufferId: string, messageId: string, emoji: string, add: boolean): Promise<void> {
    const before = this.state.messagesByBuffer[bufferId]?.find((m) => m.id === messageId)?.reactions
    this.mapMessage(bufferId, messageId, (m) => ({
      ...m,
      reactions: applyOwnReaction(m.reactions ?? [], emoji, add)
    }))
    try {
      await window.moho.rpc('toggleReaction', { bufferId, messageId, emoji, add })
    } catch (e) {
      this.mapMessage(bufferId, messageId, (m) => ({ ...m, reactions: before }))
      this.toast('error', (e as Error).message)
    }
  }

  // --- misc -----------------------------------------------------------

  accountFor(bufferId: string): Account | undefined {
    const buffer = this.state.buffers.find((b) => b.id === bufferId)
    return buffer && this.state.accounts.find((a) => a.id === buffer.accountId)
  }

  setActivePanel(panel: ActivePanel, joinPanelAccountId = ''): void {
    this.set({ activePanel: panel, joinPanelAccountId })
  }

  startReply(id: string, from: string, body: string): void {
    this.set({ replyingTo: { id, from, body } })
  }

  cancelReply(): void {
    this.set({ replyingTo: null })
  }

  /**
   * Aims the next message at one person, privately.
   *
   * Armed the way a reply is rather than asking for the text in a dialog: what
   * you are about to whisper is written the same way as anything else, with
   * the same box and the same history, and the only difference is where it
   * goes. Clears any reply, since a whisper is not a reply to the room.
   */
  startWhisper(target: string): void {
    this.set({ whisperingTo: target, replyingTo: null })
  }

  cancelWhisper(): void {
    this.set({ whisperingTo: null })
  }

  /**
   * Matrix rooms only, fetched once per buffer. Permissions rarely change
   * mid-session, and a stale cache is only ever advisory - the homeserver
   * still validates the action regardless of what's cached here.
   */
  private async refreshMatrixPermissions(bufferId: string): Promise<void> {
    if (this.state.matrixPermissions[bufferId]) return
    const account = this.accountFor(bufferId)
    if (account?.service !== 'matrix') return
    try {
      const perms = await window.moho.rpc<RoomPermissions>('getMatrixRoomPermissions', {
        accountId: account.id,
        bufferId
      })
      this.set({ matrixPermissions: { ...this.state.matrixPermissions, [bufferId]: perms } })
    } catch {
      /* advisory only - a failure just means no moderation actions are offered */
    }
  }

  async closeBuffer(bufferId: string): Promise<void> {
    try {
      await window.moho.rpc('partBuffer', { bufferId })
      if (this.state.activeBufferId === bufferId) this.set({ activeBufferId: '' })
    } catch (e) {
      this.toast('error', (e as Error).message)
    }
  }

  toast(kind: 'info' | 'error', text: string): void {
    const id = ++this.toastSeq
    this.set({ toasts: [...this.state.toasts, { id, kind, text }] })
    setTimeout(() => {
      this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) })
    }, 6000)
  }

  dismissToast(id: number): void {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) })
  }

  setDiscordLoginStatus(status: string): void {
    this.set({ discordLoginStatus: status, discordQrPath: '' })
  }

  /** Begin (or clear) a re-authentication of an existing Discord account. */
  setDiscordReauth(accountId: string): void {
    this.set({
      discordReauthAccountId: accountId,
      discordQrPath: '',
      discordLoginStatus: '',
      discordMfa: null
    })
  }

  clearDiscordMfa(): void {
    this.set({ discordMfa: null })
  }
  setSneedChatLoginStatus(status: string): void {
    this.set({ sneedChatLoginStatus: status })
  }
  setMatrixLoginStatus(status: string): void {
    this.set({ matrixLoginStatus: status })
  }
}

export const store = new ChatStore()
