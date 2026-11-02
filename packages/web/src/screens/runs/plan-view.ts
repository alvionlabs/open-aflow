// The run's flow (columns of step cards), its fold line for phones, and the run header (title, meta
// line, progress strip, `Wave N of M`), from the model's flow. Pure; the Flow and the header only render these.

import { buildFlow, fixPr, fixRunAgents, isPlanAgent, type BoardRepo, type RunSummary, type Stage, type Step, type StepState } from '@pod-board/model'

export type Segment = 'done' | 'current' | 'rest'
/** `meta`: `<repo> · <Plan|Fix> · started <when>`, unknown parts left out; empty for a repo row, whose title is the repo. */
export type RunHeader = { title: string; meta: string; segments: Segment[]; wave?: string }

/** The SVG mark of each state (names in theme/icons.tsx). */
export type FlowMark = 'check' | 'dot' | 'alert' | 'blocked' | 'circle'
/** `optional`: a step that only runs if an earlier one fails (Fix pass); the line into it is dashed. */
export type FlowStep = { key: string; label: string; detail: string; state: StepState; word: string; mark: FlowMark; highlight: boolean; dim: boolean; optional: boolean }
export type FlowColumn = { key: string; caption: string; steps: FlowStep[] }
export type FoldLine = { label: string; detail: string; mark: FlowMark; word: string; state: StepState }

const WORDS: Record<StepState, string> = {
  done: 'done',
  live: 'running',
  wait: 'waiting',
  you: 'needs you',
  blocked: 'blocked',
  unknown: 'unknown',
  skipped: 'skipped',
}

const MARKS: Record<StepState, FlowMark> = { done: 'check', live: 'dot', you: 'alert', blocked: 'blocked', wait: 'circle', unknown: 'circle', skipped: 'circle' }

/** Steps that ask for an eye: the highlighted border. */
const HIGHLIGHT = new Set<StepState>(['live', 'you', 'blocked'])
/** Steps not reached yet, not recorded, or not taken: dim. */
const DIM = new Set<StepState>(['wait', 'unknown', 'skipped'])
/**
 * Optional steps (only run if a review fails), by full flow key (`<column>:<step>`), and the review
 * step each branches off: a plan's Fix pass after the Final review, a fix run's after Round 1. Full
 * keys, so a sprint slugged `fix` or `review` in the Sprint column is never taken for one.
 */
const DETOURS: Record<string, string> = { 'check:fix': 'check:review', 'build:fix-pass': 'review:round-1' }
/** Steps the strip counts as done once a later step started: the board can't see them happen. */
const UNSEEN = new Set<StepState>(['unknown', 'skipped'])

/** One column per stage that has steps, in flow order; each step with its mark, word, and look. */
export function flowColumns(stages: Stage[]): FlowColumn[] {
  return stages
    .filter((stage) => stage.steps.length > 0)
    .map((stage) => ({
      key: stage.key,
      caption: stage.caption,
      steps: stage.steps.map((step) => ({
        key: `${stage.key}:${step.key}`,
        label: step.label,
        detail: step.detail,
        state: step.state,
        word: WORDS[step.state],
        mark: MARKS[step.state],
        highlight: HIGHLIGHT.has(step.state),
        dim: DIM.has(step.state),
        optional: `${stage.key}:${step.key}` in DETOURS,
      })),
    }))
}

/** The current step's index: the first blocked, you or live step; else the first wait; else none (-1). */
function currentIndex(states: StepState[]): number {
  const active = states.findIndex((s) => HIGHLIGHT.has(s))
  return active >= 0 ? active : states.indexOf('wait')
}

/** The phone's one-line flow: the current step, else the last step (everything done). */
export function foldLine(columns: FlowColumn[]): FoldLine | undefined {
  const steps = columns.flatMap((c) => c.steps)
  const step = steps[currentIndex(steps.map((s) => s.state))] ?? steps.at(-1)
  return step && { label: step.label, detail: step.detail, mark: step.mark, word: step.word, state: step.state }
}

/**
 * The progress strip: done, current, or rest per flow step. An `unknown` or `skipped` step counts as
 * done once any later step is neither waiting nor itself unseen.
 */
function segments(steps: Step[]): Segment[] {
  const states = steps.map((s) => s.state)
  const current = currentIndex(states)
  return steps.map((s, i): Segment => {
    if (i === current) return 'current'
    if (s.state === 'done') return 'done'
    if (UNSEEN.has(s.state) && states.slice(i + 1).some((x) => x !== 'wait' && !UNSEEN.has(x))) return 'done'
    return 'rest'
  })
}

