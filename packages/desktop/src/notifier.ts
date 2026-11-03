// The toast rules and the tray dot's value, from the Boards the stream hands in. The seen set lasts the
// app run and only grows, so nothing sends twice. The rules are in pod-docs/feature-details/toasts.md.

import type { Board } from '@pod-board/model'
import { LIVE_TICK_MS } from '@pod-board/web/selection'
import { attentionItems, type AttentionItem, type AttentionTier } from './attention.ts'

/** Up to this many new items in one pass each get a toast. */
export const BURST_MAX = 3

export type Toast = { title: string; body: string; hash: string }
export type NotifierOptions = {
  now(): number
  supported(): boolean
  send(toast: Toast): void
  setAttention(on: boolean): void
  onError(error: unknown): void
}
export type Notifier = {
  board(board: Board): void
  /** The stream is lost: the last Board may be stale, so the clock waits for the next one. */
  lost(): void
  close(): void
}

const TIER_ORDER: AttentionTier[] = ['blocked', 'merge', 'reply']
const toastOf = (item: AttentionItem): Toast => ({ title: item.run, body: item.title, hash: item.hash })

/** The toasts for one pass's new items. A stable sort keeps list order inside a tier. */
function toastsFor(fresh: AttentionItem[]): Toast[] {
  if (fresh.length <= BURST_MAX) return fresh.map(toastOf)
  const top = [...fresh].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))[0]!
  return [{ title: `${fresh.length} items need you`, body: top.run, hash: top.hash }]
}

export function createNotifier(o: NotifierOptions): Notifier {
  const seen = new Set<string>()
  let baseline = true
  let latest: Board | undefined
  let closed = false

  const pass = (board: Board) => {
    try {
      const items = attentionItems(board, o.now())
      const fresh = items.filter((item) => !seen.has(item.id))
      for (const item of fresh) seen.add(item.id)
      o.setAttention(items.length > 0)
      const quiet = baseline
      baseline = false
      if (quiet || fresh.length === 0 || !o.supported()) return
      for (const toast of toastsFor(fresh)) {
        try {
          o.send(toast)
        } catch (err) {
          o.onError(err)
        }
      }
    } catch (err) {
      // A throw here would end the main process. The dot keeps its value.
      o.onError(err)
    }
  }

  const clock = setInterval(() => {
    if (latest) pass(latest)
  }, LIVE_TICK_MS)

  return {
    board(board) {
      if (closed) return
      latest = board
      pass(board)
    },
    lost() {
      latest = undefined
    },
    close() {
      closed = true
      latest = undefined
      clearInterval(clock)
    },
  }
}
