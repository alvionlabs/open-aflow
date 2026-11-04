// Replies: which reply pod waits for on a run, and the chat to paste it in.
// Pure. The rules and why are in pod-docs/feature-details/queue-and-replies.md.

import type { AgentRun, BoardRepo } from './board.ts'
import { fixPr, fixRunAgents, fixRunNames, fixWaitingPr, listedFixRuns } from './fix-runs.ts'
import { handBackPr, isAutopilot, isBlockedSlice, isHalted, isPlanAgent, isRun, isRunning, isSliceDone, pendingHandBack, planAgentRunning, waitsOnWave, waveWaitingPr } from './pipeline.ts'
import { asksYou } from './queue-answer.ts'
import type { PlanModel } from './run-model.ts'

export type ReplyWord = 'continue' | 'go' | 'try'
export type ReplySignal =
  | 'wave-waiting'
  | 'wave-merged'
  | 'sprint-done'
  | 'final-waiting'
  | 'final-merged'
  | 'fix-waiting'
  | 'fix-merged'
  | 'not-started'
  | 'answered'
/**
 * `key` names one pod stop, so a stop gets one automatic send: `<signal>:<pr>` when `pr` is set,
 * `sprint-done:<done sprint slug>`, `not-started:<plan slug>`, `try:<plan slug>`, or
 * `answered:<plan slug>:<count>:<hash of the answered lines>`. Never built from `why`.
 */
export type RunReply = { reply: ReplyWord; signal: ReplySignal; why: string; pr?: number; key: string }
export type ReplySession = { id: string; startedAt?: number; repoPath: string; resume?: string }

/**
 * The signals where pod already waits for `continue`, or where you answered what it stopped on. The
 * `*-waiting` ones need your merge first; `not-started` is never a send signal.
 */
export const SEND_SIGNALS: ReadonlySet<ReplySignal> = new Set<ReplySignal>(['wave-merged', 'sprint-done', 'final-merged', 'fix-merged', 'answered'])

/** A queue route addressed to you: `… → human` or `… -> human`. */
const TO_HUMAN = /(?:→|->)\s*human\s*$/i

/** A session id safe to put in a shell command. */
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/

const mergeFirst = (signal: ReplySignal, n: number): RunReply => ({ reply: 'continue', signal, why: `Merge PR #${n}, then reply continue.`, pr: n, key: `${signal}:${n}` })
const merged = (signal: ReplySignal, n: number, why = `PR #${n} merged.`): RunReply => ({ reply: 'continue', signal, why, pr: n, key: `${signal}:${n}` })

/** The replies pod waits for on a run (a plan slug or `fix-<slug>`), at most one per word. None while pod works. */
export function runReplies(repo: BoardRepo, run: string, now: number): RunReply[] {
  const plan = repo.model.plans.find((p) => p.slug === run)
  if (plan) return planReplies(repo, plan, now)
  if (fixRunNames(repo).includes(run)) return fixReplies(repo, run, now)
  return []
}

function planReplies(repo: BoardRepo, plan: PlanModel, now: number): RunReply[] {
  if (!isRun(repo, plan, now) || planAgentRunning(repo, plan, now) || waitsOnWave(repo, plan, now)) return []
  // A halt hides the stop replies: only answering it moves pod on. Any stop reply wins over answered.
  const stop = isHalted(plan) ? [] : stopReplies(repo, plan, now)
  if (stop.length > 0) return stop
  const done = answeredReply(plan)
  return done ? [done] : []
}

/**
 * `continue` once you answered at least one pending PENDING or BLOCKED of the plan routed `→ human` and no
 * pending BLOCKED of it routed to you is unanswered: pod reads the answers
 * only when it resumes. A BLOCKED halts pod; an open PENDING only defers (pod uses the value in use), so it
 * doesn't hold the reply back. N and the key are the answered entries.
 */
function answeredReply(plan: PlanModel): RunReply | undefined {
  // Routed to you only: `needsYou` counts every BLOCKED, but an engineer's BLOCKED to the orchestrator
  // (gate 1, beside the halt you answer) is pod's to resolve, not yours.
  const asks = plan.queue.filter((e) => asksYou(e) && TO_HUMAN.test(e.route))
  if (asks.some((e) => e.type === 'BLOCKED' && e.answer === undefined)) return undefined
  const answered = asks.filter((e) => e.answer !== undefined)
  const n = answered.length
  if (n === 0) return undefined
  const why = n === 1 ? 'You answered 1 entry: reply continue so pod reads it.' : `You answered ${n} entries: reply continue so pod reads them.`
  return { reply: 'continue', signal: 'answered', why, key: `answered:${plan.slug}:${n}:${fnv1a(answered.map((e) => e.line).join('\n'))}` }
}

