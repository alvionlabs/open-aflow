// The Next step card's "what happened" list (contract item 10): what you did on this stop, from the card's own
// results only. A merged merge and a started Continue or Go add a done item; nothing else does, and automatic sends
// never reach the card. The list resets on the first Board where the run leaves running (a new stop); a run switch
// remounts the card. Pure: NextStepCard keeps the log in its state and draws stopView with StopList.

import type { ResumeResult, RunState } from '@openaflow/model'
import type { StopItem } from '../../components/StopList.tsx'
import type { NextItem } from './next-step.ts'
import { NOT_LOGGED, SEND_LABEL, startedText, type ResumeWord } from './resume-flow.ts'

/** `merged`: the PR the item merged, so a card that still names it waits for the Board. `sent`: a Continue or Go. */
export type StopDone = { key: string; label: string; time: string; note?: string; merged?: number; sent?: true }
/** `running`: the run read running on the last Board seen. `n` numbers the items' keys. */
export type StopLog = { done: StopDone[]; running: boolean; n: number }
export const EMPTY_LOG: StopLog = { done: [], running: false, n: 0 }

/** Local `HH:MM`. */
function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const add = (log: StopLog, item: Omit<StopDone, 'key'>): StopLog => ({ ...log, done: [...log.done, { key: `done-${log.n}`, ...item }], n: log.n + 1 })

/** A `merged` reply: `Merged PR #N · HH:MM`. */
export function logMerged(log: StopLog, number: number, at: number): StopLog {
  return add(log, { label: `Merged PR #${number}`, time: clock(at), merged: number })
}

/**
 * A send's result: only `started` adds `Sent <word> · HH:MM`. Its note is the started line, with the session's
 * `claude --resume` known at the reply, so the note stays right after the Board drops the reply.
 */
export function logSent(log: StopLog, word: ResumeWord, at: number, result: ResumeResult, resume?: string): StopLog {
  if (result.outcome !== 'started') return log
  const note = result.logged ? startedText(resume) : `${startedText(resume)} ${NOT_LOGGED}`
  return add(log, { label: `Sent ${word}`, time: clock(at), note, sent: true })
}

/** Each Board's state for the run. The first one out of running starts a new stop: the list empties. */
export function logRunState(log: StopLog, state: RunState): StopLog {
  const running = state === 'running'
  if (running === log.running) return log
  return running ? { ...log, running } : { ...log, done: [], running }
}

export type StopView = { items: StopItem[]; hideMerge: boolean }

/** The card's next action: the reply row's button label, else the card's title. */
function nextAction(card: NextItem): string {
  const send = card.action.kind === 'reply' ? card.action.panel.rows.find((r) => r.send !== undefined)?.send : undefined
  return send ? SEND_LABEL[send] : card.title
}

/**
 * The list to draw, and whether the card's Merge hides. No done item: no list. The current item is `pod runs` after
 * a send; `Updating…` while the card still names a PR the list shows merged (and that Merge hides); else the card's
 * next action.
 */
export function stopView(log: StopLog, card: NextItem): StopView {
  const a = card.action
  const hideMerge = a.kind === 'merge' && log.done.some((d) => d.merged === a.number)
  if (log.done.length === 0) return { items: [], hideMerge }
  const last = log.done[log.done.length - 1]!
  const label = last.sent ? 'pod runs' : hideMerge ? 'Updating…' : nextAction(card)
  const done = log.done.map(({ key, label, time, note }): StopItem => ({ key, label, time, state: 'done', ...(note ? { note } : {}) }))
  return { items: [...done, { key: 'now', label, time: '', state: 'current' }], hideMerge }
}

export type Focusable = { focus(): void }
export type FocusRoot = { querySelector(selector: string): Focusable | null }
export const FOCUS_PRIMARY = 'button.btn.primary:not(:disabled)'
export const FOCUS_TITLE = '.next-title'

/** After the merge panel closes: the card's primary button (Continue, once the Board moved on), else its title. */
export function focusAfterMerge(card: FocusRoot | null): void {
  if (!card) return
  ;(card.querySelector(FOCUS_PRIMARY) ?? card.querySelector(FOCUS_TITLE))?.focus()
}
