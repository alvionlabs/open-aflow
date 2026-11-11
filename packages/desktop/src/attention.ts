// What needs the human right now: a Board as items, for the toasts and the tray dot. The rule is the
// web page's: the Next step card and its rest, cut to three tiers. Pure. The rules are in
// pod-docs/feature-details/toasts.md.

import { autoMaySend, listRuns, runReplies, type Board, type BoardRepo, type RunReply, type RunSummary } from '@openaflow/model'
import { nextSteps, type NextItem } from '@openaflow/web/next-step'
import { runName } from '@openaflow/web/plan-view'
import { hashFor } from '@openaflow/web/selection'

export type AttentionTier = 'blocked' | 'merge' | 'reply'
export type AttentionItem = {
  /** `<repoId>\n<key>`, stable across Boards: `entry:<line>`, `pr:<number>`, or the reply's stop key. */
  id: string
  tier: AttentionTier
  /** The run's human name. */
  run: string
  title: string
  /** Opens the run. */
  hash: string
}

const TIERS: readonly string[] = ['blocked', 'merge', 'reply'] satisfies AttentionTier[]
const isAttention = (item: NextItem): item is NextItem & { tier: AttentionTier } => TIERS.includes(item.tier)

/** A bad repo's row has nothing the human can act on from a toast. */
const unreadable = (run: RunSummary) => run.state === 'error' || run.state === 'unsupported'

/** Every item, in list order: by run, then by tier inside a run. An item two runs list belongs to the first. */
export function attentionItems(board: Board, now: number): AttentionItem[] {
  const items = new Map<string, AttentionItem>()
  for (const run of listRuns(board, now)) {
    const repo = board.repos.find((r) => r.id === run.repoId)
    const steps = unreadable(run) ? undefined : nextSteps(run, repo, now)
    if (!repo || !steps) continue
    const found = [steps.card, ...steps.rest].filter(isAttention)
    for (const item of found) {
      const key = item.action.kind === 'reply' ? replyKey(board, repo, item, found, runReplies(repo, item.action.panel.target.run, now)[0], now) : item.key
      if (key === undefined) continue
      const id = `${repo.id}\n${key}`
      if (!items.has(id)) items.set(id, { id, tier: item.tier, run: runName(run, repo), title: item.title, hash: hashFor(run) })
    }
  }
  return [...items.values()]
}

/**
 * The reply's own stop key, or undefined when it isn't an item of its own. Two replies aren't items: the reply that
 * follows a merge the run already lists, and a `continue` the board sends by itself on a toggled run. The board won't
 * send an old `fix-merged`, so that stays an item. The board won't send a stop again after its send failed to start, so
 * that stays an item too, as `failed:<key>`.
 */
function replyKey(board: Board, repo: BoardRepo, item: NextItem, found: NextItem[], stop: RunReply | undefined, now: number): string | undefined {
  if (item.action.kind !== 'reply' || !stop) return undefined
  if (found.some((other) => other.action.kind === 'merge' && other.action.number === stop.pr)) return undefined
  const { target, rows } = item.action.panel
  const toggle = board.autoContinue?.find((t) => t.repoId === target.repoId && t.run === target.run)
  if (toggle?.lastKey === stop.key) {
    // A send of this stop failed to start, on any run. The board won't retry that key, so the item stays until a send starts.
    // Its own key, so it sends a toast even when this app run already showed the stop.
    if (toggle.lastFailed) return `failed:${stop.key}`
    // A fix run stays listed long after its merge. Sent already: a toast would only offer the same word again, into a session
    // that may still be busy with it.
    if (stop.signal === 'fix-merged') return undefined
  }
  if (toggle && rows.some((r) => r.send === 'continue') && autoMaySend(repo, stop, now)) return undefined
  return stop.key
}