/** FNV-1a, 32-bit, as 8 hex digits. A stable name for a set of lines, not a secret. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function stopReplies(repo: BoardRepo, plan: PlanModel, now: number): RunReply[] {
  const waiting = pendingHandBack(repo, plan)
  if (waiting !== undefined) return [mergeFirst('final-waiting', waiting), { reply: 'try', signal: 'final-waiting', why: 'Starts the app so you can try it.', key: `try:${plan.slug}` }]
  // handBackPr reads only pending entries, so a merged PR here is a hand-back pod hasn't resolved yet.
  const handed = handBackPr(plan)
  if (handed !== undefined) return [merged('final-merged', handed, `PR #${handed} merged: pod cleans up.`)]
  // Autopilot merges its waves and drafts the next sprint by itself: it waits for no continue between them.
  if (isAutopilot(plan)) return []

  const index = plan.sprints.findIndex((s) => s.slug === plan.currentSprint)
  const current = plan.sprints[index]
  if (current) {
    for (const w of current.waves) {
      const n = waveWaitingPr(repo, plan, current, w, now)
      if (n !== undefined) return [mergeFirst('wave-waiting', n)]
    }
    for (const w of current.waves) {
      if (w.slices.some(isBlockedSlice) || w.slices.every(isSliceDone)) continue
      const open = w.slices.filter((x) => !isSliceDone(x))
      if (!open.every((x) => x.status.trim().toLowerCase() === 'pushed')) continue
      // Unknown gh state (not on prs) is not merged.
      const n = open.map((x) => x.pr.number).find((k) => k !== undefined && repo.prs.find((p) => p.number === k)?.state === 'merged')
      if (n !== undefined) return [merged('wave-merged', n)]
    }
    const done = plan.sprints.slice(0, index).findLast((s) => s.status === 'done')
    if (!current.hasDoc && done) return [{ reply: 'continue', signal: 'sprint-done', why: `Sprint ${done.slug} is done.`, key: `sprint-done:${done.slug}` }]
  }

  const fresh = plan.status !== 'archived' && plan.sprints.length > 0 && plan.sprints.every((s) => s.status === 'planned' && !s.hasDoc)
  return fresh ? [{ reply: 'go', signal: 'not-started', why: 'Only if pod asked for go.', key: `not-started:${plan.slug}` }] : []
}

function fixReplies(repo: BoardRepo, name: string, now: number): RunReply[] {
  if (!listedFixRuns(repo, now).includes(name)) return []
  if (fixRunAgents(repo, name, now).some((a) => isRunning(a, now))) return []
  const waiting = fixWaitingPr(repo, name, now)
  if (waiting) return [mergeFirst('fix-waiting', waiting.number)]
  const pr = fixPr(repo, name)
  return pr?.state === 'merged' ? [merged('fix-merged', pr.number)] : []
}

/** The run's agents a session can come from: a plan's agents, or a fix run's engineers and reviewers. */
function runAgents(repo: BoardRepo, run: string, now: number): AgentRun[] {
  const plan = repo.model.plans.find((p) => p.slug === run)
  if (plan) return repo.agents.filter((a) => isPlanAgent(a, plan))
  return fixRunAgents(repo, run, now)
}

/**
 * The chat to paste a reply in: the session of the run's agent that wrote last (ties: the newer
 * start, then the smaller agent id). Its start is the earliest of any repo agent in that session;
 * the main chat is never read. `resume` only for an id safe in a shell command and a session that is provably this repo's.
 */
export function replySession(repo: BoardRepo, run: string, now: number): ReplySession | undefined {
  const newest = runAgents(repo, run, now)
    .filter((a) => a.lastAt !== undefined && a.session !== '')
    .sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0) || (y.startedAt ?? -Infinity) - (x.startedAt ?? -Infinity) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0]
  if (!newest) return undefined
  const id = newest.session
  const out: ReplySession = { id, repoPath: repo.path }
  const starts = repo.agents.filter((a) => a.session === id && a.startedAt !== undefined).map((a) => a.startedAt!)
  if (starts.length > 0) out.startedAt = Math.min(...starts)
  if (SESSION_ID.test(id) && !newest.sessionUnproven) out.resume = `claude --resume ${id}`
  return out
}
