// The pipeline view of one plan: where it is, step by step (Plan → each sprint's
// waves → Check → Ship), and the slice log with each slice's time and tokens.
// Also the join rules the runs list shares: which agents belong to a plan, to
// which slice, wave fix, review round, or fix pass, and the plan's hand-back
// and halt. Pure. The rules and why are in pod-docs/feature-details/runs-and-pipeline.md.

import type { AgentRun, BoardRepo, PrStatus } from './board.ts'
import { formatTokens, isDone } from './pod-flow/model.ts'
import type { PlanModel, SliceModel, SprintModel, WaveModel } from './run-model.ts'
import { agentState, IDLE_GAP_MS, STALE_MS } from './transcript.ts'

/** `skipped`: the plan didn't take this step (no research, no UI); the flow shows it dim. */
export type StepState = 'done' | 'live' | 'wait' | 'you' | 'blocked' | 'unknown' | 'skipped'
/** `merge` is set only on a step that shows a PR waiting on you (see `waitingPrs`). */
export type Step = { key: string; label: string; state: StepState; detail: string; merge?: { number: number } }
export type Stage = { key: string; caption: string; steps: Step[] }
export type LogRow = { code: string; title: string; model?: string; confidence?: string; minutes?: number; tokens?: number; live: boolean }
export type LogGroup = { sprint: string; wave: number; label: string; status: string; rows: LogRow[] }
export type Pipeline = { stages: Stage[]; log: LogGroup[] }

// ---- Shared join rules (the sprint's shared contract) ----

const HAND_BACK = /complete|final PR|hand-?back|awaiting/i
const FROM_ORCHESTRATOR = /^orchestrator\b/i
const WAVE_FIX = /^(.+)-w(\d+)-fix$/

/** The plan's hand-back PR: from the last pending orchestrator entry that hands back and links `/pull/<N>`. */
export function handBackPr(plan: Pick<PlanModel, 'queue'>): number | undefined {
  const entry = plan.queue
    .filter((e) => e.isPending && FROM_ORCHESTRATOR.test(e.route.trim()) && HAND_BACK.test(e.body) && /\/pull\/\d+/.test(e.body))
    .at(-1)
  const n = entry && /\/pull\/(\d+)/.exec(entry.body)?.[1]
  return n === undefined ? undefined : Number(n)
}

/** A hand-back still waiting on you: there is one, and `prs` doesn't say its PR merged. */
export function pendingHandBack(repo: Pick<BoardRepo, 'prs'>, plan: Pick<PlanModel, 'queue'>): number | undefined {
  const n = handBackPr(plan)
  return n !== undefined && repo.prs.find((p) => p.number === n)?.state !== 'merged' ? n : undefined
}

/** A pending BLOCKED entry from the orchestrator halts the plan. */
export const isHalted = (plan: Pick<PlanModel, 'queue'>) =>
  plan.queue.some((e) => e.isPending && e.type === 'BLOCKED' && FROM_ORCHESTRATOR.test(e.route.trim()))

/** A `/pod:autopilot` run (see `PlanModel.autopilot`): pod merges its wave PRs itself unless it halts. */
export const isAutopilot = (plan: Pick<PlanModel, 'autopilot'>) => plan.autopilot === true

const TO_HUMAN = /(?:→|->)\s*human\s*$/i

/**
 * A halt entry starts with its gate (skills/autopilot/policy.md): gates 1–7, by number or by name, maybe in bold
 * or after `Autopilot`. `\b(?!-)` keeps a longer word (`safety-bounded`, `plan-complete-ish`) from reading as a gate name.
 */
const PENDING_GATE =
  /^\s*(?:\*\*)?(?:autopilot\s+)?(?:gate\s*[1-7]\b|(?:blocked-concern|plan-review-fail|auto-merge-fail|inter-wave-verify|safety-bound|escalation-valve|plan-complete)\b(?!-))/i

/**
 * Autopilot stopped for you: halted (`isHalted`), or a pending PENDING from the orchestrator to you that starts
 * with a halt gate. The policy's gates 5–7 halt with PENDING (pod has filed gate 3 that way too), and gate 6
 * withholds a mergeable PR for you to merge; the orchestrator's other PENDING notes to you (`now: …`,
 * `someday: …`, an agent default, a note that names a gate mid-sentence) don't stop it. Run state
 * still follows `isHalted` (BLOCKED → blocked; a PENDING reads needs-you).
 */
