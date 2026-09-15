import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { Icon, MaskIcon } from './Icon'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { bufferMenuEntries } from '../lib/buffermenu'
import { UserFooter } from './UserFooter'
import { VoiceChannels } from './VoiceChannels'
import { VoicePanel } from './VoicePanel'
import { useChat, useIdSetPref, useMapPref, usePref, useStore } from '../state/hooks'
import {
  dmGroup,
  DM_GROUP_ID,
  isDirectMessage,
  isMutedBuffer,
  INVITE_PREFIX,
  MENTIONS_GROUP_ID,
  PINNED_GROUP_ID,
  pinnedGroup,
  visibleGroups,
  type RailGroup
} from '../lib/groups'
import { isJoining, type BufferEntry } from '../state/store'
import type { BufferGroup } from '../../../shared/wire'
import {
  bufferDisplayName,
  bufferKindGlyph,
  classes,
  resolveMediaUrl,
  serviceIcon
} from '../lib/util'
import type { Account, Member } from '../../../shared/wire'
import { Avatar } from './Avatar'
import {
  categoryKey,
  reorderCategories,
  sections,
  type CategorySection,
  type CustomCategory
} from '../lib/categories'

/**
 * Buffers grouped under a collapsible header per account, rather than one flat
 * list - "which service" is first-class everywhere else in this client, so the
 * sidebar reads that way too. Discord channels get a second level of grouping
 * per guild, because a single guild can easily carry 30+ text channels that
 * would otherwise flood every other account's rows.
 */
/**
 * What is being carried in the channel list.
 *
 * Two things can be, and they end on the same heading: a heading being put in
 * a new position, and a channel being filed under one. Tagged rather than
 * guessed from the payload, because the heading has to know which it is being
 * offered before it decides whether to take it.
 */
interface Dragged {
  kind: 'category' | 'buffer'
  id: string
}

