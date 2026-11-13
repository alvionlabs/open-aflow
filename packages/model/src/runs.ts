// The runs list: one row per live plan across every repo on the board, with
// where it is and what state it's in, newest activity first.
// Pure. The rules and why are in pod-docs/feature-details/runs-and-pipeline.md.

import type { Board, BoardRepo, PrStatus } from './board.ts'
import { fixPr, fixRunAgents, fixRuns } from './fix-runs.ts'
import { handBackPr, isDrafting, isPlanAgent, isRun, isRunning, pendingHandBack, planState, prByBranch, roleOf } from './pipeline.ts'
import type { PlanModel } from './run-model.ts'

export type RunState = 'blocked' | 'needs-you' | 'running' | 'idle' | 'unsupported' | 'error'

export type RunSummary = {
  repoId: string
  repo: string
  /** The plan slug; for a one-off run, its claim name `task-<slug>` or `fix-<slug>`, which names no plan. */
  plan?: string
  /** Set on a one-off run (/pod:task, or /pod:fix on older pod): its slug. `oneOffKind(plan)` gives which. */
  fix?: string
  title?: string
  where: string
  state: RunState
  portBase?: number
}

const ACTIVE = new Set<RunState>(['blocked', 'needs-you', 'running'])

/**
 * Every run on the board, newest activity first (`runActivity`), then repo name, then plan slug. A row with
 * no activity comes last. State doesn't order it, and `now` never does: one Board gives one order.
 */
export function listRuns(board: Board, now: number): RunSummary[] {
  const rows = board.repos.flatMap((repo) => repoRuns(repo, now).map((run) => ({ run, at: runActivity(repo, run) })))
  return rows.sort(byOrder).map((r) => r.run)
}

/** How many runs are blocked, need you, or are running. */
export const activeRuns = (runs: RunSummary[]) => runs.filter((r) => ACTIVE.has(r.state)).length

function repoRuns(repo: BoardRepo, now: number): RunSummary[] {
  const base = { repoId: repo.id, repo: repo.name }
  if (repo.error !== undefined) return [{ ...base, where: repo.error || 'cannot read repo', state: 'error' }]
  if (!repo.model.docs.supported) return [{ ...base, where: 'update pod', state: 'unsupported' }]
  const runs = repo.model.plans.filter((p) => isRun(repo, p, now)).map((p) => planRun(repo, p, now))
  runs.push(...fixRuns(repo, now).map((f) => ({ ...base, ...f })))
  return runs.length > 0 ? runs : [{ ...base, where: 'no active plan', state: 'idle' }]
}

function planRun(repo: BoardRepo, plan: PlanModel, now: number): RunSummary {
  const run: RunSummary = { repoId: repo.id, repo: repo.name, plan: plan.slug, title: plan.title, where: where(repo, plan, now), state: planState(repo, plan, now) }
  const portBase = repo.claims.find((c) => c.plan === plan.slug)?.portBase ?? plan.portBase
  if (portBase !== undefined) run.portBase = portBase
  return run
}

function where(repo: BoardRepo, plan: PlanModel, now: number): string {
  const current = plan.sprints.find((s) => s.slug === plan.currentSprint)
  if (current) {
    const last = current.waves.at(-1)
    if (current.hasDoc && last) return `${current.slug} · wave ${current.currentWave ?? last.wave}/${last.wave}`
    return `${current.slug} · ${isDrafting(repo.agents, plan, now) ? 'drafting' : 'not drafted'}`
  }
  if (repo.agents.some((a) => roleOf(a, plan).kind === 'review' && isRunning(a, now))) return 'final review'
  if (pendingHandBack(repo, plan) !== undefined) return 'final PR'
  // A listed archived plan is closing out: only a claim lists one, and the report comes before the final merge.
  if (plan.status === 'archived') return 'closing out'
  return 'all sprints done'
}

const text = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)

type Row = { run: RunSummary; at: number | undefined }

function byOrder(a: Row, b: Row): number {
  if (a.at !== b.at) return a.at === undefined ? 1 : b.at === undefined ? -1 : b.at - a.at
  return text(a.run.repo, b.run.repo) || text(a.run.plan ?? '', b.run.plan ?? '')
}

/**
 * When the run last did anything, from the Board's data only: the newest of its agents' `lastAt`, the date
 * of each queue entry tagged with the plan, and the `openedAt` and `mergedAt` of its PRs. `undefined` for a
 * row with none, and for an error, `update pod`, or `no active plan` row.
 */
export function runActivity(repo: BoardRepo, run: RunSummary): number | undefined {
  if (run.plan === undefined) return undefined
  const times = run.fix !== undefined ? oneOffTimes(repo, run.plan) : planTimes(repo, run.plan)
  const known = times.filter((t): t is number => t !== undefined && Number.isFinite(t))
  return known.length > 0 ? Math.max(...known) : undefined
}

const prTimes = (pr: PrStatus | undefined) => [pr?.openedAt, pr?.mergedAt]

function oneOffTimes(repo: BoardRepo, name: string): (number | undefined)[] {
  // fixRunAgents reads no clock: its time argument is unused.
  return [...fixRunAgents(repo, name, 0).map((a) => a.lastAt), ...prTimes(fixPr(repo, name))]
}

function planTimes(repo: BoardRepo, slug: string): (number | undefined)[] {
  const plan = repo.model.plans.find((p) => p.slug === slug)
  const agents = plan ? repo.agents.filter((a) => isPlanAgent(a, plan)).map((a) => a.lastAt) : []
  const dates = repo.model.queue.filter((e) => e.plan === slug && e.date !== undefined).map((e) => Date.parse(`${e.date}T00:00:00Z`))
  const numbers = new Set<number>()
  for (const s of plan?.sprints ?? []) for (const w of s.waves) for (const x of w.slices) if (x.pr.number !== undefined) numbers.add(x.pr.number)
  const hand = plan ? handBackPr(plan) : undefined
  if (hand !== undefined) numbers.add(hand)
  const prs = [...repo.prs.filter((p) => numbers.has(p.number)), prByBranch(repo, slug)]
  return [...agents, ...dates, ...prs.flatMap(prTimes)]
}
