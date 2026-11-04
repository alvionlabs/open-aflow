// Screen 2, the wave board: one column per wave of the shown sprint, one card per
// slice with its state and meta, the dependency edges between cards, the critical
// path, and the filter chips' state. Pure; components only render these.
// The rules and why are in pod-docs/feature-details/wave-board.md.

import {
  buildPipeline,
  isBlockedSlice,
  isPlanHeld,
  isSliceDone,
  isSliceRunning,
  isWaveRunning,
  planState,
  roleOf,
  stopsRun,
  waitingPrs,
  waitingWords,
  type AgentRun,
  type BoardRepo,
  type LogRow,
  type PlanModel,
  type PlanState,
  type QueueItem,
  type SliceModel,
  type SprintModel,
} from '@pod-board/model'
import type { Chip } from '../runs/view.ts'

export type CardState = 'needs-you' | 'running' | 'waiting' | 'blocked' | 'merged'
export type Card = { code: string; title: string; state: CardState; meta: string; critical: boolean; slice: SliceModel; row: LogRow }
export type Column = { wave: number; status: string; cards: Card[] }
export type Edge = { from: string; to: string; critical: boolean }
export type WaveBoard = { sprint?: string; caption: string; columns: Column[]; edges: Edge[]; counts: Record<CardState, number> }

const CHIPS: Record<CardState, Chip> = {
  'needs-you': { cls: 's-you', label: 'needs you' },
  running: { cls: 's-run', label: 'running' },
  waiting: { cls: 's-idle', label: 'waiting' },
  blocked: { cls: 's-bad', label: 'blocked' },
  merged: { cls: 's-ok', label: 'merged' },
}

export const cardChip = (s: CardState): Chip => CHIPS[s]

/** The card edge class for each state; waiting keeps the default edge. */
export const CARD_EDGE: Record<CardState, string> = {
  'needs-you': 'k-you',
  running: 'k-run',
  waiting: '',
  blocked: 'k-bad',
  merged: 'k-ok',
}

const META_MAX = 60
const cut = (s: string) => (s.length > META_MAX ? `${s.slice(0, META_MAX - 1)}…` : s)

/** The plan's current sprint, else its last sprint with a doc. */
function shownSprint(plan: PlanModel): SprintModel | undefined {
  if (plan.currentSprint !== undefined) return plan.sprints.find((s) => s.slug === plan.currentSprint)
  return plan.sprints.findLast((s) => s.hasDoc)
}

const emptyCounts = (): Record<CardState, number> => ({ 'needs-you': 0, running: 0, waiting: 0, blocked: 0, merged: 0 })

/** The wave board of a plan's shown sprint; undefined for a plan the repo doesn't have. Never throws. */
export function buildWaveBoard(repo: BoardRepo, planSlug: string, now: number): WaveBoard | undefined {
  const plan = repo.model.plans.find((p) => p.slug === planSlug)
  if (!plan) return undefined
  const sprint = shownSprint(plan)
  if (!sprint) return { caption: '', columns: [], edges: [], counts: emptyCounts() }
  const i = plan.sprints.indexOf(sprint)
  const caption = `Sprint ${i + 1} of ${plan.sprints.length} · ${sprint.slug}`
  const log = (buildPipeline(repo, planSlug, now)?.log ?? []).filter((g) => g.sprint === sprint.slug)
  const run = planState(repo, plan, now)
  const waiting = waitingPrs(repo, now).filter((w) => w.kind === 'wave' && w.run === plan.slug && w.sprint === sprint.slug)

  const columns: Column[] = sprint.waves
    .filter((w) => w.slices.length > 0)
    .map((w) => {
      const group = log.find((g) => g.wave === w.wave)
      const mergePr = waiting.find((x) => x.wave === w.wave)?.number
      return {
        wave: w.wave,
        status: group?.status ?? '',
        cards: w.slices.map((slice): Card => {
          const row = group?.rows.find((r) => r.code === slice.code) ?? { code: slice.code, title: slice.title, live: false }
          // As the flow's card: a stop on the whole plan reads first on a live wave; the wave in progress
          // with nothing of its own running reads the run's state.
          const current = sprint.slug === plan.currentSprint && sprint.currentWave === w.wave
          const waveRuns = isWaveRunning(repo, plan, sprint, w, now)
          const held = (current || waveRuns) && isPlanHeld(plan)
          const running = !held && isSliceRunning(repo, plan, sprint, w, slice, now)
          const inProgress = held || (current && !waveRuns) ? run : undefined
          const state = cardState(plan, sprint.slug, slice, running, mergePr !== undefined, inProgress)
          return { code: slice.code, title: slice.title, state, meta: cardMeta(plan, sprint.slug, slice, row, state, mergePr), critical: false, slice, row }
        }),
      }
    })

  const all = columns.flatMap((c) => c.cards.map((card) => ({ card, wave: c.wave })))
  const edges = buildEdges(all)
  markCritical(all.map((x) => x.card), edges)
  const counts = emptyCounts()
  for (const { card } of all) counts[card.state] += 1
  return { sprint: sprint.slug, caption, columns, edges, counts }
}

