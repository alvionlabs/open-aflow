// The run's flow: Think → You → Sprint → Check → Ship. Every step but the sprint
// waves is one entry in FLOW_STEPS: its id, column, label, and a reader that takes its state and
// detail from the repo model (and the pipeline already built from it). To add a step, add one entry
// and its reader's test; to remove one, delete its entry. A reader that returns nothing leaves its
// step out (Replied go on an autopilot run, Staging → main with no staging branch); a column with no
// steps is left out. The Sprint column stacks every sprint in plan order: a done sprint as one card,
// the current one as its waves, a later one as one waiting card. These come from the sprint docs, as
// `buildPipeline` reads them.
// Rule: a step is `done` only on data that proves it; with nothing to read it is `unknown` ("not recorded").
// Pure. The rules and why are in pod-docs/feature-details/runs-and-pipeline.md.

import type { AgentRun, BoardRepo } from './board.ts'
import {
  buildPipeline,
  finalPr,
  handBackPr,
  isRunning,
  prByBranch,
  spend,
  stagingOf,
  type Pipeline,
  type Stage,
  type Step,
  type StepState,
} from './pipeline.ts'
import type { PlanModel } from './run-model.ts'

export type FlowColumnKey = 'think' | 'you' | 'check' | 'ship'
/** What a reader finds. `merge` is never set here: the Next step card owns Merge. */
export type FlowReading = { state: StepState; detail: string }
export type FlowCtx = { repo: BoardRepo; plan: PlanModel; now: number; pipeline: Pipeline }
export type FlowStepDef = { id: string; column: FlowColumnKey; label: string; read: (ctx: FlowCtx) => FlowReading | undefined }

/** The columns in order; `sprints` stands for the one Sprint column, which holds every sprint. */
const COLUMNS: ({ key: FlowColumnKey; caption: string } | 'sprints')[] = [
  { key: 'think', caption: 'Think' },
  { key: 'you', caption: 'You' },
  'sprints',
  { key: 'check', caption: 'Check' },
  { key: 'ship', caption: 'Ship' },
]

const NOT_RECORDED: FlowReading = { state: 'unknown', detail: 'not recorded' }

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`

/**
 * A step `buildPipeline` already reads, found by its stage and its key, as a reading; undefined when
 * the pipeline has none. Only in its own stage: a sprint slugged `review` or `fix` has a step with the
 * same key in its sprint stage.
 */
const fromPipeline =
  (stage: 'plan' | 'check' | 'ship', key: string) =>
  ({ pipeline }: FlowCtx): FlowReading | undefined => {
    const step = pipeline.stages.find((s) => s.key === stage)?.steps.find((s) => s.key === key)
    return step && { state: step.state, detail: step.detail }
  }

/** The plan's researchers: `pod:researcher` agents dispatched with this plan. */
const researchersOf = (ctx: FlowCtx): AgentRun[] => ctx.repo.agents.filter((a) => a.type === 'pod:researcher' && a.plan === ctx.plan.slug)

/**
 * Done with a report: `pod-docs/research/<plan>.md`, or one the plan doc links that exists. Detail: the
 * plan's researchers and their active minutes, else "report". No report: running while a researcher
 * runs, `not recorded` for a link to a missing report, else skipped.
 */
function readResearch(ctx: FlowCtx): FlowReading {
  const reports = new Set(ctx.repo.model.research ?? [])
  const links = ctx.plan.researchLinks ?? []
  const agents = researchersOf(ctx).map((a) => ({ a, live: isRunning(a, ctx.now) }))
  const { minutes } = spend(agents, ctx.now)
  const who = (soFar: boolean) => `${plural(agents.length, 'researcher')}${minutes === undefined ? '' : ` · ${minutes} min${soFar ? ' so far' : ''}`}`
  if (reports.has(ctx.plan.slug) || links.some((l) => reports.has(l))) return { state: 'done', detail: agents.length > 0 ? who(false) : 'report' }
  if (agents.some((x) => x.live)) return { state: 'live', detail: who(true) }
  if (links.length > 0) return NOT_RECORDED
  return { state: 'skipped', detail: 'no research' }
}

/** Done when the plan doc records `Grilled-with:`. pod records no question count, so the detail is the tool. */
function readInterview({ plan }: FlowCtx): FlowReading {
  return plan.grilledWith === undefined ? NOT_RECORDED : { state: 'done', detail: `grilled with ${plan.grilledWith}` }
}

/** Done with a `## Look` that says something; skipped with no Look or one that says no UI; an empty Look proves nothing. */
function readLook({ plan }: FlowCtx): FlowReading {
  const look = plan.look
  if (!look || look.kind === 'none') return { state: 'skipped', detail: 'no UI' }
  if (look.kind === 'empty') return NOT_RECORDED
  return { state: 'done', detail: look.direction ?? 'look set' }
}

