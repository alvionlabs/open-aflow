// Fix runs: a one-off run, read from its port claim and its agents. pod 0.10.0+ names it
// `/pod:task` (`<repo> task-<slug>`, a `kind: task` reviewer); older pod names it `/pod:fix`
// (`<repo> fix-<slug>`, a `kind: fix` reviewer). Both forms are read.
// Its pipeline (Build → Review → Ship), its agent log, and the repo's other activity:
// agents tied to no run. Pure. The rules and why are in
// pod-docs/feature-details/runs-and-pipeline.md.

import type { AgentRun, AgentState, BoardRepo, PrStatus } from './board.ts'
import { isPlanAgent, prByBranch, spend, type Stage, type Step, type StepState } from './pipeline.ts'
import { formatTokens } from './pod-flow/model.ts'
import { agentState } from './transcript.ts'

/** How far back the Other activity strip looks, and how many agents it shows at most. */
export const OTHER_WINDOW_MS = 2 * 60 * 60 * 1000
export const OTHER_CAP = 8

/** What started a one-off run: `/pod:task` (pod 0.10.0+) or `/pod:fix` (older pod). */
export type OneOffKind = 'task' | 'fix'

/** The claim and branch prefix of each one-off kind. Its reviewer's `kind` field is the same word. */
const ONE_OFF: readonly { prefix: string; kind: OneOffKind }[] = [
  { prefix: 'task-', kind: 'task' },
  { prefix: 'fix-', kind: 'fix' },
]
const ONE_OFF_KINDS: ReadonlySet<string | undefined> = new Set(ONE_OFF.map((o) => o.kind))

const oneOff = (name: string) => ONE_OFF.find((o) => name.startsWith(o.prefix) && name.length > o.prefix.length)

/** The kind of a one-off run's claim name (`task-<slug>` or `fix-<slug>`); undefined for any other name. */
export const oneOffKind = (name: string): OneOffKind | undefined => oneOff(name)?.kind

/** A reviewer's `kind` field names a one-off run (`task` or `fix`), never a plan's review. */
export const isOneOffReviewKind = (kind: string | undefined): boolean => ONE_OFF_KINDS.has(kind)

/** The slug after the claim name's one-off prefix. */
const slugOf = (name: string) => name.slice(oneOff(name)?.prefix.length ?? 0)

export type FixRole = 'engineer' | 'fix pass' | 'reviewer'
export type FixLogRow = { agentId: string; role: FixRole; turn?: number; round?: number; startedAt?: number; endedAt?: number; state: AgentState; engineer: boolean }
export type FixPipeline = { slug: string; stages: Stage[]; log: FixLogRow[] }
export type OtherAgent = { id: string; role: string; detail?: string; startedAt?: number; lastAt?: number; state: AgentState }

type FixAgent = { a: AgentRun; turn?: number; role: FixRole; round?: number; state: AgentState }

const isType = (a: AgentRun, role: string) => new RegExp(`(^|:)${role}$`).test(a.type)
const byStart = (x: { a: AgentRun }, y: { a: AgentRun }) => (x.a.startedAt ?? 0) - (y.a.startedAt ?? 0)

/** The claims named `task-<slug>` or `fix-<slug>` that name no plan of the repo, once each, in claim order. */
export function fixRunNames(repo: Pick<BoardRepo, 'model' | 'claims'>): string[] {
  const plans = new Set(repo.model.plans.map((p) => p.slug))
  const names = repo.claims.map((c) => c.plan).filter((n) => oneOffKind(n) !== undefined && !plans.has(n))
  return [...new Set(names)]
}

/** The PR gh found by the run's head branch. */
export const fixPr = (repo: BoardRepo, name: string): PrStatus | undefined => prByBranch(repo, name)

type Turn = { a: AgentRun; turn?: number; state: AgentState }

/**
 * An agent's turns, each as the agent with that turn's start, last write, and tokens. An agent
 * resumed after a hand-back (SendMessage) has several; earlier turns ended at their hand-back.
 */