export function BufferList(): JSX.Element {
  const store = useStore()
  const buffers = useChat((s) => s.buffers)
  const accounts = useChat((s) => s.accounts)
  const activeBufferId = useChat((s) => s.activeBufferId)
  const groups = useChat((s) => s.groups)
  const activeGroupId = useChat((s) => s.activeGroupId)
  const voiceSessions = useChat((s) => s.voiceSessions)
  const presence = useChat((s) => s.presenceByBuffer)
  const popouts = useChat((s) => s.popouts)

  const [pinned, togglePin, isPinned] = useIdSetPref('pinnedBuffers')
  const [muted, toggleMute] = useIdSetPref('mutedBuffers')
  const [hidden, , isHidden] = useIdSetPref('hiddenBuffers')
  const [mutedGroups] = usePref<string[]>('mutedGroups', [])
  // Headings a person made, per rail entry, and which channel goes under
  // which. Kept here rather than in the daemon: a heading you invented is not
  // something any other client of the same account would agree about.
  const [customCats, setCustomCats] = useMapPref<CustomCategory[]>('customCategories')
  const [assignment, setAssignment] = useMapPref<string>('channelCategory')
  const [categoryOrder, setCategoryOrder] = useMapPref<string[]>('categoryOrder')
  const [, toggleCollapsed, isCollapsed] = useIdSetPref('collapsedCategories')
  const [, setHidden] = usePref<string[]>('hiddenBuffers', [])

  const visible = useMemo(() => buffers.filter((b) => !hidden.includes(b.id)), [buffers, hidden])

  // A stale selection (a guild that went away, a first run) resolves to the
  // first entry rather than an empty pane. The pinned page is added the same
  // way the rail adds it, so both agree on what is selectable.
  const shownGroups = useMemo(() => {
    const list: RailGroup[] = [...visibleGroups(groups, visible)]
    if (visible.some(isDirectMessage)) list.push(dmGroup())
    if (pinned.length > 0) list.push(pinnedGroup())
    return list
  }, [groups, visible, pinned])
  /**
   * The mentions page has no rail tile and belongs to no server, so there is
   * no group for this pane to show.
   *
   * Called out rather than left to the fallback below, which exists for a
   * selection that has gone stale and lands on the first entry. That is right
   * for a guild that was left, and wrong here: the mentions page is a real
   * destination, and falling back filled the sidebar with an unrelated
   * server's channels and put its account on the plaque - an identity nobody
   * had selected.
   */
  const onMentionsPage = activeGroupId === MENTIONS_GROUP_ID
  /**
   * Where to go when the selected entry is no longer in the rail.
   *
   * Whatever is being read, if it is still somewhere. An account's tile
   * disappears the moment its first direct message arrives - its buffers now
   * live on the shared direct messages page rather than in the account, and
   * that is what the tile was for - so a conversation open at the time would
   * otherwise take the pane to whichever server happens to sit first in the
   * rail. Being moved to an unrelated server because somebody sent a message
   * is a worse answer than any of the alternatives.
   *
   * A direct message's own group is folded away in the rail, so it answers
   * with the page that replaced it.
   */
  const openBufferGroup = useMemo(() => {
    const open = buffers.find((b) => b.id === activeBufferId)
    if (!open) return undefined
    return isDirectMessage(open) ? DM_GROUP_ID : open.groupId
  }, [buffers, activeBufferId])

  // An invitation is selected the same way the mentions page is: a rail entry
  // with no group behind it. Without this the lookup below fails to find it,
  // falls back to some real group, and the effect writes that back - so
  // choosing an invitation landed on whichever server happened to be first,
  // which is exactly what it looked like.
  const onInvite = activeGroupId.startsWith(INVITE_PREFIX)

  const activeGroup =
    onMentionsPage || onInvite
      ? undefined
      : shownGroups.find((g) => g.id === activeGroupId) ||
        shownGroups.find((g) => g.id === openBufferGroup) ||
        shownGroups[0]
  /**
   * Settles a selection that had to be resolved by falling back.
   *
   * Without this the fallback is re-run on every render, so the pane sits on
   * a group nothing has actually selected and moves the moment the rail
   * changes shape - a direct message arriving is enough, since it adds an
   * entry and can take an account's own tile away. Writing the answer back
   * once means the next change has a real selection to keep.
   */
  useEffect(() => {
    if (onMentionsPage || onInvite || !activeGroup) return
    if (activeGroup.id !== activeGroupId) store.selectGroup(activeGroup.id)
  }, [activeGroup, activeGroupId, onMentionsPage, onInvite, store])

  const isPinnedPage = activeGroup?.id === PINNED_GROUP_ID
  const isDmPage = activeGroup?.id === DM_GROUP_ID
  /**
   * Whose identity the plaque shows.
   *
   * The direct-messages and pinned pages deliberately belong to no account -
   * they gather conversations from every service - so there is no group
   * account to read. Falling back to the account of whatever is open keeps
   * the plaque present on those pages, which matters beyond the name on it:
   * the microphone and speaker buttons live there, and losing them because
   * of which page you happen to be on leaves no way to mute during a call.
   */
  const activeBuffer = buffers.find((b) => b.id === activeBufferId)
  const groupAccount =
    // The mentions page is nobody's: it gathers every service, and the fallback
    // chain below would put the account of whatever happens to be open behind
    // it onto the plaque. The one exception is a live call - the microphone and
    // speaker buttons live on the plaque and nowhere else, and taking them away
    // because of which page is open leaves no way to mute mid-call.
    onMentionsPage && voiceSessions.length === 0
      ? undefined
      : (accounts.find((a) => a.id === activeGroup?.accountId) ??
        accounts.find((a) => a.id === activeBuffer?.accountId) ??
        accounts[0])

  /**
   * What the pane lists, in reading order: pinned first, then direct messages,
   * then channels, each band by most recent activity.
   *
   * The pinned page is the same list unfiltered by group - a pin is a
   * cross-service shortcut, so its page is the one place they all appear
   * together.
   */
  const groupBuffers = useMemo(() => {
    if (!activeGroup) return []
    const inScope = isPinnedPage
      ? visible.filter((b) => pinned.includes(b.id))
      : isDmPage
        ? visible.filter(isDirectMessage)
        : visible.filter((b) => b.groupId === activeGroup.id)

    // Server buffer above everything; then pinned, DMs, channels.
    const band = (b: BufferEntry): number => {
      if (b.kind === 'server') return 0
      if (!isPinnedPage && pinned.includes(b.id)) return 1
      if (b.kind === 'dm') return 2
      return 3
    }
    return [...inScope].sort(
      (a, b) => band(a) - band(b) || (b.lastActivityTs || 0) - (a.lastActivityTs || 0)
    )
  }, [visible, activeGroup, isPinnedPage, isDmPage, pinned])

  /**
   * The rows, under their headings.
   *
   * Every page can have them, the pinned and direct-message pages included.
   * They were left out on the grounds that each is already one flat idea, but
   * that is exactly backwards for the pages that gather everything: a guild's
   * channels arrive sorted into the server's own categories, while the direct
   * message page is one undifferentiated column of every conversation on
   * every service, which is where a person most wants to impose some order.
   *
   * Ordinary channels sort by the service's own position within a heading,
   * since that is the order the server arranged them in and the reason it
   * supplies one. The gathered pages have no such order to respect and keep
   * the recency they were already sorted by.
   */
  const grouped = useMemo(() => {
    if (!activeGroup) return null
    const mine = customCats[activeGroup.id] ?? []
    const list = sections(groupBuffers, mine, assignment, categoryOrder[activeGroup.id] ?? [])
    if (!isPinnedPage && !isDmPage) {
      for (const s of list) {
        s.buffers.sort((a, b) => (a.position || 0) - (b.position || 0))
      }
    }
    // A heading with nothing under it is still drawn when it is the user's -
    // they just made it, and a heading that vanishes until something is put
    // in it cannot have anything put in it.
    return list.filter((s) => s.custom || s.buffers.length > 0)
  }, [activeGroup, isPinnedPage, isDmPage, groupBuffers, customCats, assignment, categoryOrder])

  // The menu still toggles a buffer's *own* flag independently of a muted
  // rail entry above it, the same way muting a channel inside an
  // already-muted Slack workspace works.
  const isEffectivelyMuted = (buffer: BufferEntry): boolean =>
    isMutedBuffer(buffer, muted, mutedGroups)

  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null)
  const { menu: groupMenu, open: openGroupMenuAt, close: closeGroupMenu } = useContextMenu()
  const [catMenu, setCatMenu] = useState<{ x: number; y: number; section: CategorySection } | null>(null)

  const myCategories = activeGroup ? (customCats[activeGroup.id] ?? []) : []
  const writeCategories = (next: CustomCategory[]): void => {
    if (activeGroup) setCustomCats(activeGroup.id, next)
  }

  const openGroupMenu = (e: React.MouseEvent): void => openGroupMenuAt(e)
  const openCategoryMenu = (e: React.MouseEvent, section: CategorySection): void => {
    e.preventDefault()
    // Only a heading you made is yours to rename or remove; a server's
    // category is theirs, and offering to rename it would be a lie.
    if (!section.custom) return
    setCatMenu({ x: e.clientX, y: e.clientY, section })
  }

  const renderRow = (b: BufferEntry): JSX.Element => (
    <BufferRow
      key={b.id}
      buffer={b}
      active={b.id === activeBufferId}
      muted={isEffectivelyMuted(b)}
      pinned={isPinned(b.id)}
      accounts={accounts}
      // Already on the page being shown; keep the rail where it is. A room
      // still being joined has nothing behind it to select - it exists in
      // this window only - so the row is there to be seen rather than opened.
      onSelect={() => !isJoining(b) && void store.selectBuffer(b.id, false)}
      onTogglePin={() => togglePin(b.id)}
      onToggleMute={() => {
        toggleMute(b.id)
        // On Matrix the account itself can hold the answer, so muting here
        // mutes on a phone too. Everywhere else this stays what it always
        // was: a preference belonging to this window.
        if (accounts.find((a) => a.id === b.accountId)?.service === 'matrix') {
          void window.moho
            .rpc('setMatrixRoomMuted', { bufferId: b.id, muted: !isEffectivelyMuted(b) })
            .catch((e: Error) => store.toast('error', e.message))
        }
      }}
      onToggleAutojoin={
        b.kind === 'channel' && accounts.find((a) => a.id === b.accountId)?.service === 'irc'
          ? () => store.toggleAutojoin(b.accountId, bufferDisplayName(b.name))
          : undefined
      }
      autojoins={store.autojoins(b.accountId, bufferDisplayName(b.name))}
      // Which spaces this account has, so a room can be put in one. Matrix
      // only: a Discord guild is not something a channel is moved between.
      spaces={groups.filter((g) => g.kind === 'space' && g.accountId === b.accountId)}
      onSpace={(spaceId, child) =>
        void store
          .setMatrixSpaceChild(spaceId, b.id, child)
          .catch((e: Error) => store.toast('error', e.message))
      }
      onWatch={b.accountId.startsWith('kick:') ? () => store.watchStream(b.id) : undefined}
      onStopWatching={() => store.stopWatching()}
      onOpenInBrowser={
        b.accountId.startsWith('kick:')
          ? () => void window.moho.openExternal(`https://kick.com/${bufferDisplayName(b.name)}`)
          : undefined
      }
      onHide={() => hideBuffer(b.id)}
      onClose={() => void store.closeBuffer(b.id)}
      inCall={voiceSessions.some((s) => s.bufferId === b.id)}
      status={dmStatus(b, presence, buffers)}
      onCall={() => void store.callBuffer(b.id)}
      onHangUp={() => void store.leaveVoice(b.accountId)}
      onFile={(categoryId) => setAssignment(b.id, categoryId)}
      poppedOut={popouts.open.includes(b.id)}
      onPopOut={() => store.popOut(b.id)}
      onDock={() => store.dock(b.id)}
      onMarkUnread={() => void store.markUnread(b.id)}
      // Only where there is somewhere to drop it. A list with no headings of
      // your own has nothing a channel could be filed under, and a drag that
      // can only ever be refused is worse than one the row does not offer.
      draggable={myCategories.length > 0}
      lifted={dragging?.kind === 'buffer' && dragging.id === b.id}
      onDragStart={() => beginDrag('buffer', b.id)}
      onDragEnd={endDrag}
      filed={!!assignment[b.id] && myCategories.some((c) => c.id === assignment[b.id])}
    />
  )

  // What is in flight lives in a ref as well as in state, for the reason the
  // rail's does: dragstart and drop are separate events, and reading the value
  // out of state means depending on a re-render having happened in between.
  // State mirrors it only so the list restyles while dragging.
  //
  // Tagged rather than two refs, because both kinds of drag end on the same
  // heading and it has to know which one it is being offered.
  const draggedRef = useRef<Dragged | null>(null)
  const [dragging, setDragging] = useState<Dragged | null>(null)
  const [overCategory, setOverCategory] = useState('')

  const beginDrag = (kind: Dragged['kind'], id: string): void => {
    draggedRef.current = { kind, id }
    setDragging({ kind, id })
  }

  const endDrag = (): void => {
    draggedRef.current = null
    setDragging(null)
    setOverCategory('')
  }

  /**
   * Whether a heading would take what is currently being dragged.
   *
   * A heading always accepts another heading. It only accepts a channel if it
   * is one somebody made: a service's heading is that server's own grouping,
   * and moving a channel into a Discord category is a change to the server
   * rather than to this list. Refusing it here - by declining the drop rather
   * than accepting and ignoring - is what makes the cursor say so.
   */
  const accepts = (section: CategorySection): boolean => {
    const held = draggedRef.current
    if (!held) return false
    return held.kind === 'category' ? section.key !== held.id : section.custom
  }

  const dropOnCategory = (section: CategorySection): void => {
    const held = draggedRef.current
    endDrag()
    if (!held || !grouped || !activeGroup) return
    if (held.kind === 'category') {
      if (held.id === section.key) return
      setCategoryOrder(activeGroup.id, reorderCategories(grouped, held.id, section.key))
      return
    }
    if (!section.custom) return
    setAssignment(held.id, section.key)
  }

  const hideBuffer = (id: string): void => {
    if (!isHidden(id)) setHidden([...hidden, id])
  }

  return (
    <div className="bufferlist">
      <div className="bufferlist-scroll">
        {accounts.length === 0 && (
          <div className="bufferlist-empty muted small">
            No accounts yet. Add one to get started.
          </div>
        )}

        {/* Not on the mentions page, which is deliberately server-less: the
            pane is empty there because there is nothing to list, not because
            something still needs picking. */}
        {accounts.length > 0 && !activeGroup && !onMentionsPage && (
          <div className="bufferlist-empty muted small">Select a server on the left.</div>
        )}

        {activeGroup && (
          <>
            <div className="group-title">
              <button
                type="button"
                className="ellipsis group-title-name"
                title={`${activeGroup.name} — organise this list`}
                onClick={grouped ? openGroupMenu : undefined}
                disabled={!grouped}
              >
                {activeGroup.name}
                {grouped && <Icon name="expand_more" size={14} />}
              </button>
              {/* Only where the page is actually one account's. The direct
                  messages and pinned pages gather several, so a single
                  connection light there says nothing about any of them - and
                  says it in the confident green of something that means
                  something. */}
              {activeGroup.accountId && groupAccount && <ConnectionDot state={groupAccount.state} />}
            </div>

            {groupBuffers.length === 0 && (
              <div className="bufferlist-empty muted small">Nothing here yet.</div>
            )}

            {grouped
              ? grouped.map((section) => {
                  const key = categoryKey(activeGroup.id, section)
                  const folded = isCollapsed(key)
                  return (
                    <div key={section.key} className="category">
                      {naming?.id === section.key ? (
                        <CategoryNameField
                          value={naming.name}
                          onChange={(name) => setNaming({ id: naming.id, name })}
                          onCommit={() => {
                            const name = naming.name.trim()
                            if (name) {
                              writeCategories(
                                myCategories.map((c) => (c.id === naming.id ? { ...c, name } : c))
                              )
                            }
                            setNaming(null)
                          }}
                          onCancel={() => setNaming(null)}
                        />
                      ) : (
                        section.name && (
                        <button
                          type="button"
                          className={classes(
                            'category-head',
                            'small',
                            dragging?.kind === 'category' && dragging.id === section.key && 'lifted',
                            overCategory === section.key && 'drop-target'
                          )}
                          onClick={() => toggleCollapsed(key)}
                          onContextMenu={(e) => openCategoryMenu(e, section)}
                          // Every heading moves, the service's included. Its
                          // own order is the server's opinion about its own
                          // categories, which is a fine default and no reason
                          // to be stuck with it here.
                          draggable
                          onDragStart={(e) => {
                            // Chromium abandons a drag whose dataTransfer was
                            // never written to.
                            e.dataTransfer.setData('text/plain', section.key)
                            e.dataTransfer.effectAllowed = 'move'
                            beginDrag('category', section.key)
                          }}
                          onDragOver={(e) => {
                            // Not preventing the default is how a drop is
                            // refused, and it is the refusal the cursor shows.
                            if (!accepts(section)) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            setOverCategory(section.key)
                          }}
                          onDragLeave={() => setOverCategory((k) => (k === section.key ? '' : k))}
                          onDrop={(e) => {
                            e.preventDefault()
                            dropOnCategory(section)
                          }}
                          onDragEnd={endDrag}
                          title={
                            section.custom
                              ? 'Your heading — drop channels here, drag to reorder, right-click to rename or remove'
                              : `${section.name} — drag to reorder`
                          }
                        >
                          <Icon name={folded ? 'chevron_right' : 'expand_more'} size={14} />
                          <span className="ellipsis">{section.name}</span>
                          {folded && section.buffers.length > 0 && (
                            <span className="muted category-count">{section.buffers.length}</span>
                          )}
                        </button>
                        )
                      )}

                      {/* A collapsed heading still shows the channel you are
                          reading, or selecting it from elsewhere would appear
                          to do nothing. */}
                      {section.buffers
                        .filter((b) => !folded || b.id === activeBufferId)
                        .map((b) => renderRow(b))}
                      {section.custom && section.buffers.length === 0 && !folded && (
                        <div className="category-empty small muted">Drag a channel onto this heading</div>
                      )}
                    </div>
                  )
                })
              : groupBuffers.map((b) => renderRow(b))}


            {/* Below the text channels, as everywhere else that has both. */}
            <VoiceChannels group={activeGroup} />
          </>
        )}
      </div>

      {groupMenu && activeGroup && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          entries={[
            {
              label: 'New category',
              icon: 'create_new_folder',
              onClick: () => {
                const id = `cat-${Date.now().toString(36)}`
                // At the top, not the end. The command was given from the
                // group's own title at the top of this list, and a heading
                // that appears twenty rows below where it was asked for is a
                // heading somebody has to go and find. It can be dragged
                // anywhere afterwards.
                writeCategories([{ id, name: 'New category' }, ...myCategories])
                // Named in the saved order too, or the ordering rule would
                // sort a heading nobody has placed to the bottom - which is
                // exactly where this one must not go.
                const order = categoryOrder[activeGroup.id]
                if (order?.length) setCategoryOrder(activeGroup.id, [id, ...order])
                // Straight into renaming it: a heading called "New category"
                // is not one anybody meant to keep.
                setNaming({ id, name: 'New category' })
              }
            }
          ]}
          onClose={closeGroupMenu}
        />
      )}

      {catMenu && (
        <ContextMenu
          x={catMenu.x}
          y={catMenu.y}
          entries={[
            {
              label: 'Rename',
              icon: 'edit',
              onClick: () =>
                setNaming({ id: catMenu.section.key, name: catMenu.section.name ?? '' })
            },
            {
              label: 'Remove',
              icon: 'delete',
              danger: true,
              // The channels stay; only the heading goes, and they fall back
              // to wherever the service filed them.
              onClick: () => writeCategories(myCategories.filter((c) => c.id !== catMenu.section.key))
            }
          ]}
          onClose={() => setCatMenu(null)}
        />
      )}

      {/* Outside the group above, so a call stays visible and hangable-up
          wherever you navigate. */}
      <VoicePanel />

      <div className="divider-h" />
      <UserFooter account={groupAccount} />
    </div>
  )
}

