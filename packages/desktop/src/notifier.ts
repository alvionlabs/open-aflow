// The toast rules and the tray dot's value, from the Boards the stream hands in. The seen set lasts the
// app run and only grows, so nothing sends twice. The rules are in pod-docs/feature-details/toasts.md.

import type { Board } from '@pod-board/model'
import { LIVE_TICK_MS } from '@pod-board/web/selection'
import { attentionItems, type AttentionItem, type AttentionTier } from './attention.ts'

/** Up to this many new items in one pass each get a toast. */
export const BURST_MAX = 3
/**
 * How long PR items count as old news at an app start: from a first Board where gh hasn't answered,
 * and again from gh's first `ok`, because the server can send a Board between `gh auth status` and
 * its PR reads, and the Board doesn't say when those end.
 */
export const GH_HOLD_MS = 20_000

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
  /** While set, only a queue's `blocked` lines can be new: the gh-named items may be old ones arriving late. */
  let holdUntil: number | undefined
  let ghAnswered = false
  let latest: Board | undefined
  let closed = false

  /** What this pass may send. Reads the gh state, so it runs once per pass. */
  const sendable = (board: Board, fresh: AttentionItem[], now: number): AttentionItem[] => {
    if (baseline) {
      baseline = false
      if (board.gh === 'unknown') holdUntil = now + GH_HOLD_MS
      return []
    }
    if (holdUntil === undefined) return fresh
    if (board.gh === 'missing' || board.gh === 'logged-out') holdUntil = undefined
    else if (board.gh === 'ok' && !ghAnswered) {
      ghAnswered = true
      holdUntil = now + GH_HOLD_MS
    } else if (now >= holdUntil) holdUntil = undefined
    return holdUntil === undefined ? fresh : fresh.filter((item) => item.tier === 'blocked')
  }

  const pass = (board: Board) => {
    try {
      const now = o.now()
      const items = attentionItems(board, now)
      const fresh = items.filter((item) => !seen.has(item.id))
      for (const item of fresh) seen.add(item.id)
      o.setAttention(items.length > 0)
      const toSend = sendable(board, fresh, now)
      if (toSend.length === 0 || !o.supported()) return
      for (const toast of toastsFor(toSend)) {
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