const GATE_NAMES = ['blocked-concern', 'plan-review-fail', 'auto-merge-fail', 'inter-wave-verify', 'safety-bound', 'escalation-valve', 'plan-complete']

/** The gate (1–7) an autopilot halt entry starts with, by its number or else its name; undefined when it isn't a halt. */
export function haltGate(body: string): number | undefined {
  const head = PENDING_GATE.exec(body)?.[0]
  if (head === undefined) return undefined
  const n = /gate\s*([1-7])\b/i.exec(head)?.[1]
  if (n !== undefined) return Number(n)
  const i = GATE_NAMES.findIndex((name) => head.toLowerCase().endsWith(name))
  return i < 0 ? undefined : i + 1
}

export const isAutopilotStopped = (plan: Pick<PlanModel, 'queue'>) =>
  isHalted(plan) ||
  plan.queue.some(
    (e) => e.isPending && e.type === 'PENDING' && FROM_ORCHESTRATOR.test(e.route.trim()) && TO_HUMAN.test(e.route.trim()) && PENDING_GATE.test(e.body),
  )

/** What a step with a PR waiting on you says: under autopilot, only a stop hands the merge to you. */
export const waitingWords = (plan: Pick<PlanModel, 'autopilot'>) => (isAutopilot(plan) ? 'autopilot stopped' : 'you merge')

/** A blocked or skipped slice, by its status or its PR cell. */
export const isBlockedSlice = (s: SliceModel) =>
  s.status === 'blocked' || s.status === 'skipped' || s.pr.state === 'blocked' || s.pr.state === 'skipped'

/** The ported `isDone`, on a slice of the run model: a blocked or skipped status wins over a merged PR. */
export const isSliceDone = (s: SliceModel) =>
  isDone({ wave: 0, slice: s.code, title: s.title, branch: s.branch, status: s.status, confidence: s.confidence, pr: s.pr.state === 'merged' ? 'merged' : '—' })

const isType = (a: AgentRun, role: string) => new RegExp(`(^|:)${role}$`).test(a.type)

export type AgentRole =
  | { kind: 'review' }
  | { kind: 'fix-pass' }
  | { kind: 'wave-fix'; sprint: string; wave: number }
  | { kind: 'slice'; sprint: string; code: string }
  | { kind: 'other' }

const hasCode = (s: SprintModel, code: string) => s.waves.some((w) => w.slices.some((x) => x.code === code))

/**
 * What an agent does for a plan: a review round, the fix pass, a wave's fix, a slice, or nothing of it.
 * A reviewer dispatched with `kind: fix` reviews a /pod:fix PR, never a plan's round.
 */
export function roleOf(a: AgentRun, plan: PlanModel): AgentRole {
  if (isType(a, 'reviewer')) return a.plan === plan.slug && a.kind !== 'fix' ? { kind: 'review' } : { kind: 'other' }
  const branch = a.branch ?? ''
  if (isType(a, 'engineer')) {
    if (branch === `${plan.slug}-fix`) return { kind: 'fix-pass' }
    const fix = WAVE_FIX.exec(branch)
    if (fix?.[1] && plan.sprints.some((s) => s.slug === fix[1])) return { kind: 'wave-fix', sprint: fix[1], wave: Number(fix[2]) }
  }
  if (a.slice) {
    const code = a.slice
    const sprint = a.sprint ? plan.sprints.find((s) => s.slug === a.sprint && hasCode(s, code)) : plan.sprints.find((s) => hasCode(s, code))
    if (sprint) return { kind: 'slice', sprint: sprint.slug, code }
  }
  return { kind: 'other' }
}

/** An agent belongs to a plan by its plan slug, one of its sprints, or a role in it. */
export const isPlanAgent = (a: AgentRun, plan: PlanModel) =>
  a.plan === plan.slug || plan.sprints.some((s) => s.slug === a.sprint) || roleOf(a, plan).kind !== 'other'

export const isRunning = (a: AgentRun, now: number) => agentState(a, now) === 'running'

/** A running sprint planner that names the plan. */
export const isDrafting = (agents: AgentRun[], plan: PlanModel, now: number) =>
  agents.some((a) => isType(a, 'sprint-planner') && a.plan === plan.slug && isRunning(a, now))