/**
 * Naming a heading, where the heading is.
 *
 * In the flow rather than floating over the list, which is what the box that
 * used to do this got wrong twice over: it sat at a fixed offset from the
 * bottom, so renaming a heading at the top of a long list meant crossing the
 * window to type - and it was positioned against nothing, so it spanned the
 * whole viewport. Both stop being possible once the field simply takes the
 * heading's place.
 *
 * That also settles where a brand new heading is named: it is made at the top
 * of the list, right under the group title the command was given from, so the
 * field appears where the cursor already is.
 */
function CategoryNameField({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <input
      autoFocus
      className="category-name-field"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      // Selected on focus, because the name it opens with is either the old
      // one being replaced or the placeholder nobody meant to keep. Either
      // way the first keystroke should replace it rather than append to it.
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
        if (e.key === 'Enter') onCommit()
      }}
      // Clicking away keeps what was typed rather than discarding it: the
      // field is in the list rather than over it, so a click elsewhere reads
      // as moving on, not as calling it off. Escape is the way to call it off.
      onBlur={onCommit}
    />
  )
}

/**
 * The other person's status in a direct message.
 *
 * Three sources, in descending order of directness. A DM's own roster is the
 * people in it other than you, so for a one-to-one conversation there is
 * exactly one and it is them - that is Discord and Matrix, which report
 * presence properly.
 *
 * IRC reports none, but it does say who is in a channel, and somebody sitting
 * in a channel with you is by definition connected. So a query with a nick
 * visible anywhere else on the same account counts as online - or away, which
 * IRC does have. This is why the lookup is worth doing rather than showing a
 * permanent grey dot on every IRC conversation.
 *
 * Failing both, they are reported offline: for a protocol where presence is
 * knowable, not knowing means not there.
 */