/** `Wave N of M`, by runs.ts's rule (N is the current wave, else the last), for a current sprint with a doc and waves. */
function waveText(run: RunSummary, repo: BoardRepo): string | undefined {
  const plan = repo.model.plans.find((p) => p.slug === run.plan)
  const sprint = plan?.sprints.find((s) => s.slug === plan.currentSprint)
  const last = sprint?.waves.at(-1)
  if (!sprint?.hasDoc || !last) return undefined
  return `Wave ${sprint.currentWave ?? last.wave} of ${last.wave}`
}

/** POD_BOARD_TRANSCRIPT_DAYS when the Board doesn't say. */
export const TRANSCRIPT_DAYS = 30

/**
 * The header above the flow; undefined with no run or repo, or a run of another repo. `transcriptDays`:
 * the Board's transcript window, which decides whether the earliest agent start can be trusted.
 */
export function runHeader(run: RunSummary | undefined, repo: BoardRepo | undefined, now: number, transcriptDays = TRANSCRIPT_DAYS): RunHeader | undefined {
  if (!run || !repo || run.repoId !== repo.id) return undefined
  // A fix run's claim name and a repo row name no plan, so they have no flow and no strip.
  const flow = run.fix === undefined && run.plan !== undefined ? buildFlow(repo, run.plan, now) : undefined
  const header: RunHeader = { title: runName(run, repo), meta: runMeta(run, repo, now, transcriptDays), segments: flow ? segments(flow.flatMap((s) => s.steps)) : [] }
  const wave = run.fix === undefined && run.plan !== undefined ? waveText(run, repo) : undefined
  if (wave !== undefined) header.wave = wave
  return header
}

/** A conventional-commit prefix: a known type, an optional `(scope)`, an optional `!`, then `:`. */
const COMMIT_PREFIX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s*/i

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** `sprint-column` → `Sprint column`. */
const readable = (slug: string) => capital(slug.replace(/[-_]+/g, ' ').trim())

/**
 * The run's human name, the same in the run header and its sidebar card: the plan's title; a fix run's
 * PR title without its prefix, kept as written, else its slug made readable; a repo row's repo. With no
 * repo (not on the Board yet), what the run summary alone says.
 */
export function runName(run: RunSummary, repo: BoardRepo | undefined): string {
  if (run.fix !== undefined) {
    const pr = repo && run.plan !== undefined ? fixPr(repo, run.plan)?.title?.replace(COMMIT_PREFIX, '').trim() : undefined
    return pr || readable(run.fix)
  }
  if (run.plan === undefined) return run.repo
  return run.title ?? repo?.model.plans.find((p) => p.slug === run.plan)?.title ?? readable(run.plan)
}

