import type { MatrixInvite, BufferGroup } from '../../../shared/wire'
import type { BufferEntry } from '../state/store'

/**
 * A rail entry as the UI knows it: everything nobilis reports, plus the
 * pinned page this app synthesises. Kept as a superset here rather than
 * widening the wire type, which should only describe what the daemon
 * actually sends.
 */
export type RailGroup = Omit<BufferGroup, 'kind'> & {
  kind: BufferGroup['kind'] | 'pinned' | 'invite'
}

/**
 * The rail entry for a room somebody has invited you to.
 *
 * A tile of its own rather than a mark on the account's, because that is what
 * it behaves like: it arrives on its own, it is answered once, and then it is
 * gone. A badge on an account tile would still be there after the answer,
 * saying nothing, until something else redrew it.
 */
export const INVITE_PREFIX = 'invite:'

export function inviteGroupId(accountId: string, roomId: string): string {
  return `${INVITE_PREFIX}${accountId}|${roomId}`
}

/** The account and room an invite entry stands for, or null. */
export function readInviteGroupId(groupId: string): { accountId: string; roomId: string } | null {
  if (!groupId.startsWith(INVITE_PREFIX)) return null
  const rest = groupId.slice(INVITE_PREFIX.length)
  const split = rest.indexOf('|')
  if (split < 0) return null
  return { accountId: rest.slice(0, split), roomId: rest.slice(split + 1) }
}

export function inviteGroup(accountId: string, invite: MatrixInvite): RailGroup {
  return {
    id: inviteGroupId(accountId, invite.roomId),
    accountId,
    service: 'matrix',
    kind: 'invite',
    name: invite.name,
    iconUrl: invite.avatarUrl ?? undefined,
    // Ahead of everything, including direct messages: it is the only entry
    // in the rail that expires if nobody answers it.
    position: -2000
  } as RailGroup
}

/**
 * The rail entry collecting pinned buffers from every service.
 *
 * Client-side rather than a nobilis group: pinning is a preference this app
 * owns, not something the daemon knows or should know about. It is given a
 * group id anyway so selection, persistence and the channel pane all treat it
 * exactly like any other entry.
 */
export const PINNED_GROUP_ID = '~pinned'

/**
 * The rail entry collecting direct messages from every service.
 *
 * Synthesised here rather than taken from nobilis for the same reason as
 * pinned: the daemon reports one DM group per account that has them, which is
 * correct as a statement about Discord's own grouping but would put an IRC
 * query under the IRC tile and a Matrix DM under the Matrix tile. A person
 * messaging you is a person messaging you, whichever network carried it, so
 * the rail folds them into one page and suppresses the per-account ones.
 */
export const DM_GROUP_ID = '~dms'

export function dmGroup(): RailGroup {
  return {
    id: DM_GROUP_ID,
    accountId: '',
    service: '',
    kind: 'dms',
    name: 'Direct Messages',
    position: -1000
  }
}

/** Whether a buffer belongs on the cross-service direct messages page. */
export function isDirectMessage(buffer: BufferEntry): boolean {
  return buffer.kind === 'dm'
}

export function pinnedGroup(): RailGroup {
  return {
    id: PINNED_GROUP_ID,
    accountId: '',
    service: '',
    kind: 'pinned',
    name: 'Pinned',
    position: -900,
  }
}

/**
 * The rail entries worth drawing.
 *
 * An account entry is the home for buffers no backend grouped, which is how
 * IRC, Sneedchat and Matrix reach the rail at all. Discord never puts anything
 * there - every channel belongs to a guild and every DM to the DM entry - so
 * its account entry would be a tile that opens an empty pane.
 *
 * Emptiness alone is not enough to hide one: IRC and Sneedchat have no buffers
 * either until they finish connecting, and Sneedchat's Tor bootstrap makes
 * that several seconds. So an account with nothing anywhere yet keeps its
 * tile, and only one whose buffers all live elsewhere loses it.
 *
 * Shared by the rail and the channel pane deliberately - if they disagreed,
 * the selected group could be one with no tile, leaving a pane the user cannot
 * navigate away from.
 */
export function visibleGroups(groups: BufferGroup[], buffers: BufferEntry[]): BufferGroup[] {
  const inGroup = new Map<string, number>()
  const inAccount = new Map<string, number>()
  for (const b of buffers) {
    inAccount.set(b.accountId, (inAccount.get(b.accountId) ?? 0) + 1)
    if (b.groupId) inGroup.set(b.groupId, (inGroup.get(b.groupId) ?? 0) + 1)
  }
  return groups.filter((g) => {
    // Folded into the one cross-service direct messages page.
    if (g.kind === 'dms') return false
    if (g.kind !== 'account') return true
    if ((inGroup.get(g.id) ?? 0) > 0) return true
    return (inAccount.get(g.accountId) ?? 0) === 0
  })
}