export function dmStatus(
  buffer: BufferEntry,
  presence: Record<string, Member[]>,
  buffers: BufferEntry[]
): string | undefined {
  if (buffer.kind !== 'dm') return undefined

  const own = presence[buffer.id]
  if (own?.length === 1 && own[0].status) return own[0].status

  const name = buffer.name.toLowerCase()
  for (const b of buffers) {
    if (b.accountId !== buffer.accountId) continue
    const member = presence[b.id]?.find((m) => m.nick.toLowerCase() === name)
    if (member) return member.away ? 'idle' : 'online'
  }
  return 'offline'
}

/**
 * What closing this conversation will actually do.
 *
 * It used to say "Close" everywhere and mean "stop drawing this", which was
 * the bug: on Matrix you stayed in the room and it reappeared on the next
 * sync. Now it leaves for real, so the menu has to say so - and say the right
 * thing, since what leaving means differs. A guild's channel is the exception
 * and is honest about it: you are in it because you are in the guild, so there
 * is nothing to leave and this only hides it.
 */
function ConnectionDot({ state }: { state: string }): JSX.Element {
  const color =
    state === 'connected'
      ? 'var(--success)'
      : state === 'connecting'
        ? 'var(--warning)'
        : 'var(--outline)'
  return <span className="connection-dot" style={{ background: color }} title={state} />
}