/**
 * Left out with no staging branch. Waits until the final PR merges; then the staging branch's PR to
 * main (found by its head). An open one always counts and needs you: pod's gate 7 opens it, or reuses
 * one an earlier plan left open (so its number can be below the final PR's); `stagingPr` reads the same
 * rule for `waitingPrs`, so the Next step card offers its Merge. pod-staging is reused by every plan, so a
 * merged one counts as done only when gh's merge times show it merged after the final PR; a merged PR
 * with no times, or a closed one, can't be shown to be this plan's and reads `not open yet`.
 */
function readStaging(ctx: FlowCtx): FlowReading | undefined {
  const branch = stagingOf(ctx.repo, ctx.plan)
  if (branch === undefined) return undefined
  const final = finalPr(ctx.repo, ctx.plan)
  const shipped = fromPipeline('ship', 'final-pr')(ctx)?.state === 'done'
  if (!shipped) return { state: 'wait', detail: 'after the final PR' }
  const pr = prByBranch(ctx.repo, branch)
  if (pr?.state === 'open') return { state: 'you', detail: `PR #${pr.number} · you merge` }
  const after = pr?.state === 'merged' && pr.mergedAt !== undefined && final?.mergedAt !== undefined && pr.mergedAt > final.mergedAt
  if (pr && after) return { state: 'done', detail: `merged PR #${pr.number}` }
  return { state: 'wait', detail: 'not open yet' }
}

/** The flow's steps, in order within each column. */
export const FLOW_STEPS: FlowStepDef[] = [
  { id: 'research', column: 'think', label: 'Research', read: readResearch },
  { id: 'interview', column: 'think', label: 'Plan interview', read: readInterview },
  { id: 'look', column: 'you', label: 'Look picked', read: readLook },
  // Autopilot records no Go: the pipeline has no Go step, so this reads nothing and drops out.
  { id: 'go', column: 'you', label: 'Replied go', read: fromPipeline('plan', 'go') },
  { id: 'review', column: 'check', label: 'Final review', read: fromPipeline('check', 'review') },
  { id: 'fix', column: 'check', label: 'Fix pass', read: fromPipeline('check', 'fix') },
  { id: 'final-pr', column: 'ship', label: 'Final PR', read: fromPipeline('ship', 'final-pr') },
  { id: 'staging', column: 'ship', label: 'Staging → main', read: readStaging },
]

/**
 * Every sprint's steps in one column, in plan order, captioned `Sprint N of M`: N is the current sprint,
 * or M once none is current (all done, or the plan archived). Left out with no sprints.
 */
function sprintColumn(plan: PlanModel, pipeline: Pipeline): Stage[] {
  const steps = pipeline.stages.filter((s) => s.key.startsWith('sprint:')).flatMap((s) => s.steps)
  if (steps.length === 0) return []
  const m = plan.sprints.length
  const at = plan.sprints.findIndex((s) => s.slug === plan.currentSprint)
  return [{ key: 'sprint', caption: `Sprint ${at >= 0 ? at + 1 : m} of ${m}`, steps }]
}

/** The plan's flow as stages; undefined for a plan the repo doesn't have. `steps` is the registry (tests pass their own). */
export function buildFlow(repo: BoardRepo, planSlug: string, now: number, steps: FlowStepDef[] = FLOW_STEPS): Stage[] | undefined {
  const plan = repo.model.plans.find((p) => p.slug === planSlug)
  const pipeline = plan && buildPipeline(repo, planSlug, now)
  if (!plan || !pipeline) return undefined
  const ctx: FlowCtx = { repo, plan, now, pipeline }
  return COLUMNS.flatMap((col): Stage[] => {
    if (col === 'sprints') return sprintColumn(plan, pipeline)
    const found = steps
      .filter((d) => d.column === col.key)
      .flatMap((d): Step[] => {
        const r = d.read(ctx)
        return r ? [{ key: d.id, label: d.label, state: r.state, detail: r.detail }] : []
      })
    return found.length > 0 ? [{ key: col.key, caption: col.caption, steps: found }] : []
  })
}

/**
 * The staging branches gh is asked about, by head: per plan that has reached its final PR (a hand-back,
 * every sprint done, or a final PR found), its staging branch. Each once.
 */
export function stagingBranches(repo: Pick<BoardRepo, 'model' | 'prs' | 'claims'>): string[] {
  const out = new Set<string>()
  for (const plan of repo.model.plans) {
    const atFinal =
      handBackPr(plan) !== undefined ||
      finalPr(repo, plan) !== undefined ||
      (plan.status !== 'archived' && plan.status !== 'done' && plan.sprints.length > 0 && plan.sprints.every((s) => s.status === 'done'))
    const branch = atFinal ? stagingOf(repo, plan) : undefined
    if (branch !== undefined) out.add(branch)
  }
  return [...out]
}
