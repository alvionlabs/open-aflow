// The urgent banner's pick: another run whose Next step card is more urgent than the selected run's.
// Reads only each run's card (nextSteps), ranks it by tier, and keeps the first of the highest rank:
// the oldest entry in the blocked and pending ranks, else the earlier run in the sidebar.
// Pure; the banner only renders it.

import type { Board, RunSummary } from '@pod-board/model'
import { hashFor } from '../../selection.ts'
import { nextSteps, type NextItem } from './next-step.ts'
import { runName } from './plan-view.ts'

export type Elsewhere = {
  /** The run to open. */
  run: RunSummary
  /** That run's Next step card. */
  item: NextItem
  /** The run's name, as its sidebar card and run header say it. */
  name: string
  /** The run's repo; absent for a plan-less row, whose name already is the repo. */
  repo?: string
  /** Other runs that also outrank the selected card; one item shared by several runs counts once. */
  more: number
  /** The pipeline view of that run. */
  href: string
}

const RANK: Record<NextItem['tier'], number> = { blocked: 4, merge: 3, reply: 2, pending: 1, nothing: 0, info: 0 }

/** An item's urgency: its tier's, and none for an entry pod goes on without (`stopsRun`). */
const rankOf = (item: NextItem) => (item.goesOn ? 0 : RANK[item.tier])

/** Whether another run's card can raise a banner at all: a stop, a PR, or a reply. */
const canRaise = (item: NextItem) => rankOf(item) > 0

type Candidate = { run: RunSummary; item: NextItem; rank: number; index: number }

/** Higher rank first; then, for queue entries, the older date (an undated one last); then sidebar order. */
function before(a: Candidate, b: Candidate): boolean {
  if (a.rank !== b.rank) return a.rank > b.rank
  if (a.item.tier === 'blocked' || a.item.tier === 'pending') {
    const da = a.item.entry?.date
    const db = b.item.entry?.date
    if (da !== db) {
      if (da === undefined) return false
      if (db === undefined) return true
      return da < db
    }
  }
  return a.index < b.index
}

const itemId = (c: Candidate) => `${c.run.repoId}\n${c.item.key}`

/** The run to point at from the selected one, or undefined when no other run strictly outranks it. */
export function elsewhere(runs: RunSummary[], board: Board | undefined, selected: RunSummary | undefined, now: number): Elsewhere | undefined {
  if (!board || !selected) return undefined
  const repoOf = (run: RunSummary) => board.repos.find((r) => r.id === run.repoId)
  const own = nextSteps(selected, repoOf(selected), now)
  if (!own) return undefined
  const floor = rankOf(own.card)
  const selectedHash = hashFor(selected)

  const candidates: Candidate[] = []
  runs.forEach((run, index) => {
    if (hashFor(run) === selectedHash) return
    const repo = repoOf(run)
    const item = nextSteps(run, repo, now)?.card
    if (!item || !canRaise(item) || rankOf(item) <= floor) return
    candidates.push({ run, item, rank: rankOf(item), index })
  })
  const win = candidates.reduce<Candidate | undefined>((best, c) => (best === undefined || before(c, best) ? c : best), undefined)
  if (!win) return undefined

  const items = new Set(candidates.map(itemId))
  items.delete(itemId(win))
  const repo = repoOf(win.run)
  return {
    run: win.run,
    item: win.item,
    name: runName(win.run, repo),
    ...(win.run.plan === undefined ? {} : { repo: win.run.repo }),
    more: items.size,
    href: hashFor(win.run),
  }
}