interface BufferRowProps {
  buffer: BufferEntry
  active: boolean
  muted: boolean
  pinned: boolean
  accounts: Account[]
  /** Pinned rows sit outside their account group, so they carry the service
   * mark instead of the buffer-kind glyph to show where they belong. */
  showServiceIcon?: boolean
  onSelect: () => void
  onTogglePin: () => void
  onToggleMute: () => void
  /** IRC channels only: rejoin this on every connect, or stop doing so. */
  onToggleAutojoin?: () => void
  /** Kick channels only: watch the stream where streams are watched. */
  onOpenInBrowser?: () => void
  /** Kick channels only: play the stream in this window, or stop. */
  onWatch?: () => void
  onStopWatching?: () => void
  /** The spaces this room could belong to, for the services that have them. */
  spaces?: BufferGroup[]
  /** Puts this room in a space, or takes it out of one. */
  onSpace?: (spaceId: string, child: boolean) => void
  /** Whether it is in that list now. */
  autojoins?: boolean
  onHide: () => void
  onClose: () => void
  onCall: () => void
  onHangUp: () => void
  /** Headings this list offers, so a channel can be filed under one. */
  onFile: (categoryId: string) => void
  /** A call is already up in this conversation. */
  inCall: boolean
  /** This conversation has a window of its own. */
  poppedOut: boolean
  onPopOut: () => void
  onDock: () => void
  /** Matrix only: leave it unread on purpose. */
  onMarkUnread?: () => void
  draggable: boolean
  /** Being carried right now. */
  lifted: boolean
  /** Filed under one of your own headings, so there is something to undo. */
  filed: boolean
  onDragStart: () => void
  onDragEnd: () => void
  /** The other person's presence, for a direct message. */
  status?: string
}