function turnsOf(a: AgentRun, now: number): Turn[] {
  const turns = a.turns
  if (!turns || turns.length < 2) return [{ a, state: agentState(a, now) }]
  return turns.map((t, i) => ({
    a: { ...a, startedAt: t.startedAt, lastAt: t.lastAt, tokens: t.tokens, ...clipActive(a, t.startedAt, t.lastAt) },
    turn: i,
    state: i === turns.length - 1 ? agentState(a, now) : 'ended',
  }))
}

/** The agent's active spans cut to one turn, so the time between turns never counts. */
function clipActive(a: AgentRun, from: number, to: number): Pick<AgentRun, 'active'> {
  if (!a.active) return {}
  const active = a.active.filter(([x, y]) => y >= from && x <= to).map(([x, y]): [number, number] => [Math.max(x, from), Math.min(y, to)])
  return { active }
}

/**
 * The run's agents, one entry per turn, oldest first. Engineers by their dispatch branch;
 * reviewers by `kind: task` or `kind: fix` plus the branch or the PR number. An engineer turn that started after
 * the first review is a fix pass, whether a new agent or the same one resumed. A reviewer's first
 * turn takes its `round` field; else, and for a resumed turn, 2 when it started after a fix pass, else 1.
 */
function fixAgents(repo: BoardRepo, name: string, now: number): FixAgent[] {
  const { engineers: eng, reviewers: rev } = matchFixAgents(repo, name)
  const reviewers = rev.flatMap((a) => turnsOf(a, now))
  const engineers = eng.flatMap((a) => turnsOf(a, now))
  const start = (x: Turn) => x.a.startedAt ?? 0
  const firstReview = Math.min(...reviewers.map((x) => x.a.startedAt ?? Number.POSITIVE_INFINITY))
  const builds = engineers.map((x): FixAgent => ({ ...x, role: start(x) > firstReview ? 'fix pass' : 'engineer' }))
  const firstPass = Math.min(...builds.filter((x) => x.role === 'fix pass').map((x) => x.a.startedAt ?? Number.POSITIVE_INFINITY))
  const reviews = reviewers.map((x): FixAgent => {
    const field = x.turn === undefined || x.turn === 0 ? x.a.round : undefined
    return { ...x, role: 'reviewer', round: field ?? (start(x) > firstPass ? 2 : 1) }
  })
  return [...builds, ...reviews].sort(byStart)
}

/** The run's agents, once each, oldest first: the engineers and reviewers its pipeline is built from. */
export function fixRunAgents(repo: BoardRepo, name: string, _now: number): AgentRun[] {
  if (!fixRunNames(repo).includes(name)) return []
  const { engineers, reviewers } = matchFixAgents(repo, name)
  return [...engineers, ...reviewers].sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))
}

/**
 * Engineers by their dispatch branch; reviewers by a one-off kind (`task` or `fix`, either one on either
 * run, as the branch or PR already names the run) plus the branch or the PR number.
 */
function matchFixAgents(repo: BoardRepo, name: string): { engineers: AgentRun[]; reviewers: AgentRun[] } {
  const pr = fixPr(repo, name)?.number
  const isReviewer = (a: AgentRun) =>
    isType(a, 'reviewer') && isOneOffReviewKind(a.kind) && (a.branch === name || (a.pr !== undefined && a.pr === pr))
  return {
    engineers: repo.agents.filter((a) => isType(a, 'engineer') && a.branch === name),
    reviewers: repo.agents.filter(isReviewer),
  }
}

/** The run's PR while it waits on you: open and reviewed. The Ship step reads `you merge` exactly then. */
export function fixWaitingPr(repo: BoardRepo, name: string, now: number): PrStatus | undefined {
  const pr = fixPr(repo, name)
  return pr?.state === 'open' && isReviewed(fixAgents(repo, name, now)) ? pr : undefined
}