// ---- Which plans are runs (the runs list's rule, shared with waitingPrs) ----

export const planAgentRunning = (repo: BoardRepo, plan: PlanModel, now: number) =>
  repo.agents.some((a) => isPlanAgent(a, plan) && isRunning(a, now))

/** A port claim names the plan. pod deletes it only on resume after the merge, so it can outlive the run. */
const isClaimed = (repo: BoardRepo, plan: PlanModel) => repo.claims.some((c) => c.plan === plan.slug)

/**
 * One of the plan's agents wrote within the last STALE_MS, ended or not. It bridges the gaps between
 * close-out steps (the final review ended, the reporter not started; the reporter ended, the hand-back not written).
 */
const planAgentRecent = (repo: BoardRepo, plan: PlanModel, now: number) =>
  repo.agents.some((a) => isPlanAgent(a, plan) && a.lastAt !== undefined && now - a.lastAt < STALE_MS)

/**
 * A plan is a run while a claim names it and it isn't archived. A claimed archived plan is closing out
 * (pod archives the plan before the final merge) while its hand-back entry is pending (merged or not: pod
 * waits for `continue` to clean up after the merge), it's halted, or one of its agents wrote recently; else
 * the claim is a leftover and the plan is finished. Unclaimed, a plan is a run
 * unless it's archived or finished. Finished: every sprint done, no hand-back waiting, no halt, and none of
 * its agents running (a final review runs after the last sprint is done).
 */
export function isRun(repo: BoardRepo, plan: PlanModel, now: number): boolean {
  if (repo.error !== undefined || !repo.model.docs.supported) return false
  const claimed = isClaimed(repo, plan)
  if (claimed && plan.status !== 'archived') return true
  if (plan.status === 'archived') {
    return claimed && (handBackPr(plan) !== undefined || isHalted(plan) || planAgentRecent(repo, plan, now))
  }
  return (
    plan.sprints.some((s) => s.status !== 'done') ||
    pendingHandBack(repo, plan) !== undefined ||
    isHalted(plan) ||
    planAgentRunning(repo, plan, now)
  )
}

/**
 * The PR of a wave handed back to you. Under autopilot, pod merges it itself, so only while it is stopped
 * for you (`isAutopilotStopped`: the merge is then yours, or yours to override with); else `waveHandedPr`.
 */
export function waveWaitingPr(repo: BoardRepo, plan: PlanModel, s: SprintModel, w: WaveModel, now: number): number | undefined {
  if (isAutopilot(plan) && !isAutopilotStopped(plan)) return undefined
  return waveHandedPr(repo, plan, s, w, now)
}

/**
 * The PR of a wave whose engineers are done: the plan is listed, the sprint is current, the wave isn't
 * blocked or done, every unfinished slice is `pushed`, and none of the wave's engineers (slice or
 * `<sprint>-w<N>-fix`) runs. The first unfinished slice's open PR number that gh doesn't report
 * merged or closed (unknown counts as open). Undefined otherwise.
 */
export function waveHandedPr(repo: BoardRepo, plan: PlanModel, s: SprintModel, w: WaveModel, now: number): number | undefined {
  if (s.slug !== plan.currentSprint || w.slices.some(isBlockedSlice) || w.slices.every(isSliceDone)) return undefined
  const open = w.slices.filter((x) => !isSliceDone(x))
  if (!open.every((x) => x.status.trim().toLowerCase() === 'pushed')) return undefined
  const codes = new Set(w.slices.map((x) => x.code))
  const agentRunning = repo.agents.some((a) => {
    if (!isRunning(a, now)) return false
    const role = roleOf(a, plan)
    return (role.kind === 'slice' && role.sprint === s.slug && codes.has(role.code)) || (role.kind === 'wave-fix' && role.sprint === s.slug && role.wave === w.wave)
  })
  if (agentRunning || !isRun(repo, plan, now)) return undefined
  const gone = (n: number) => {
    const state = repo.prs.find((p) => p.number === n)?.state
    return state === 'merged' || state === 'closed'
  }
  return open.find((x) => x.pr.state === 'open' && x.pr.number !== undefined && !gone(x.pr.number))?.pr.number
}