const BufferRow = memo(function BufferRow({
  buffer,
  active,
  muted,
  pinned,
  accounts,
  showServiceIcon,
  onSelect,
  onTogglePin,
  onToggleMute,
  onToggleAutojoin,
  autojoins,
  onOpenInBrowser,
  onWatch,
  onStopWatching,
  spaces,
  onSpace,
  onHide,
  onClose,
  onCall,
  onHangUp,
  inCall,
  status,
  onFile,
  poppedOut,
  onPopOut,
  onDock,
  onMarkUnread,
  draggable,
  lifted,
  filed,
  onDragStart,
  onDragEnd
}: BufferRowProps): JSX.Element {
  const { menu, open, close } = useContextMenu()
  const account = accounts.find((a) => a.id === buffer.accountId)
  // Whether this channel is on air. Selected down to the one boolean rather
  // than the map, so a viewer count ticking over in one channel does not
  // re-render every row in the list.
  const live = useChat((s) => s.kickStreams[buffer.id]?.live ?? false)
  // Whether this channel's stream is the one in the window. Selected down to
  // a boolean for the same reason as `live` above.
  const watched = useChat((s) => s.watching?.bufferId === buffer.id)

  // Under an account header the row's own kind is what's worth showing (a
  // channel vs a DM vs the server buffer). A pinned row has no header above
  // it, so it shows the service instead - the Discord or Matrix mark, or the
  // "#" that IRC channels already use - rather than repeating the account
  // name as text in front of every entry.
  const service = serviceIcon(account?.service ?? '')
  const leading = showServiceIcon ? (
    service.mark ? (
      <MaskIcon src={service.mark} size={15} />
    ) : (
      <Icon name={service.glyph!} size={15} />
    )
  ) : buffer.kind === 'dm' ? (
    // A conversation with a person is headed by that person, whatever
    // protocol they are on: their picture where there is one, their initial
    // where there is not.
    <Avatar name={buffer.name} url={buffer.avatarUrl} size={22} status={status} />
  ) : buffer.avatarUrl ? (
    <img className="buffer-avatar" src={resolveMediaUrl(buffer.avatarUrl)} alt="" />
  ) : (
    <Icon name={bufferKindGlyph(buffer.kind)} size={15} />
  )

  // Calling from the row it belongs to, as well as from the header of the
  // conversation once it is open - the list is where you look for somebody
  // you want to reach, so it is where reaching them should be offered.
  const canCall = account?.service === 'discord' && buffer.kind === 'dm'

  // The same entries the header's nameplate opens - see lib/buffermenu.ts for
  // why they live there rather than here.
  const entries = bufferMenuEntries({
    buffer,
    account,
    muted,
    pinned,
    filed,
    inCall,
    poppedOut,
    canCall,
    live,
    watched,
    autojoins,
    spaces,
    onTogglePin,
    onToggleMute,
    onToggleAutojoin,
    onSpace,
    onWatch,
    onStopWatching,
    onOpenInBrowser,
    onHide,
    onClose,
    onCall,
    onHangUp,
    onFile,
    onPopOut,
    onDock,
    onMarkUnread: account?.service === 'matrix' ? onMarkUnread : undefined,
    markedUnread: buffer.markedUnread
  })

  return (
    <>
      <button
        type="button"
        className={classes(
          'buffer-row',
          active && 'active',
          buffer.highlight && 'highlight',
          lifted && 'lifted'
        )}
        onClick={onSelect}
        onContextMenu={open}
        draggable={draggable}
        onDragStart={(e) => {
          // Chromium abandons a drag whose dataTransfer was never written to.
          e.dataTransfer.setData('text/plain', buffer.id)
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        title={draggable ? `${buffer.name} — drag onto a heading to file it` : buffer.name}
      >
        {leading}
        <span className="ellipsis buffer-name">{bufferDisplayName(buffer.name)}</span>
        {/* So a conversation with no unread count and no traffic in it is
            explained rather than merely quiet: it is being read elsewhere. */}
        {/* Still filling in - a Matrix room between joining it and the server
            saying what is in it. A moving thing rather than a static mark,
            because what it says is "wait", not "note". */}
        {buffer.syncing && <span className="spinner" aria-label="Synchronising" />}
        {poppedOut && <Icon name="open_in_new" size={13} className="buffer-muted-icon" />}
        {muted && <Icon name="notifications_off" size={13} className="buffer-muted-icon" />}
        {/* One badge, and being on air wins it: a live channel says LIVE,
            an off-air one says how much was said while you were away. The
            two flickering against each other in the same slot as messages
            arrive is worse than either on its own. */}
        {live ? (
          <span className="live-badge">LIVE</span>
        ) : buffer.unread > 0 && !muted ? (
          <span className={classes('unread-badge', buffer.highlight && 'highlight')}>
            {buffer.unread > 99 ? '99+' : buffer.unread}
          </span>
        ) : (
          // Left unread on purpose, with nothing new in it. A dot rather than
          // a count, because there is no number to show - the room was read
          // and then deliberately put back, and what it is saying is "come
          // back to this", not "there are four of something".
          buffer.markedUnread &&
          !muted && <span className="unread-dot" aria-label="Marked as unread" />
        )}
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={close} />}
    </>
  )
})
