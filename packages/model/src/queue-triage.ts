// Queue triage: the pending entries the board can settle in one click. `Done`: the board's own data
// shows the entry is settled (Close). `Keep`: the entry states the value pod goes on with (Keep).
// Never automatic: the human clicks. Pure. The rules and why are in pod-docs/feature-details/queue-and-replies.md.

import type { BoardRepo } from './board.ts'
import { haltGate } from './pipeline.ts'
import { cleanAnswer, isAnswerable } from './queue-answer.ts'
import type { QueueItem } from './run-model.ts'

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

/** Gates pod only writes while a wave runs. Gate 3 and 6 also come at the final PR, so only when the entry names a wave. */
function isWaveGate(gate: number, body: string): boolean {
  if (gate === 1 || gate === 4) return true
  if (gate === 3 || gate === 6) return /\bwave\b/i.test(body) && !/\bfinal\b/i.test(body)
  return false
}

/**
 * Why the entry is settled, from the board's data only; undefined when no rule is certain.
 * - A gate 7 (or plan-complete hand-back) entry whose named staging PR gh reports merged.
 * - A wave-time gate halt (1, 4, a wave's 3 or 6) or a gate 5 of an archived plan: pod ran the plan's close-out after it.
 * - A wave-time gate halt of an archived sprint: pod finished that sprint after it.
 * Not the archive alone for the hand-back, gate 2, 7, or a final PR's 3 or 6: pod archives a plan before it writes those.
 */
export function doneReason(repo: TriageRepo, entry: QueueItem): string | undefined {
  const body = entry.body
  const gate = haltGate(body)
  if (gate === 7 || HAND_BACK.test(body.trim())) {
    const m = STAGING_PR.exec(body)
    const n = m ? Number(m[1] ?? m[2]) : undefined
    if (n !== undefined && repo.prs.some((p) => p.number === n && p.state === 'merged')) return `staging PR #${n} merged`
    return undefined
  }
  if (gate === undefined) return undefined
  const plan = repo.model.plans.find((p) => p.queue.some((e) => e.line === entry.line))
  if (!plan) return undefined
  const wave = isWaveGate(gate, body)
  if (plan.status === 'archived' && (wave || gate === 5)) return `plan ${plan.slug} is archived`
  // Gate 5 is also checked after a sprint is archived, so it can be live on one.
  const sprint = entry.sprint === undefined ? undefined : plan.sprints.find((s) => s.slug === entry.sprint)
  if (wave && sprint?.isArchived) return `sprint ${sprint.slug} is archived`
  return undefined
}

/** Close or Keep for an entry you can answer; Done wins. Empty for any other entry. */
export function triage(repo: TriageRepo, entry: QueueItem): Triage {
  if (!isAnswerable(entry)) return {}
  const done = doneReason(repo, entry)
  if (done !== undefined) return { done }
  const keep = valueInUse(entry.body)
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