/** The plan's pending hand-back PR, while the plan is on the runs list. */
export const finalWaitingPr = (repo: BoardRepo, plan: PlanModel, now: number): number | undefined =>
  isRun(repo, plan, now) ? pendingHandBack(repo, plan) : undefined

const STAGING = /staging/i

/** The plan's final PR: the hand-back's PR when gh knows it, else the PR gh found on the plan's branch. */
export function finalPr(repo: Pick<BoardRepo, 'prs'>, plan: PlanModel): PrStatus | undefined {
  const n = handBackPr(plan)
  return (n === undefined ? undefined : repo.prs.find((p) => p.number === n)) ?? prByBranch(repo, plan.slug)
}

/** The plan's staging branch: its final PR's base when that is a staging branch, else the repo's decision. */
export function stagingOf(repo: Pick<BoardRepo, 'model' | 'prs'>, plan: PlanModel): string | undefined {
  const base = finalPr(repo, plan)?.base
  if (base !== undefined && STAGING.test(base)) return base
  return repo.model.staging
}

/**
 * The final PR merged, as the Ship step reads it: the hand-back's PR once gh says merged, else (no
 * hand-back) the PR gh found on the plan's branch merged.
 */
export function finalMerged(repo: Pick<BoardRepo, 'prs'>, plan: PlanModel): boolean {
  if (handBackPr(plan) !== undefined) return pendingHandBack(repo, plan) === undefined
  return prByBranch(repo, plan.slug)?.state === 'merged'
}

/**
 * The staging branch's open PR to main, once the plan's final PR merged; undefined with no staging
 * branch. An open one always counts and needs you: pod's gate 7 opens it, or reuses one an earlier plan
 * left open (so its number can be below the final PR's). Only `open` counts: a closed or merged one
 * can't be shown to be this plan's.
 */
export function stagingPr(repo: Pick<BoardRepo, 'model' | 'prs'>, plan: PlanModel): number | undefined {
  const branch = stagingOf(repo, plan)
  if (branch === undefined || !finalMerged(repo, plan)) return undefined
  const pr = prByBranch(repo, branch)
  return pr?.state === 'open' ? pr.number : undefined
}

/** The staging PR waiting on you, while the plan is on the runs list. */
export const stagingWaitingPr = (repo: BoardRepo, plan: PlanModel, now: number): number | undefined =>
  isRun(repo, plan, now) ? stagingPr(repo, plan) : undefined

/** A plan run's state, as the runs list shows it. */
export type PlanState = 'blocked' | 'needs-you' | 'running' | 'idle'

/** First match wins: blocked → needs-you (an ask, a wave PR, or the staging PR waiting on you) → running → idle. */
export function planState(repo: BoardRepo, plan: PlanModel, now: number): PlanState {
  const current = plan.sprints.find((s) => s.slug === plan.currentSprint)
  const slices = current?.waves.flatMap((w) => w.slices) ?? []
  if (isHalted(plan) || slices.some(isBlockedSlice)) return 'blocked'
  if (
    plan.queue.some((e) => e.needsYou) ||
    current?.waves.some((w) => waveWaitingPr(repo, plan, current, w, now) !== undefined) ||
    stagingPr(repo, plan) !== undefined
  )
    return 'needs-you'
  const wave = current?.waves.find((w) => w.wave === current.currentWave)
  if (planAgentRunning(repo, plan, now) || wave?.slices.some((s) => s.status === 'pushed')) return 'running'
  return 'idle'
}

// ---- The pipeline ----

type Ctx = { repo: BoardRepo; plan: PlanModel; now: number; agents: { a: AgentRun; role: AgentRole; live: boolean }[]; state: PlanState }