/** Entries the user cannot drag, and which always lead the rail. */
export function isFixedEntry(group: RailGroup): boolean {
  return group.kind === 'dms' || group.kind === 'pinned' || group.kind === 'invite'
}

/**
 * The rail in display order: direct messages, then pinned, then everything
 * else in whatever order the user dragged them into.
 *
 * `order` holds only what has been dragged. Anything absent - a guild joined
 * since, or a rail never rearranged - keeps nobilis's own ordering and sorts
 * after what has been placed, so a new server appears at the end rather than
 * silently rearranging a rail the user already arranged.
 */
export function orderedGroups(groups: RailGroup[], order: string[]): RailGroup[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  // Direct messages, then pinned. Stated as a rule rather than left to the
  // position numbers, which are the backend's business and were never meant
  // to encode this.
  const leadRank = (g: RailGroup): number => (g.kind === 'dms' ? 0 : 1)
  const lead = groups
    .filter(isFixedEntry)
    .sort((a, b) => leadRank(a) - leadRank(b) || a.position - b.position)
  const rest = groups.filter((g) => !isFixedEntry(g))

  rest.sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.position - b.position || a.name.localeCompare(b.name)
  })
  return [...lead, ...rest]
}

/**
 * The order to persist after dragging `draggedId` onto `targetId`.
 *
 * Returns the full sequence of movable entries rather than a sparse edit, so
 * the saved order stays meaningful even as guilds come and go.
 */
export function reorder(groups: RailGroup[], draggedId: string, targetId: string): string[] {
  const movable = groups.filter((g) => !isFixedEntry(g)).map((g) => g.id)
  const from = movable.indexOf(draggedId)
  const to = movable.indexOf(targetId)
  if (from === -1 || to === -1 || from === to) return movable
  movable.splice(to, 0, movable.splice(from, 1)[0])
  return movable
}


/** How a folder names itself while being dragged, so it is not read as a server. */
export const FOLDER_DRAG_PREFIX = 'folder:'

/**
 * The order to persist after dragging a whole folder onto `targetId`.
 *
 * A folder has no place of its own in the saved order - that list holds
 * servers, and a folder is drawn wherever the first of its members falls. So
 * moving one means moving its members as a block, which is also what keeps the
 * folder from being torn in half by the move.
 */
export function reorderFolder(
  groups: RailGroup[],
  folder: RailFolder,
  targetId: string
): string[] {
  const movable = groups.filter((g) => !isFixedEntry(g)).map((g) => g.id)
  // In the folder's own order, which is the one somebody set by filling it.
  const block = folder.members.filter((id) => movable.includes(id))
  if (block.length === 0) return movable

  const rest = movable.filter((id) => !block.includes(id))
  // Dropping a folder onto something inside itself would mean inserting the
  // block relative to a member of the block, which has no answer.
  if (block.includes(targetId)) return movable

  const at = rest.indexOf(targetId)
  if (at === -1) return movable
  rest.splice(at, 0, ...block)
  return rest
}

/**
 * Whether a buffer is muted, on its own account or by the rail entry it sits
 * under.
 *
 * Muting a buffer mutes that buffer and nothing else - including the server
 * buffer, which used to cascade to every channel on the account. The cascade
 * was wrong for the case that makes muting a server buffer worth doing at
 * all: an IRC network chatters through its whole connection, and some of that
 * chatter carries your nick, so the notices fire. Silencing it should not be
 * a choice between "hear the MOTD" and "hear nothing on this network".
 *
 * Muting a whole network is still one action - it is the rail tile's mute,
 * which is the deliberate way to say it and is always undoable from a tile
 * that is always on screen.
 *
 * Shared by the rail and the channel pane for the same reason the visibility
 * rule is: they disagreed before, and the rail counted unread from muted
 * buffers while the rows underneath refused to badge them - so a tile could
 * read 40 waiting with nothing beneath it to explain where.
 */
export function isMutedBuffer(
  buffer: BufferEntry,
  muted: string[],
  mutedGroups: string[] = []
): boolean {
  // An explicit mute on this buffer always stands.
  if (muted.includes(buffer.id)) return true

  // And so does one made on the account itself - a Discord server silenced in
  // the official client, a Matrix room silenced by a push rule. Every other
  // device signed in to that account is already keeping quiet about it.
  if (buffer.serverMuted) return true

  // A muted server, guild or space silences everything under it.
  return !!buffer.groupId && mutedGroups.includes(buffer.groupId)
}

