import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, IconButton } from './Icon'
import { HeaderPopover } from './HeaderPopover'
import { Avatar } from './Avatar'
import { useChat, usePref, useStore } from '../state/hooks'
import { isMutedBuffer } from '../lib/groups'
import { bufferDisplayName, formatFullTime, formatRelativeTime, serviceLabel } from '../lib/util'

/**
 * The inbox: everything that mentioned you and that you have not seen yet.
 *
 * In the header rather than the rail because a mention is not a place. It is
 * a notice about somewhere you already have, and the thing you do with it is
 * glance, decide, and either go there or dismiss it - which is a popdown, the
 * same shape as the search beside it, and not a page you navigate to and then
 * have to navigate back out of.
 *
 * Unread only, deliberately. A list of every mention ever is a log; what makes
 * an inbox worth opening is that its contents are the things still owed an
 * answer, and that emptying it is possible.
 */
export function MentionsInbox(): JSX.Element {
  const store = useStore()
  const mentions = useChat((s) => s.mentions)
  const buffers = useChat((s) => s.buffers)
  const accounts = useChat((s) => s.accounts)
  const [muted] = usePref<string[]>('mutedBuffers', [])
  const [mutedGroups] = usePref<string[]>('mutedGroups', [])
  // From the store rather than the preference hook: the store writes this one
  // straight through to main, so the renderer's preference cache never hears
  // about it and a mention would stay unread after its channel was read.
  const lastReadTs = useChat((s) => s.lastReadTs)
  /**
   * When the inbox was last emptied.
   *
   * A watermark of its own rather than marking each conversation read, which
   * is what "mark all as read" would otherwise have to mean. Those are two
   * different statements: dismissing a mention says you have seen the notice,
   * not that you have read the several hundred messages in the busy channel it
   * came from - and conflating them would quietly clear unread badges the
   * user never touched.
   */
  const [dismissedTs, setDismissedTs] = usePref<number>('mentionsDismissedTs', 0)
  const [open, setOpen] = useState(false)
  /** Loading backwards towards a mention, which can take a moment. */
  const [jumping, setJumping] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const unread = useMemo(
    () =>
      mentions.filter((m) => {
        // Dismissed from the inbox, or the conversation itself has been read
        // since - opening the channel is the other, more natural way to
        // answer a mention, and it should not still be waiting afterwards.
        if (m.ts <= dismissedTs) return false
        if (m.ts <= (lastReadTs[m.bufferId] ?? 0)) return false
        // A muted conversation was told not to ask for attention. Badging a
        // button on its behalf is the one place that would be ignored.
        const buffer = buffers.find((b) => b.id === m.bufferId)
        return !buffer || !isMutedBuffer(buffer, muted, mutedGroups)
      }),
    [mentions, dismissedTs, lastReadTs, buffers, muted, mutedGroups]
  )

  // Clicking anywhere else puts it away, the way any other transient panel
  // behaves.
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const jumpTo = async (bufferId: string, id: string): Promise<void> => {
    setOpen(false)
    await store.selectBuffer(bufferId, true)
    if (!document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)) {
      // The stored conversation goes back further than the view does; load
      // backwards until the message is actually there to scroll to.
      setJumping(true)
      try {
        if (!(await store.jumpToMessage(bufferId, id))) {
          store.toast('info', "Couldn't reach that message - it is a long way back")
          return
        }
      } finally {
        setJumping(false)
      }
    }
    store.setJumpTarget(id)
  }

  return (
    <div className="mentions-inbox" ref={box}>
      <IconButton
        name="alternate_email"
        title={unread.length > 0 ? `${unread.length} unread mentions` : 'Mentions'}
        className={unread.length > 0 ? 'has-mentions' : undefined}
        onClick={() => setOpen(!open)}
      />
      {/* Capped in the label rather than the list: past a certain number the
          exact count stops meaning anything, and a three-digit badge stops
          fitting on the button. */}
      {unread.length > 0 && (
        <span className="mentions-count">{unread.length > 99 ? '99+' : unread.length}</span>
      )}

      {open && (
        <HeaderPopover anchor={box.current} width={380} className="mentions-panel" onClose={() => setOpen(false)}>
          <div className="mentions-panel-head small">
            <span className="muted">
              {jumping
                ? 'Loading older messages…'
                : unread.length === 0
                  ? 'Mentions'
                  : `${unread.length} unread ${unread.length === 1 ? 'mention' : 'mentions'}`}
            </span>
            {unread.length > 0 && (
              <button
                type="button"
                className="link-button"
                onClick={() => setDismissedTs(Math.floor(Date.now() / 1000))}
              >
                Mark all read
              </button>
            )}
          </div>

          {unread.length === 0 && (
            <div className="mentions-panel-empty muted">
              <Icon name="alternate_email" size={24} />
              <span className="small">Nothing is waiting on you.</span>
            </div>
          )}

          {unread.map((m) => {
            const buffer = buffers.find((b) => b.id === m.bufferId)
            const account = accounts.find((a) => a.id === buffer?.accountId)
            // A mention whose conversation this client has since forgotten
            // still shows: the message is the point, and hiding it because
            // the buffer list moved on would lose the very thing collected.
            const where = buffer ? bufferDisplayName(buffer.name) : 'a closed conversation'
            return (
              <button
                key={m.id}
                type="button"
                className="mention-row"
                onClick={() => buffer && void jumpTo(buffer.id, m.id)}
                disabled={!buffer}
              >
                <Avatar name={m.from} url={m.avatarUrl} size={28} />
                <span className="mention-body">
                  <span className="mention-head small">
                    <span className="mention-from">{m.from}</span>
                    <span className="muted ellipsis">
                      in {where}
                      {account ? ` · ${serviceLabel(account.service)}` : ''}
                    </span>
                    {/* Relative, with the exact time on hover: the panel is
                        narrow, and "3h ago" is what decides whether a mention
                        still needs answering. */}
                    <span className="muted mention-when" title={formatFullTime(m.ts)}>
                      {formatRelativeTime(m.ts)}
                    </span>
                  </span>
                  <span className="mention-text small ellipsis">{m.body}</span>
                </span>
              </button>
            )
          })}

          {/* The way to the full page, which is the same list without the
              unread filter. The dropdown is for what is still owed an answer;
              everything that ever mentioned you is a different question, and
              this is the only route to it now that the rail has no tile. */}
          <button
            type="button"
            className="mentions-panel-all small"
            onClick={() => {
              setOpen(false)
              store.setActivePanel('mentions')
            }}
          >
            <Icon name="inbox" size={16} />
            See all mentions
          </button>
        </HeaderPopover>
      )}
    </div>
  )
}