/** The plan's pipeline stages and slice log; undefined for a plan the repo doesn't have. Never throws. */
export function buildPipeline(repo: BoardRepo, planSlug: string, now: number): Pipeline | undefined {
  const plan = repo.model.plans.find((p) => p.slug === planSlug)
  if (!plan) return undefined
  const agents = repo.agents.map((a) => ({ a, role: roleOf(a, plan), live: isRunning(a, now) }))
  const ctx: Ctx = { repo, plan, now, agents, state: planState(repo, plan, now) }
  const n = plan.sprints.length
  const stages: Stage[] = [
    {
      key: 'plan',
      caption: 'Plan',
      // Autopilot records no Go: the run starts on its own command.
      steps: [
        { key: 'plan', label: 'Plan', state: 'done', detail: count(n, 'sprint') },
        ...(isAutopilot(plan) ? [] : [{ key: 'go', label: 'Go', state: 'unknown' as const, detail: 'not recorded yet' }]),
      ],
    },
    ...plan.sprints.map((s, i) => ({ key: `sprint:${s.slug}`, caption: `Sprint ${i + 1} of ${n}`, steps: sprintSteps(ctx, s) })),
    { key: 'check', caption: 'Check', steps: checkSteps(ctx) },
    { key: 'ship', caption: 'Ship', steps: [shipStep(ctx)] },
  ]
  const log = plan.sprints.flatMap((s, i) => (s.hasDoc ? s.waves.map((w) => logGroup(ctx, s, i, w)) : []))
  return { stages, log }
}

const plural = (n: number, word: string) => (n === 1 ? word : word.endsWith('s') ? `${word}es` : `${word}s`)
const count = (n: number, word: string) => `${n} ${plural(n, word)}`

function sprintSteps(ctx: Ctx, s: SprintModel): Step[] {
  const one = (state: StepState, detail: string): Step[] => [{ key: s.slug, label: s.slug, state, detail }]
  if (s.status === 'done') return one('done', s.hasDoc ? count(s.waves.length, 'wave') : 'done')
  if (s.slug === ctx.plan.currentSprint && s.waves.length > 0) {
    return s.waves.map((w) => {
      const state = waveState(ctx, s, w)
      const step: Step = { key: `${s.slug}/wave-${w.wave}`, label: `Wave ${w.wave}`, state, detail: waveDetail(ctx, s, w, state) }
      const n = state === 'you' ? waveWaitingPr(ctx.repo, ctx.plan, s, w, ctx.now) : undefined
      if (n !== undefined) return Object.assign(step, { detail: `PR #${n} · ${waitingWords(ctx.plan)}`, merge: { number: n } })
      // Autopilot, not stopped at this wave: the PR is pod's to merge. No merge here; the card's state is
      // the wave's own (running while its engineer works, else the run's), and its detail says pod merges.
      const auto = state !== 'done' && isAutopilot(ctx.plan) && isWaveLive(ctx, s, w) ? waveHandedPr(ctx.repo, ctx.plan, s, w, ctx.now) : undefined
      if (auto !== undefined) step.detail = `PR #${auto} · autopilot merges`
      return step
    })
  }
  if (s.slug === ctx.plan.currentSprint && isDrafting(ctx.repo.agents, ctx.plan, ctx.now)) return one('live', 'drafting')
  const slices = s.waves.reduce((k, w) => k + w.slices.length, 0)
  return one('wait', slices > 0 ? `${count(slices, 'slice')} planned` : 'not drafted')
}

function waveAgents(ctx: Ctx, s: SprintModel, w: WaveModel) {
  const codes = new Set(w.slices.map((x) => x.code))
  return ctx.agents.filter(
    ({ role }) =>
      (role.kind === 'slice' && role.sprint === s.slug && codes.has(role.code)) ||
      (role.kind === 'wave-fix' && role.sprint === s.slug && role.wave === w.wave),
  )
}

function sliceAgents(ctx: Ctx, s: SprintModel, code: string) {
  return ctx.agents.filter(({ role }) => role.kind === 'slice' && role.sprint === s.slug && role.code === code)
}

/**
 * Wave step state, first match wins: blocked → done → you → live → wait.
 * A done wave reads done even with a pending ask for the human. Only an ask naming one
 * of its unfinished slices, or a PR waiting on you, makes a wave `you`, so it agrees with its cards.
 */
function waveState(ctx: Ctx, s: SprintModel, w: WaveModel): StepState {
  if (w.slices.some(isBlockedSlice)) return 'blocked'
  if (w.slices.every(isSliceDone)) return 'done'
  const open = new Set(w.slices.filter((x) => !isSliceDone(x)).map((x) => x.code))
  const asks = ctx.plan.queue.some((e) => e.needsYou && e.slice !== undefined && open.has(e.slice) && (e.sprint === undefined || e.sprint === s.slug))
  if (asks || waveWaitingPr(ctx.repo, ctx.plan, s, w, ctx.now) !== undefined) return 'you'
  if (!isWaveLive(ctx, s, w)) return 'wait'
  // The wave in progress: running while one of its own engineers runs; otherwise the run's state
  // (running, as when autopilot merges its PR; blocked; needs you; or waiting when the run is idle).
  return waveAgents(ctx, s, w).some((x) => x.live) ? 'live' : IN_PROGRESS_STEP[ctx.state]
}