const phase = (x: FixAgent): string => (x.role === 'reviewer' ? (x.round !== undefined && x.round >= 2 ? 'review round 2' : 'review') : x.role === 'engineer' ? 'build' : 'fix pass')

export type FixRunSummary = { plan: string; fix: string; where: string; state: 'running' | 'needs-you' | 'idle'; portBase?: number }

/**
 * The review is done: the agent that wrote last is a reviewer that ended. Last write, not start: an
 * engineer continued for the fix pass keeps its first start but writes after the review. Until then
 * an open PR isn't the human's to merge (pod hands it back only after the review), like a plan's final PR.
 */
const isReviewed = (agents: FixAgent[]) => {
  const last = agents.reduce<FixAgent | undefined>((x, y) => (x === undefined || (y.a.lastAt ?? 0) >= (x.a.lastAt ?? 0) ? y : x), undefined)
  return last !== undefined && last.role === 'reviewer' && last.state === 'ended'
}

/**
 * Where: the newest running agent's step; else `review` for an open PR whose review hasn't
 * run since the last build; else `PR` once there is one; else the newest agent's step; else
 * `build` (pod claims the ports before it dispatches the engineer).
 * State, first match: an agent running → `running`; the PR open and reviewed → `needs-you`; else `idle`.
 */
function summary(repo: BoardRepo, name: string, agents: FixAgent[]): FixRunSummary {
  const pr = fixPr(repo, name)
  const running = agents.filter((x) => x.state === 'running')
  const where =
    running.length > 0
      ? phase(running.at(-1)!)
      : pr?.state === 'open' && !isReviewed(agents) && agents.length > 0
        ? 'review'
        : pr
          ? 'PR'
          : agents.length > 0
            ? phase(agents.at(-1)!)
            : 'build'
  const state = running.length > 0 ? 'running' : pr?.state === 'open' && isReviewed(agents) ? 'needs-you' : 'idle'
  const run: FixRunSummary = { plan: name, fix: slugOf(name), where, state }
  const portBase = repo.claims.find((c) => c.plan === name)?.portBase
  if (portBase !== undefined) run.portBase = portBase
  return run
}

