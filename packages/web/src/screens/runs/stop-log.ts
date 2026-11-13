// The Next step card's "what happened" list (contract item 10): what you did on this stop, from the card's own
// results only. A merged merge and a started Continue or Go add a done item; nothing else does, and automatic sends
// never reach the card. The list resets on the first Board where the run leaves running (a new stop); a run switch
// remounts the card. Pure: NextStepCard keeps the log in its state and draws stopView with StopList.

import type { ResumeResult, RunState } from '@openaflow/model'
import type { StopItem } from '../../components/StopList.tsx'
import type { NextItem } from './next-step.ts'
import type { ReplyPanelView, ReplyRowView } from './reply-view.ts'
import { NOT_LOGGED, SEND_LABEL, startedText, type ResumeWord } from './resume-flow.ts'

/**
 * `merged`: the PR the item merged, so a card that still names it waits for the Board. `sent`: the word of a Continue
 * or Go, so the current item reads `pod runs`. `back`: its button came back with the run out of running.
 */
export type StopDone = { key: string; label: string; time: string; note?: string; merged?: number; sent?: ResumeWord; back?: true }
/**
 * A started send's button stays hidden (pick 2 b: the sent line replaces it) while the run reads the state it had at
 * the send, the card keeps its key and the row its words, and for SEND_HOLD_MS at most. `item`: the sent item's key.
 */
export type SendHold = { word: ResumeWord; at: number; state: RunState; card: string; why: string | undefined; item: string }
/** `running`: the run read running on the last Board seen. `n` numbers the items' keys. */
export type StopLog = { done: StopDone[]; running: boolean; n: number; hold?: SendHold }

/** How long a started send's button stays hidden when the Board never shows the run move on. */
export const SEND_HOLD_MS = 60_000
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
export function logSent(log: StopLog, word: ResumeWord, at: number, result: ResumeResult, resume?: string, from?: { state: RunState; card: NextItem }): StopLog {
  if (result.outcome !== 'started') return log
  const note = result.logged ? startedText(resume) : `${startedText(resume)} ${NOT_LOGGED}`
  const next = add(log, { label: `Sent ${word}`, time: clock(at), note, sent: word })
  if (!from) return next
  return { ...next, hold: { word, at, state: from.state, card: from.card.key, why: sendRow(from.card, word)?.why, item: `done-${log.n}` } }
}

/** The card's reply row that sends `word`. */
function sendRow(card: NextItem, word: ResumeWord): ReplyRowView | undefined {
  return card.action.kind === 'reply' ? card.action.panel.rows.find((r) => r.send === word) : undefined
}

/** The button comes back. Out of running, the sent item is marked, so a card that shows the button again names it. */
function release(log: StopLog): StopLog {
  const { hold, ...rest } = log
  if (!hold) return log
  if (rest.running) return rest
  return { ...rest, done: rest.done.map((d): StopDone => (d.key === hold.item ? { ...d, back: true } : d)) }
}

/**
 * Each Board's state for the run. The first one out of running starts a new stop: the list empties. Any change from
 * the state at a send gives its button back, also when the state later goes back.
 */
export function logRunState(log: StopLog, state: RunState): StopLog {
  const running = state === 'running'
  let next = log
  if (running !== log.running) next = running ? { ...log, running } : { ...log, done: [], running }
  return next.hold && state !== next.hold.state ? release(next) : next
}

/** The card's row whose button the hold hides: the same card, and the row with the same words. */
function heldRow(log: StopLog, card: NextItem): ReplyRowView | undefined {
  const h = log.hold
  if (!h || card.key !== h.card) return undefined
  const row = sendRow(card, h.word)
  return row && row.why === h.why ? row : undefined
}

/** Each Board's card: a new card, or the held row with other words (a new stop), gives the button back. */
export function logCard(log: StopLog, card: NextItem): StopLog {
  return !log.hold || heldRow(log, card) ? log : release(log)
}

/** The card's timer for the hold that started at `at`: the button comes back. An older timer changes nothing. */
export function logHoldEnd(log: StopLog, at: number): StopLog {
  return log.hold?.at === at ? release(log) : log
}

