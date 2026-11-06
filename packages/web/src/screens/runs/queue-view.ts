// The Waiting on you list on screen 1: the queue entries that wait on you for the selected run.
// The selected plan's own entries first, then the repo's entries that join no plan. Other plans'
// entries show under their own run. Pure; WaitingOnYou.tsx is the glue.

import { isAnswerable, triage, type BoardRepo, type QueueItem, type RunSummary } from '@open-aflow/model'
import type { AnswerState } from './answer-flow.ts'
import { entryKind, type EntryKind } from './entry-kind.ts'
import type { Chip, ChipClass } from './view.ts'

/** A plan run's note: its Continue resumes /pod:code, which reads the answer. */
export const ANSWER_NOTE = 'Answer here, then press Continue. pod reads it when the run continues.'
/** A fix run's or repo row's note: /pod:fix reads no answers and a repo row has no Continue. */
export const ANSWER_NOTE_NEXT_WAVE = 'Answer here. pod reads it when a /pod:code run next starts a wave.'

/** The answer form's note for the selected run. */
export const answerNote = (selected: RunSummary): string =>
  selected.fix === undefined && selected.plan !== undefined ? ANSWER_NOTE : ANSWER_NOTE_NEXT_WAVE
export const ANSWER_WAITING = 'Waiting for pod to read it.'

export type WaitingRow = {
  /** Unique within the list, even when two lines read the same. */
  key: string
  /** The entry's whole line, its identity for the answer route. */
  line: string
  chip: Chip
  date?: string
  route: string
  /** The body as plain text: no bold, code ticks, or link syntax. */
  body: string
  /** The kind its body starts with (entry-kind.ts), and the words the row shows for it. */
  kind: EntryKind
  kindLabel: string
  /** `body` without its kind prefix: what the row shows. */
  text: string
  /** Shows the Answer button. */
  answerable: boolean
  /** The board reads the entry as settled: the reason, shown as `Done: <reason>` with Close. */
  done?: string
  /** The entry's value in use, shown as the default with Keep; never with `done`. */
  keep?: string
  /** `Your answer: <answer>` on an answered entry. */
  yourAnswer?: string
  waiting?: string
}

const TYPE_CLS: Record<string, ChipClass> = { BLOCKED: 's-bad', PENDING: 's-you', NOTE: 's-idle' }

const typeChip = (type: string): Chip => ({ cls: TYPE_CLS[type] ?? 's-idle', label: type || 'ENTRY' })

/** Markdown marks out, the words kept. */
const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The entries waiting on you for this run, in list order. */
export function waitingEntries(repo: BoardRepo | undefined, selected: RunSummary | undefined): QueueItem[] {
  if (!repo || !selected || selected.repoId !== repo.id) return []
  const plans = repo.model.plans
  // A fix run's name and a repo row name no plan, so only unjoined entries show for them.
  const own = selected.fix === undefined ? (plans.find((p) => p.slug === selected.plan)?.queue ?? []) : []
  // The Board arrives as JSON, so entries match by line: a plan's join reads only the line.
  const joined = new Set(plans.flatMap((p) => p.queue.map((e) => e.line)))
  const unjoined = repo.model.queue.filter((e) => !joined.has(e.line))
  return [...own, ...unjoined].filter((e) => e.needsYou)
}

export function waitingRows(repo: BoardRepo | undefined, selected: RunSummary | undefined): WaitingRow[] {
  if (!repo) return []
  return waitingEntries(repo, selected).map((e, i) => {
    const body = plain(e.body)
    const kind = entryKind(body)
    const row: WaitingRow = {
      key: `${i}:${e.line}`,
      line: e.line,
      chip: typeChip(e.type),
      route: e.route.trim(),
      body,
      kind: kind.kind,
      kindLabel: kind.label,
      text: kind.text,
      answerable: isAnswerable(e),
    }
    if (e.date !== undefined) row.date = e.date
    const t = triage(repo, e)
    if (t.done !== undefined) row.done = t.done
    if (t.keep !== undefined) row.keep = t.keep
    if (e.answer !== undefined) {
      row.yourAnswer = `Your answer: ${e.answer}`
      row.waiting = ANSWER_WAITING
    }
    return row
  })
}

/**
 * The key of the row the open form sits under; `end` when its entry has left the list (the form then
 * shows after it, so a result is never lost); undefined while closed or for another repo. Once answered,
 * the Board's line carries the answer, so an answered row whose line starts with the form's line matches too.
 */
export function formAnchor(s: AnswerState, rows: WaitingRow[], repoId: string): string | undefined {
  if (s.kind === 'idle' || s.target.repoId !== repoId) return undefined
  const line = s.target.line
  const row = rows.find((r) => r.line === line) ?? rows.find((r) => r.yourAnswer !== undefined && r.line.startsWith(line))
  return row?.key ?? 'end'
}