/** The flow's wave in progress with no engineer of its own at work, by the run's state. */
const IN_PROGRESS_STEP: Record<PlanState, StepState> = { blocked: 'blocked', 'needs-you': 'you', running: 'live', idle: 'wait' }

/** The current wave of the current sprint, a pushed slice, or one of the wave's engineers running. */
function isWaveLive(ctx: Ctx, s: SprintModel, w: WaveModel): boolean {
  const current = s.slug === ctx.plan.currentSprint && s.currentWave === w.wave
  return current || w.slices.some((x) => x.status === 'pushed') || waveAgents(ctx, s, w).some((x) => x.live)
}

/**
 * Active minutes and tokens of a group of agents. Minutes: the agents' active spans joined, so
 * parallel engineers count once and an idle gap (over IDLE_GAP_MS between records) not at all. A live
 * agent's last span runs on to now while its last record is within IDLE_GAP_MS. Nothing with no agents.
 */
export function spend(agents: { a: AgentRun; live: boolean }[], now: number): { minutes?: number; tokens?: number } {
  if (agents.length === 0) return {}
  const out: { minutes?: number; tokens?: number } = {}
  const spans = agents.flatMap(({ a, live }) => activeSpans(a, live, now))
  if (spans.length > 0) out.minutes = Math.round(joinedLength(spans) / 60_000)
  const tokens = agents.reduce((sum, { a }) => sum + (Number.isFinite(a.tokens) ? a.tokens : 0), 0)
  if (tokens > 0) out.tokens = tokens
  return out
}

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v)

/** An agent's active spans; one with none (a Board from before spans) is one span from its start to its last record. */
function activeSpans(a: AgentRun, live: boolean, now: number): [number, number][] {
  const spans: [number, number][] = (a.active ?? (finite(a.startedAt) && finite(a.lastAt) ? [[a.startedAt, a.lastAt]] : []))
    .filter(([from, to]) => finite(from) && finite(to) && to >= from)
    .map(([from, to]) => [from, to])
  const last = spans.at(-1)
  if (live && last && now >= last[1] && now - last[1] <= IDLE_GAP_MS) last[1] = now
  return spans
}

/**
 * The spans' length once joined as one stream of records: overlaps count once, and a gap between
 * one agent's last record and the next one's first counts only when it is within IDLE_GAP_MS, the
 * same rule as inside one transcript (an orchestrator's minute between two engineers is work).
 */
function joinedLength(spans: [number, number][]): number {
  let total = 0
  let end = Number.NEGATIVE_INFINITY
  for (const [from, to] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (to <= end) continue
    total += to - (from - end <= IDLE_GAP_MS ? end : from)
    end = to
  }
  return total
}

function waveDetail(ctx: Ctx, s: SprintModel, w: WaveModel, state: StepState): string {
  // A wave not reached yet; the wave in progress keeps its plain count while it waits.
  if (state === 'wait' && !isWaveLive(ctx, s, w)) return `${count(w.slices.length, 'slice')} planned`
  const agents = waveAgents(ctx, s, w)
  if (agents.length === 0) return count(w.slices.length, 'slice')
  const live = state === 'live'
  const { minutes, tokens } = spend(agents, ctx.now)
  const parts = [count(agents.length, 'engineer')]
  if (minutes !== undefined) parts.push(live ? `${minutes} min so far` : `${minutes} min`)
  if (!live && tokens !== undefined) parts.push(`${formatTokens(tokens)} tok`)
  return parts.join(' · ')
}