/** `<repo> · <Plan|Fix> · started <when>`; a part that isn't known is left out. */
function runMeta(run: RunSummary, repo: BoardRepo, now: number, transcriptDays: number): string {
  if (run.plan === undefined) return ''
  const started = startedText(run, repo, now, transcriptDays)
  return [run.repo, run.fix !== undefined ? 'Fix' : 'Plan', started === undefined ? undefined : `started ${started}`].filter((x) => x !== undefined).join(' · ')
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * An agent start this close to the window's far edge isn't trusted: the plan's earlier agents may have
 * aged out of the window, so the earliest one left would read later than the plan really started.
 */
const EDGE = DAY

/**
 * When the run started, as words. A fix run: its earliest agent (engineers and reviewers), else nothing.
 * A plan: the earliest of these candidates: the autopilot stamp (if any) and every read agent's start;
 * with no stamp and no agent clearly inside the window (none at all, or the earliest near or past its
 * edge, so older agents may be unread), the `Generated:` day too. A time more than a day inside the
 * transcript window reads `N ago`; any other reads as a date (a time's local day, the `Generated:` day as written).
 */
function startedText(run: RunSummary, repo: BoardRepo, now: number, transcriptDays: number): string | undefined {
  if (run.fix !== undefined) {
    const at = earliest(fixRunAgents(repo, run.plan!, now))
    return at === undefined ? undefined : startedAgo(at, now)
  }
  const plan = repo.model.plans.find((p) => p.slug === run.plan)
  if (!plan) return undefined
  const inside = (at: number) => now - at < transcriptDays * DAY - EDGE
  const agent = earliest(repo.agents.filter((a) => isPlanAgent(a, plan)))
  const times = [plan.autopilotStartedAt, agent].filter((x) => x !== undefined)
  const time = times.length > 0 ? Math.min(...times) : undefined
  const generated = plan.autopilotStartedAt === undefined && (agent === undefined || !inside(agent)) ? plan.generated : undefined
  const day = generated === undefined ? undefined : localDay(generated)
  if (generated !== undefined && day !== undefined && (time === undefined || day <= time)) return dayText(generated, now)
  if (time === undefined) return undefined
  return inside(time) ? startedAgo(time, now) : dateText(time, now)
}

/** A `YYYY-MM-DD` day's local midnight, to compare with a time. */
function localDay(day: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined
}

const earliest = (agents: { startedAt?: number | undefined }[]): number | undefined => {
  const starts = agents.flatMap((a) => (a.startedAt === undefined ? [] : [a.startedAt]))
  return starts.length > 0 ? Math.min(...starts) : undefined
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A time as its local day: `Oct 2`, with `, 2025` when it isn't now's year. */
function dateText(at: number, now: number): string {
  const d = new Date(at)
  const text = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? text : `${text}, ${d.getFullYear()}`
}

/**
 * A `YYYY-MM-DD` day as `Oct 12`, with `, 2025` when it isn't now's year. Read from the text, not through
 * `Date`, so the day never shifts with the time zone.
 */
function dayText(day: string, now: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const month = m && MONTHS[Number(m[2]) - 1]
  if (!m || !month) return undefined
  const text = `${month} ${Number(m[3])}`
  return Number(m[1]) === new Date(now).getFullYear() ? text : `${text}, ${m[1]}`
}

/** `just now` (under a minute, or ahead of now), `N min ago`, `N h ago`, or `N day(s) ago`, rounded down. */
export function startedAgo(at: number, now: number): string {
  const ago = now - at
  if (ago < MIN) return 'just now'
  if (ago < HOUR) return `${Math.floor(ago / MIN)} min ago`
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`
  const days = Math.floor(ago / DAY)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** One connector of the flow's path, between two steps by key. `back` runs to an earlier column. */
export type FlowEdge = { from: string; to: string; kind: 'down' | 'across' | 'back'; walked: boolean; dashed: boolean }

/** States that show a step actually ran. */
const RAN = new Set<StepState>(['done', 'live', 'you', 'blocked'])

/**
 * The flow's path. The main path runs through every step but the optional ones, in order (a fix run's
 * Engineer → Round 1 → Round 2 → PR, the real order of events): down inside a column, across to a later
 * one. An optional step is a dashed detour from its review step into it and on to the next main step.
 * Walked (drawn in --fg): the main path up to and into the current step (all of it when none is
 * current; only up to the review step while the fix pass runs); a detour only once its step ran.
 */
export function flowEdges(columns: FlowColumn[]): FlowEdge[] {
  const all = columns.flatMap((c, col) => c.steps.map((s) => ({ s, col })))
  type At = (typeof all)[number]
  const kind = (a: At, b: At): FlowEdge['kind'] => (a.col === b.col ? 'down' : a.col < b.col ? 'across' : 'back')
  const main = all.filter((x) => !x.s.optional)
  const branchOf = (o: At) => main.findIndex((m) => m.s.key === DETOURS[o.s.key])

  let reached = currentIndex(main.map((x) => x.s.state))
  if (reached < 0) reached = main.length
  for (const o of all.filter((x) => x.s.optional && HIGHLIGHT.has(x.s.state))) {
    const at = branchOf(o)
    if (at >= 0) reached = Math.min(reached, at)
  }

  const edges: FlowEdge[] = main.slice(1).map((b, i) => ({ from: main[i]!.s.key, to: b.s.key, kind: kind(main[i]!, b), walked: i + 1 <= reached, dashed: false }))
  for (const o of all.filter((x) => x.s.optional)) {
    const at = branchOf(o)
    const from = main[at]
    const next = main[at + 1]
    if (!from || !next) continue
    edges.push({ from: from.s.key, to: o.s.key, kind: kind(from, o), walked: RAN.has(o.s.state), dashed: true })
    edges.push({ from: o.s.key, to: next.s.key, kind: kind(o, next), walked: o.s.state === 'done' && at + 1 <= reached, dashed: true })
  }
  return edges
}
