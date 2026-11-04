// The toast rules and the tray dot's value, from the Boards the stream hands in. The seen set lasts the
// app run and only grows, so nothing sends twice. The rules are in pod-docs/feature-details/toasts.md.

import type { Board, BoardRepo, GhRead, PrStatus } from '@pod-board/model'
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
const readKey = (repo: BoardRepo, ask: GhRead) => `${repo.id}\n${'pr' in ask ? `pr:${ask.pr}` : `branch:${ask.branch}`}`
const answers = (ask: GhRead, pr: PrStatus) => ('pr' in ask ? pr.number === ask.pr : pr.branch === ask.branch)
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
  /** The asks gh hadn't answered at the first Board. What their first read finds is old news. */
  const awaited = new Set<string>()
  let latest: Board | undefined
  let closed = false

  /** The Board as it would be without the PRs that awaited asks found. */
  const withoutAwaited = (board: Board): Board => ({
    ...board,
    repos: board.repos.map((repo) => {
      const asks = (repo.ghReads ?? []).filter((ask) => awaited.has(readKey(repo, ask)))
      return asks.length === 0 ? repo : { ...repo, prs: repo.prs.filter((pr) => !asks.some((ask) => answers(ask, pr))) }
    }),
  })

  /**
   * Ends the wait for each ask this Board shows as read. A staging ask comes from another PR's base, so
   * one that an awaited read brought waits too. An ask only leaves when it reads as done: one that is
   * missing from a Board (a half-saved doc) may come back unread.
   */
  const settle = (board: Board) => {
    for (const repo of board.repos) {
      const asks = repo.ghReads ?? []
      const done = asks.filter((ask) => ask.read && awaited.has(readKey(repo, ask)))
      for (const ask of done) awaited.delete(readKey(repo, ask))
      if (!done.some((ask) => repo.prs.some((pr) => answers(ask, pr)))) continue
      for (const ask of asks) if (!ask.read && 'staging' in ask) awaited.add(readKey(repo, ask))
    }
  }

  /** What this pass may send: what a Board with no late PR would also have. Reads the wait, so it runs once per pass. */
  const sendable = (board: Board, fresh: AttentionItem[], now: number): AttentionItem[] => {
    if (baseline) {
      baseline = false
      for (const repo of board.repos) for (const ask of repo.ghReads ?? []) if (!ask.read) awaited.add(readKey(repo, ask))
      return []
    }
    if (awaited.size === 0 || fresh.length === 0) {
      settle(board)
      return fresh
    }
    const named = new Set(attentionItems(withoutAwaited(board), now).map((item) => item.id))
    settle(board)
    return fresh.filter((item) => named.has(item.id))
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
