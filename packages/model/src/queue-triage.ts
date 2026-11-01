// Queue triage: the pending entries the board can settle in one click. `Done`: the board's own data
// shows the entry is settled (Close). `Keep`: the entry states the value pod goes on with (Keep).
// Never automatic: the human clicks. Pure. The rules and why are in pod-docs/feature-details/queue-and-replies.md.

import type { BoardRepo } from './board.ts'
import { haltGate, handBackPr } from './pipeline.ts'
import { cleanAnswer, isAnswerable } from './queue-answer.ts'
import type { PlanModel, QueueItem } from './run-model.ts'

/** What the row offers: `done` (the reason) wins over `keep` (the value in use). */
export type Triage = { done?: string; keep?: string }

type TriageRepo = Pick<BoardRepo, 'model' | 'prs'>

/** Markdown marks out, the words kept: the text the row shows. */
const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const VALUE = /\bvalue in use\s*:\s*/i
/** A sentence ends at `.`, `!` or `?` before a space or the end; a `.` inside a URL or a file name doesn't. */
const SENTENCE_END = /[.!?](?=\s|$)/

/** The value after `Value in use:`, up to the end of its sentence; any case, marks out. Undefined with none. */
export function valueInUse(body: string): string | undefined {
  const text = plain(body)
  const m = VALUE.exec(text)
  if (!m) return undefined
  const rest = text.slice(m.index + m[0].length)
  const end = SENTENCE_END.exec(rest)
  const value = (end ? rest.slice(0, end.index) : rest).trim()
  return value === '' ? undefined : value
}

const HAND_BACK = /^plan\s+`?[\w.-]+`?\s+complete\b/i
/** The staging PR a gate 7 entry names: the URL or `#N` after the words `staging PR`. */
const STAGING_PR = /staging\s+PR\s*(?:\S*?\/pull\/(\d+)|#(\d+))/i

/** The staging PR a gate 7 entry (or a plan-complete hand-back) names; undefined for any other entry. */
export function stagingPrOf(entry: Pick<QueueItem, 'body'>): number | undefined {
  const body = entry.body
  if (haltGate(body) !== 7 && !HAND_BACK.test(body.trim())) return undefined
  const m = STAGING_PR.exec(body)
  return m ? Number(m[1] ?? m[2]) : undefined
}

const NAMED_PR = /\/pull\/(\d+)|#(\d+)\b/g

/**
 * The wave PRs a gate 1, 3 or 6 halt names: every PR it names (a pull URL or `#N`), when each is a slice's PR
 * in one of the plan's sprint docs and none is the plan's final PR (its hand-back's). Empty for any other entry,
 * or when it names no PR or any other PR. pod can write these gates after the plan archive (the final PR held
 * back or failing, the reporter), so only a merged wave PR settles one.
 */
export function wavePrsOf(plan: Pick<PlanModel, 'sprints' | 'queue'>, entry: Pick<QueueItem, 'body'>): number[] {
  const gate = haltGate(entry.body)
  if (gate !== 1 && gate !== 3 && gate !== 6) return []
  const named = [...new Set([...entry.body.matchAll(NAMED_PR)].map((m) => Number(m[1] ?? m[2])))]
  const slicePrs = new Set(plan.sprints.flatMap((s) => s.waves.flatMap((w) => w.slices.map((x) => x.pr.number))))
  const final = handBackPr(plan)
  if (named.length === 0 || named.some((n) => n === final || !slicePrs.has(n))) return []
  return named
}

/**
 * Why the entry is settled, from the board's data only; undefined when no rule is certain.
 * - A gate 7 (or plan-complete hand-back) entry whose named staging PR gh reports merged.
 * - A gate 4 or 5 of an archived plan: pod writes them only between waves and sprints, never at close-out,
 *   and archiving the plan means pod resumed past them.
 * - A gate 1, 3 or 6 whose named wave PRs (wavePrsOf) gh reports merged, and none of them the PR gh found on the plan's branch.
 * Never the archive alone for the hand-back or gates 1, 2, 3, 6 and 7: pod archives a plan before its final review
 * and merge, and can write those after it.
 */
export function doneReason(repo: TriageRepo, entry: QueueItem): string | undefined {
  const body = entry.body
  const gate = haltGate(body)
  if (gate === 7 || HAND_BACK.test(body.trim())) {
    const n = stagingPrOf(entry)
    if (n !== undefined && repo.prs.some((p) => p.number === n && p.state === 'merged')) return `staging PR #${n} merged`
    return undefined
  }
  if (gate === undefined) return undefined
  const plan = repo.model.plans.find((p) => p.queue.some((e) => e.line === entry.line))
  if (!plan) return undefined
  if (plan.status === 'archived' && (gate === 4 || gate === 5)) return `plan ${plan.slug} is archived`
  const waves = wavePrsOf(plan, entry)
  const merged = (n: number) => repo.prs.some((p) => p.number === n && p.state === 'merged' && p.branch !== plan.slug)
  if (waves.length > 0 && waves.every(merged)) return `wave PR #${waves[0]} merged`
  return undefined
}

/** Close or Keep for an entry you can answer; Done wins. Keep only on a PENDING: a BLOCKED halts pod and needs a real answer. */
export function triage(repo: TriageRepo, entry: QueueItem): Triage {
  if (!isAnswerable(entry)) return {}
  const done = doneReason(repo, entry)
  if (done !== undefined) return { done }
  const keep = entry.type === 'PENDING' ? valueInUse(entry.body) : undefined
  return keep === undefined ? {} : { keep }
}

const PENDING = /\*\*Resolution:\*\*\s*pending\b/i

/** The line with its `**Resolution:** pending` rewritten to `**Resolution:** <text>`; undefined when the line isn't pending. */
export function withResolution(line: string, text: string): string | undefined {
  if (!PENDING.test(line)) return undefined
  return line.replace(PENDING, () => `**Resolution:** ${text}`)
}

/** The queue's resolution format: `<date> — <what changed>`. */
export const closeText = (date: string, reason: string) => `${date} — closed from the board: ${reason}`
export const keepText = (date: string, value: string) => `${date} — kept: ${value}`

/** A resolution text on one line, with the answer's rules (no markers, no control characters, a length cap). */
export const cleanResolution = cleanAnswer