/**
 * The buffers whose unread should reach a rail tile: what the pane below it
 * would actually list. A hidden buffer has no row to click through to, and a
 * muted one deliberately does not ask for attention.
 */
export function countsTowardRail(
  buffer: BufferEntry,
  muted: string[],
  hidden: string[],
  mutedGroups: string[] = []
): boolean {
  return !hidden.includes(buffer.id) && !isMutedBuffer(buffer, muted, mutedGroups)
}


/**
 * A folder in the rail: several servers behind one tile.
 *
 * Entirely this client's idea. Discord has folders of its own, but they are
 * per-account and say nothing about the Matrix spaces or IRC networks sitting
 * beside them in the same column - and the point of the rail is that those all
 * live together. So a folder here can hold anything the rail can show.
 */
export interface RailFolder {
  id: string
  name: string
  /** Group ids, in the order they were put in. */
  members: string[]
  /** A colour, so one folder is told from another at a glance. */
  colour?: string
}

/**
 * The colours a folder can be given.
 *
 * A fixed set rather than a picker: these have to stay legible against the
 * rail and as a tint behind a panel of icons, which an arbitrary colour will
 * not. Named so the choice reads as a decision rather than a hex value.
 */
export const FOLDER_COLOURS: { name: string; value: string }[] = [
  { name: 'Blurple', value: '#5865f2' },
  { name: 'Crimson', value: '#ed4245' },
  { name: 'Rose', value: '#eb459e' },
  { name: 'Amber', value: '#faa61a' },
  { name: 'Green', value: '#3ba55d' },
  { name: 'Teal', value: '#1abc9c' },
  { name: 'Sky', value: '#3498db' },
  { name: 'Violet', value: '#9b59b6' },
  { name: 'Slate', value: '#95a5a6' }
]

/** What the rail draws, top to bottom: loose entries and folders, in order. */
export type RailEntry =
  | { kind: 'group'; id: string; group: RailGroup }
  | { kind: 'folder'; id: string; folder: RailFolder; members: RailGroup[] }

/**
 * Folds the ordered groups into the rail's real layout.
 *
 * A folder takes the position of its first member, so putting servers into one
 * does not also reshuffle the column - the folder appears where the topmost of
 * them already was. Its members come back attached to it rather than spliced
 * into the list, because the rail draws an expanded folder and its servers
 * inside one container.
 */
export function railEntries(ordered: RailGroup[], folders: RailFolder[]): RailEntry[] {
  const owner = new Map<string, RailFolder>()
  for (const f of folders) {
    for (const id of f.members) owner.set(id, f)
  }

  const out: RailEntry[] = []
  const placed = new Set<string>()
  for (const g of ordered) {
    const folder = owner.get(g.id)
    if (!folder) {
      out.push({ kind: 'group', id: g.id, group: g })
      continue
    }
    if (placed.has(folder.id)) continue
    placed.add(folder.id)
    // In the folder's own order, not the rail's: that order is the one the
    // person set by dropping them in.
    const members = folder.members
      .map((id) => ordered.find((x) => x.id === id))
      .filter((x): x is RailGroup => !!x)
    out.push({ kind: 'folder', id: folder.id, folder, members })
  }

  // A folder with nothing in it still draws, at the foot of the column. A
  // new one is empty by definition, and a folder that only appears once it
  // has members can never be given any.
  for (const f of folders) {
    if (!placed.has(f.id)) out.push({ kind: 'folder', id: f.id, folder: f, members: [] })
  }
  return out
}

/**
 * Makes a folder out of two servers, the way dropping one onto another does.
 *
 * The new folder takes the place of the one that was already there, so the
 * column does not rearrange itself around the gesture.
 */
export function foldTogether(folders: RailFolder[], ontoId: string, draggedId: string): RailFolder[] {
  const existing = folders.find((f) => f.members.includes(ontoId))
  if (existing) return fileInFolder(folders, existing.id, draggedId)
  return [
    ...folders.map((f) => ({ ...f, members: f.members.filter((m) => m !== draggedId) })),
    { id: `folder-${Date.now().toString(36)}`, name: 'New folder', members: [ontoId, draggedId] }
  ]
}

/** Puts a group in a folder, taking it out of any other. */
export function fileInFolder(folders: RailFolder[], folderId: string, groupId: string): RailFolder[] {
  return folders.map((f) => {
    if (f.id === folderId) {
      return f.members.includes(groupId) ? f : { ...f, members: [...f.members, groupId] }
    }
    return { ...f, members: f.members.filter((m) => m !== groupId) }
  })
}

/** Takes a group out of whatever folder holds it. */
export function removeFromFolders(folders: RailFolder[], groupId: string): RailFolder[] {
  return folders.map((f) => ({ ...f, members: f.members.filter((m) => m !== groupId) }))
}