function checkSteps(ctx: Ctx): Step[] {
  const of = (kind: AgentRole['kind']) =>
    ctx.agents.filter((x) => x.role.kind === kind).sort((x, y) => (x.a.startedAt ?? 0) - (y.a.startedAt ?? 0))
  const reviews = of('review')
  const passes = of('fix-pass')
  const liveReview = reviews.findLast((x) => x.live)
  const livePass = passes.findIndex((x) => x.live)

  const review: Step = liveReview
    ? { key: 'review', label: 'Final review', state: 'live', detail: `round ${liveReview.a.round ?? reviews.indexOf(liveReview) + 1}` }
    : reviews.length > 0
      ? { key: 'review', label: 'Final review', state: 'done', detail: count(reviews.length, 'round') }
      : { key: 'review', label: 'Final review', state: 'wait', detail: 'not started' }
  const fix: Step =
    livePass >= 0
      ? { key: 'fix', label: 'Fix pass', state: 'live', detail: `pass ${livePass + 1}` }
      : passes.length > 0
        ? { key: 'fix', label: 'Fix pass', state: 'done', detail: count(passes.length, 'pass') }
        : { key: 'fix', label: 'Fix pass', state: 'wait', detail: 'only if review fails' }
  return [review, fix]
}

/** A PR gh found by its head branch: a fix run's `fix-<slug>`, or a plan's final PR on `<plan-slug>`. */
export const prByBranch = (repo: Pick<BoardRepo, 'prs'>, branch: string): PrStatus | undefined => repo.prs.find((p) => p.branch === branch)

/**
 * The hand-back's PR wins once it exists. Before it, the PR gh found on the plan's branch: open
 * reads `after review` (pod hands it back only after the final review), merged done, closed blocked.
 */
function shipStep(ctx: Ctx): Step {
  const n = handBackPr(ctx.plan)
  if (n === undefined) {
    const pr = prByBranch(ctx.repo, ctx.plan.slug)
    if (!pr) return { key: 'final-pr', label: 'Final PR', state: 'wait', detail: 'not open yet' }
    if (pr.state === 'merged') return { key: 'final-pr', label: 'Final PR', state: 'done', detail: `merged PR #${pr.number}` }
    if (pr.state === 'closed') return { key: 'final-pr', label: 'Final PR', state: 'blocked', detail: `PR #${pr.number} · closed` }
    return { key: 'final-pr', label: 'Final PR', state: 'wait', detail: `PR #${pr.number} · after review` }
  }
  if (pendingHandBack(ctx.repo, ctx.plan) === undefined) return { key: 'final-pr', label: 'Final PR', state: 'done', detail: `merged PR #${n}` }
  const step: Step = { key: 'final-pr', label: 'Final PR', state: 'you', detail: `PR #${n} · you merge` }
  if (finalWaitingPr(ctx.repo, ctx.plan, ctx.now) !== undefined) step.merge = { number: n }
  return step
}

/** Status, first match wins: blocked → merged (PR #N) → PR #N open → running → planned. */
function logStatus(ctx: Ctx, s: SprintModel, w: WaveModel): string {
  if (w.slices.some(isBlockedSlice)) return 'blocked'
  const numbered = w.slices.find((x) => x.pr.number !== undefined)?.pr.number
  if (w.slices.every(isSliceDone)) return numbered === undefined ? 'merged' : `merged PR #${numbered}`
  const open = w.slices.find((x) => x.pr.state === 'open' && x.pr.number !== undefined)?.pr.number
  if (open !== undefined) return `PR #${open} open`
  if (!isWaveLive(ctx, s, w)) return 'planned'
  // An engineer at work on this wave is a fact about it: running. Otherwise the wave in progress says
  // what the run does (running, blocked, needs you, or waiting when idle), as the flow's wave card does.
  return waveAgents(ctx, s, w).some((x) => x.live) ? 'running' : IN_PROGRESS[ctx.state]
}

const IN_PROGRESS: Record<PlanState, string> = { blocked: 'blocked', 'needs-you': 'needs you', running: 'running', idle: 'waiting' }

const NO_CONFIDENCE = new Set(['', '—', '-'])

function logGroup(ctx: Ctx, s: SprintModel, i: number, w: WaveModel): LogGroup {
  const rows = w.slices.map((x): LogRow => {
    const agents = sliceAgents(ctx, s, x.code)
    const live = agents.some((y) => y.live)
    const row: LogRow = { code: x.code, title: x.title, live }
    if (x.model) row.model = x.model
    if (!NO_CONFIDENCE.has(x.confidence.trim())) row.confidence = x.confidence.trim()
    Object.assign(row, spend(agents, ctx.now))
    return row
  })
  return { sprint: s.slug, wave: w.wave, label: `Sprint ${i + 1} · wave ${w.wave}`, status: logStatus(ctx, s, w), rows }
}