/** The codes on the plan's shown board, for dropping a hash's unknown slice. */
export function boardSlices(repo: BoardRepo | undefined, planSlug: string, now: number): string[] {
  const board = repo && buildWaveBoard(repo, planSlug, now)
  return board ? board.columns.flatMap((c) => c.cards.map((k) => k.code)) : []
}

/** Queue entries naming this slice, with this sprint or none. */
const naming = (e: QueueItem, sprint: string, code: string) => e.slice === code && (e.sprint === undefined || e.sprint === sprint)

/**
 * First match wins: blocked → merged → needs-you (a stop naming it, or its wave's PR waiting on you)
 * → running → the run's state, on the wave in progress → waiting. A done card reads merged even with a pending ask.
 */
function cardState(plan: PlanModel, sprint: string, slice: SliceModel, running: boolean, waveWaits: boolean, inProgress: PlanState | undefined): CardState {
  if (isBlockedSlice(slice)) return 'blocked'
  if (isSliceDone(slice)) return 'merged'
  if (waveWaits || plan.queue.some((e) => stopsRun(e, plan) && naming(e, sprint, slice.code))) return 'needs-you'
  if (running) return 'running'
  return inProgress === undefined || inProgress === 'idle' ? 'waiting' : inProgress
}

const join = (parts: (string | undefined)[]) => parts.filter((p): p is string => p !== undefined && p !== '').join(' · ')
const mins = (row: LogRow) => (row.minutes === undefined ? undefined : `${row.minutes} min`)
const entryLine = (e: QueueItem) => cut(`${e.type}: ${e.body}`)

function cardMeta(plan: PlanModel, sprint: string, slice: SliceModel, row: LogRow, state: CardState, mergePr: number | undefined): string {
  switch (state) {
    case 'merged':
      return join([slice.model, row.confidence, mins(row)])
    case 'running':
      return join([slice.model, mins(row)])
    case 'needs-you': {
      // A stop naming this slice, else its wave's PR, else the stop that holds the run.
      const stops = plan.queue.filter((x) => stopsRun(x, plan))
      const e = stops.findLast((x) => naming(x, sprint, slice.code))
      if (e) return entryLine(e)
      if (mergePr !== undefined) return `PR #${mergePr} · ${waitingWords(plan)}`
      const held = stops.at(-1)
      return held ? entryLine(held) : ''
    }
    case 'blocked': {
      const blocked = plan.queue.filter((x) => x.isPending && x.type === 'BLOCKED')
      const e = blocked.findLast((x) => naming(x, sprint, slice.code)) ?? (isBlockedSlice(slice) ? undefined : blocked.at(-1))
      if (e) return entryLine(e)
      return slice.status.trim() === '' ? '' : `status ${slice.status.trim()}`
    }
    case 'waiting':
      return slice.dependsOn.length > 0 ? `needs ${slice.dependsOn.join(', ')}` : (slice.model ?? '')
  }
}