/** Milliseconds until the hold ends at `now`, or undefined with no hold. */
export function holdEndsIn(log: StopLog, now: number): number | undefined {
  return log.hold ? Math.max(0, log.hold.at + SEND_HOLD_MS - now) : undefined
}

export type StopView = { items: StopItem[]; hideMerge: boolean }

/** The card's next action: the reply row's button label, else the card's title. */
function nextAction(card: NextItem): string {
  const send = card.action.kind === 'reply' ? card.action.panel.rows.find((r) => r.send !== undefined)?.send : undefined
  return send ? SEND_LABEL[send] : card.title
}

/**
 * The list to draw, and whether the card's Merge hides. No done item: no list. The current item is `pod runs` after
 * a send, until its button is back on the card; `Updating…` while the card still names a PR the list shows merged (and that Merge hides); else the card's
 * next action.
 */
export function stopView(log: StopLog, card: NextItem): StopView {
  const a = card.action
  const hideMerge = a.kind === 'merge' && log.done.some((d) => d.merged === a.number)
  if (log.done.length === 0) return { items: [], hideMerge }
  const last = log.done[log.done.length - 1]!
  // After a send, pod's turn, until its button is back on the card.
  const podTurn = last.sent !== undefined && !(last.back && sendRow(card, last.sent))
  const label = podTurn ? 'pod runs' : hideMerge ? 'Updating…' : nextAction(card)
  const done = log.done.map(({ key, label, time, note }): StopItem => ({ key, label, time, state: 'done', ...(note ? { note } : {}) }))
  return { items: [...done, { key: 'now', label, time: '', state: 'current' }], hideMerge }
}

/** The model's text for a `continue` after a merge: `PR #N merged.`, or `PR #N merged: <what pod does>.` */
const MERGED_WHY = /^PR #(\d+) merged(?:\.|: (.+))$/

/** A row's text, without the PR when the list already shows it merged (pick 1 b: `Continue so pod goes on`). */
function rowWhy(row: ReplyRowView, merged: ReadonlySet<number>): string {
  const m = row.word === 'continue' ? MERGED_WHY.exec(row.why) : null
  if (!m || !merged.has(Number(m[1]))) return row.why
  return `Continue so ${m[2] ?? 'pod goes on.'}`
}

/**
 * The reply panel as the card draws it, or undefined for a card with no reply. A row's text that names a PR the list
 * shows merged drops the PR, so the card names it once. A held send's row keeps Copy and loses its button. A new
 * object: the Waiting tab and other readers keep the model's panel.
 */
export function cardPanel(log: StopLog, card: NextItem): ReplyPanelView | undefined {
  if (card.action.kind !== 'reply') return undefined
  const panel = card.action.panel
  const merged = new Set(log.done.flatMap((d) => (d.merged === undefined ? [] : [d.merged])))
  const held = heldRow(log, card)
  if (merged.size === 0 && !held) return panel
  const rows = panel.rows.map((r): ReplyRowView => {
    const row = { ...r, why: rowWhy(r, merged) }
    if (r !== held) return row
    const { send: _send, ...copyOnly } = row
    return copyOnly
  })
  return { ...panel, rows }
}

export type Focusable = { focus(): void }
export type FocusRoot = { querySelector(selector: string): Focusable | null }
export const FOCUS_PRIMARY = 'button.btn.primary:not(:disabled)'
export const FOCUS_TITLE = '.next-title'

/**
 * After the merge panel closes: the card's primary button (Continue, once the Board moved on), else its title. Only
 * when focus fell to the body with the panel: focus you moved elsewhere while it merged stays, so a key press meant
 * for that never lands on Continue.
 */
export function focusAfterMerge(card: FocusRoot | null, doc: { activeElement: unknown; body: unknown }): void {
  if (!card || (doc.activeElement !== null && doc.activeElement !== doc.body)) return
  ;(card.querySelector(FOCUS_PRIMARY) ?? card.querySelector(FOCUS_TITLE))?.focus()
}