/** The repo's fix runs, in claim order. A run is listed while its claim exists, also long after its PR merged: only cleanup frees the claim. */
export function fixRuns(repo: BoardRepo, now: number): FixRunSummary[] {
  return fixRunNames(repo).map((name) => summary(repo, name, fixAgents(repo, name, now)))
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.endsWith('s') ? `${word}es` : `${word}s`}`

/** What several turns of one step are called: engineers, fix passes, or review runs. */
const COUNT_WORD: Record<string, string> = { Engineer: 'engineer', 'Fix pass': 'pass' }

/** One step from the agents that did it: live while one runs, done once any did, else waiting. */
function agentStep(key: string, label: string, xs: FixAgent[], waiting: string, now: number): Step {
  if (xs.length === 0) return { key, label, state: 'wait', detail: waiting }
  const live = xs.some((x) => x.state === 'running')
  // Each turn's active time: a fix pass resumed hours later doesn't count the hours between, nor an idle gap.
  const { minutes, tokens } = spend(xs.map((x) => ({ a: x.a, live: x.state === 'running' })), now)
  const parts: string[] = []
  if (xs.length > 1) parts.push(plural(xs.length, COUNT_WORD[label] ?? 'run'))
  if (minutes !== undefined) parts.push(live ? `${minutes} min so far` : `${minutes} min`)
  if (!live && tokens !== undefined) parts.push(`${formatTokens(tokens)} tok`)
  return { key, label, state: live ? 'live' : 'done', detail: parts.join(' · ') || (live ? 'running' : 'done') }
}

const PR_STEP: Record<PrStatus['state'], { state: StepState; text: string }> = {
  open: { state: 'you', text: 'you merge' },
  merged: { state: 'done', text: 'merged' },
  closed: { state: 'blocked', text: 'closed' },
}

/** The fix run's pipeline (Build, Review, Ship) and agent log; undefined when `name` is no fix run of the repo. */
export function buildFixPipeline(repo: BoardRepo, name: string, now: number): FixPipeline | undefined {
  if (!fixRunNames(repo).includes(name)) return undefined
  const agents = fixAgents(repo, name, now)
  const of = (pred: (x: FixAgent) => boolean) => agents.filter(pred)
  const pr = fixPr(repo, name)
  const ship: Step = !pr
    ? { key: 'pr', label: 'PR', state: 'wait', detail: 'not open yet' }
    : pr.state === 'open' && !isReviewed(agents)
      ? { key: 'pr', label: 'PR', state: 'wait', detail: `PR #${pr.number} · after review` }
      : { key: 'pr', label: 'PR', state: PR_STEP[pr.state].state, detail: `PR #${pr.number} · ${PR_STEP[pr.state].text}` }
  const waiting = fixWaitingPr(repo, name, now)
  if (waiting) ship.merge = { number: waiting.number }
  /** A merged PR was built and reviewed. With no agent at all, its session is past the transcript window, so no figures. */
  const ran = (step: Step): Step => (pr?.state === 'merged' && agents.length === 0 ? { ...step, state: 'done', detail: 'no transcript' } : step)
  const stages: Stage[] = [
    {
      key: 'build',
      caption: 'Build',
      steps: [
        ran(agentStep('engineer', 'Engineer', of((x) => x.role === 'engineer'), 'not started', now)),
        agentStep('fix-pass', 'Fix pass', of((x) => x.role === 'fix pass'), 'only if review fails', now),
      ],
    },
    {
      key: 'review',
      caption: 'Review',
      steps: [
        ran(agentStep('round-1', 'Round 1', of((x) => x.role === 'reviewer' && x.round === 1), 'not started', now)),
        agentStep('round-2', 'Round 2', of((x) => x.role === 'reviewer' && x.round !== 1), 'only after a fix pass', now),
      ],
    },
    { key: 'ship', caption: 'Ship', steps: [ship] },
  ]
  const log = agents.map((x): FixLogRow => {
    const row: FixLogRow = { agentId: x.a.id, role: x.role, state: x.state, engineer: x.role !== 'reviewer' }
    if (x.turn !== undefined) row.turn = x.turn
    if (x.round !== undefined) row.round = x.round
    if (x.a.startedAt !== undefined) row.startedAt = x.a.startedAt
    if (x.state !== 'running' && x.a.lastAt !== undefined) row.endedAt = x.a.lastAt
    return row
  })
  return { slug: slugOf(name), stages, log }
}

/**
 * The repo's agents tied to no run, newest first: not an agent of any plan in the repo, and not
 * one of a fix run's. Only those that wrote in the last OTHER_WINDOW_MS, OTHER_CAP at most.
 * Each has its role (the type without `pod:`) and one dispatch field (branch, else plan, else sprint), never text.
 */
export function otherActivity(repo: BoardRepo, now: number): OtherAgent[] {
  const fixIds = new Set(fixRunNames(repo).flatMap((n) => fixAgents(repo, n, now).map((x) => x.a.id)))
  return repo.agents
    .filter((a) => a.lastAt !== undefined && now - a.lastAt < OTHER_WINDOW_MS)
    .filter((a) => !fixIds.has(a.id) && !repo.model.plans.some((p) => isPlanAgent(a, p)))
    .sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0))
    .slice(0, OTHER_CAP)
    .map((a) => {
      const out: OtherAgent = { id: a.id, role: a.type.replace(/^pod:/, ''), state: agentState(a, now) }
      const detail = a.branch ?? a.plan ?? a.sprint
      if (detail !== undefined) out.detail = detail
      if (a.startedAt !== undefined) out.startedAt = a.startedAt
      if (a.lastAt !== undefined) out.lastAt = a.lastAt
      return out
    })
}