/** One edge per (dependency, slice) where the dependency is on this board in an earlier wave. */
function buildEdges(all: { card: Card; wave: number }[]): Edge[] {
  const waveOf = new Map<string, number>()
  for (const { card, wave } of all) if (!waveOf.has(card.code)) waveOf.set(card.code, wave)
  const edges: Edge[] = []
  const seen = new Set<string>()
  for (const { card, wave } of all) {
    for (const dep of card.slice.dependsOn) {
      const from = waveOf.get(dep)
      const key = `${dep}\u0000${card.code}`
      if (from === undefined || from >= wave || seen.has(key)) continue
      seen.add(key)
      edges.push({ from: dep, to: card.code, critical: false })
    }
  }
  return edges
}

/**
 * The longest chain along edges, by slice count. A tie goes to the chain whose
 * slices come first in board order, compared slice by slice from the first.
 * Edges only point to later waves, so a later card never leads back.
 */
function markCritical(cards: Card[], edges: Edge[]): void {
  if (edges.length === 0) return
  const index = new Map<string, number>()
  cards.forEach((c, i) => {
    if (!index.has(c.code)) index.set(c.code, i)
  })
  const next = cards.map((): number[] => [])
  for (const e of edges) next[index.get(e.from)!]!.push(index.get(e.to)!)
  // From the last card back: each card's longest chain length and the step that gives the earliest such chain.
  const length = cards.map(() => 1)
  const step = cards.map((): number | undefined => undefined)
  for (let i = cards.length - 1; i >= 0; i--) {
    for (const j of next[i]!) {
      const better = length[j]! + 1 > length[i]! || (length[j]! + 1 === length[i]! && j < step[i]!)
      if (better) {
        length[i] = length[j]! + 1
        step[i] = j
      }
    }
  }
  const longest = Math.max(...length)
  if (longest < 2) return
  const chain: number[] = []
  for (let at: number | undefined = length.indexOf(longest); at !== undefined; at = step[at]) chain.push(at)
  for (const i of chain) cards[i]!.critical = true
  for (let k = 1; k < chain.length; k++) {
    const from = cards[chain[k - 1]!]!.code
    const to = cards[chain[k]!]!.code
    const edge = edges.find((e) => e.from === from && e.to === to)
    if (edge) edge.critical = true
  }
}

/** The latest-started engineer of a slice (a missing start counts as oldest); none → undefined. */
export function engineerFor(repo: BoardRepo, planSlug: string, sprint: string, code: string): AgentRun | undefined {
  const plan = repo.model.plans.find((p) => p.slug === planSlug)
  if (!plan) return undefined
  let best: AgentRun | undefined
  for (const a of repo.agents) {
    if (!/engineer$/.test(a.type)) continue
    const role = roleOf(a, plan)
    if (role.kind !== 'slice' || role.sprint !== sprint || role.code !== code) continue
    if (!best || (a.startedAt ?? -Infinity) > (best.startedAt ?? -Infinity)) best = a
  }
  return best
}

// ---- Filters ----

/** The selected states, and the board (`repo/plan/sprint`) they were picked on. */
export type FilterState = { key: string | undefined; on: readonly CardState[] }

const ORDER: readonly CardState[] = ['needs-you', 'running', 'waiting', 'blocked', 'merged']

export const filterState = {
  /** The chips' order, as in the preview. */
  ORDER,
  /** The same state while the board stays the same; an empty one when it changes. */
  forSprint(f: FilterState | undefined, key: string | undefined): FilterState {
    return f && f.key === key ? f : { key, on: [] }
  },
  toggle(f: FilterState, s: CardState): FilterState {
    const on = f.on.includes(s) ? f.on.filter((x) => x !== s) : ORDER.filter((x) => x === s || f.on.includes(x))
    return { key: f.key, on }
  },
  isOn: (f: FilterState, s: CardState) => f.on.includes(s),
  /** With nothing selected, no card dims; else each card whose state isn't selected. */
  isDimmed: (f: FilterState, c: Pick<Card, 'state'>) => f.on.length > 0 && !f.on.includes(c.state),
}
