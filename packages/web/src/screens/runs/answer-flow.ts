// The answer form that opens in place under a queue entry waiting on you.
// A pure reducer (idle → editing → saving → result, or → error; cancel → idle) and a small
// driver that sends the answer. The text is checked with cleanAnswer before anything is sent.
// Every reply carries the number of the request it answers, so an older one is dropped.

import { cleanAnswer, type AnswerOutcome, type AnswerResult } from '@pod-board/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import { outcomeChip } from './action-log-view.ts'
import { ANSWER_NOTE } from './queue-view.ts'
import type { Chip } from './view.ts'

/**
 * The entry an answer is for: its repo and its whole line as the Board read it. `entry`: the text the
 * card's form quotes, kept from when it opened, so it stays this entry's after the card moves to another.
 * Only `repoId` and `line` are sent or compared.
 */
export type AnswerTarget = { repoId: string; line: string; entry?: string }
export type Post = <T>(path: string, body: object) => Promise<ActionReply<T>>

/** `seq` counts requests; a reply for an older one is ignored. `text` is what you typed, as typed. */
export type AnswerState =
  | { kind: 'idle'; seq: number }
  | { kind: 'editing'; seq: number; target: AnswerTarget; text: string; error?: string }
  | { kind: 'saving'; seq: number; target: AnswerTarget; text: string }
  | { kind: 'result'; seq: number; target: AnswerTarget; text: string; result: AnswerResult }
  | { kind: 'error'; seq: number; target: AnswerTarget; text: string; message: string }

export type AnswerEvent =
  | { type: 'open'; target: AnswerTarget }
  | { type: 'type'; text: string }
  | { type: 'save' }
  | { type: 'saved'; seq: number; reply: ActionReply<AnswerResult> }
  | { type: 'cancel' }
  | { type: 'key'; key: string }

export const INITIAL: AnswerState = { kind: 'idle', seq: 0 }

const sameTarget = (a: AnswerTarget, b: AnswerTarget) => a.repoId === b.repoId && a.line === b.line

/** Whether the form still holds text you can save: not while saving, and not once answered. */
const canEdit = (s: AnswerState): s is Extract<AnswerState, { kind: 'editing' | 'result' | 'error' }> =>
  s.kind === 'editing' || s.kind === 'error' || (s.kind === 'result' && s.result.outcome !== 'answered')

export function reduce(s: AnswerState, e: AnswerEvent): AnswerState {
  switch (e.type) {
    case 'open':
      // One form at a time: opening another closes this one, but never mid-save.
      if (s.kind === 'saving') return s
      if (s.kind !== 'idle' && canEdit(s) && sameTarget(s.target, e.target)) return s
      return { kind: 'editing', seq: s.seq, target: e.target, text: '' }
    case 'type':
      if (!canEdit(s)) return s
      // Typing clears a text error; a server's result or error stays until the next save.
      if (s.kind === 'editing') return { kind: 'editing', seq: s.seq, target: s.target, text: e.text }
      return { ...s, text: e.text }
    case 'save': {
      if (!canEdit(s)) return s
      const clean = cleanAnswer(s.text)
      if (!clean.ok) return { kind: 'editing', seq: s.seq, target: s.target, text: s.text, error: clean.error }
      return { kind: 'saving', seq: s.seq + 1, target: s.target, text: s.text }
    }
    case 'saved':
      if (s.kind !== 'saving' || e.seq !== s.seq) return s
      return e.reply.ok
        ? { kind: 'result', seq: s.seq, target: s.target, text: s.text, result: e.reply.data }
        : { kind: 'error', seq: s.seq, target: s.target, text: s.text, message: e.reply.message }
    case 'cancel':
      return s.kind === 'idle' || s.kind === 'saving' ? s : { kind: 'idle', seq: s.seq }
    case 'key':
      return e.key === 'Escape' ? reduce(s, { type: 'cancel' }) : s
  }
}

export type AnswerFlow = {
  state(): AnswerState
  open(target: AnswerTarget): void
  type(text: string): void
  save(): void
  cancel(): void
  key(key: string): void
}

/** Runs the reducer and sends `answer` as it moves to saving. */
export function createAnswerFlow(onChange: (s: AnswerState) => void, post: Post = (path, body) => postAction(path, body)): AnswerFlow {
  let state = INITIAL
  const dispatch = (e: AnswerEvent) => {
    const prev = state
    state = reduce(state, e)
    if (state === prev) return
    onChange(state)
    const s = state
    if (s.kind === 'saving') {
      const clean = cleanAnswer(s.text)
      // The reducer only reaches saving with a clean text.
      if (!clean.ok) return
      void post<AnswerResult>('answer', { repoId: s.target.repoId, line: s.target.line, text: clean.text }).then((reply) =>
        dispatch({ type: 'saved', seq: s.seq, reply }),
      )
    }
  }
  return {
    state: () => state,
    open: (target) => dispatch({ type: 'open', target }),
    type: (text) => dispatch({ type: 'type', text }),
    save: () => dispatch({ type: 'save' }),
    cancel: () => dispatch({ type: 'cancel' }),
    key: (key) => dispatch({ type: 'key', key }),
  }
}

const FALLBACK: Record<AnswerOutcome, string> = {
  answered: 'Saved to the queue.',
  changed: 'The entry changed since you looked.',
  failed: "Couldn't write the queue.",
}

/** `Saved to the queue.` only for answered; else the server's message, or plain words. */
function resultWords(r: AnswerResult): string {
  if (r.outcome === 'answered') return FALLBACK.answered
  return r.message?.trim() || FALLBACK[r.outcome]
}

export type FormView = {
  /** The entry's text to quote above the box: the card's form only (a row shows its own entry). */
  entry?: string
  /** Show the text box with `text`. */
  showText: boolean
  text: string
  canSave: boolean
  /** What's happening while the request runs. */
  status?: string
  /** A text error, or the action client's message. */
  error?: string
  result?: { words: string; chip: Chip; note?: string }
  note: string
  closeLabel: 'Cancel' | 'Close'
  cancelDisabled: boolean
}

/** What the form shows, with the run's note (see answerNote); undefined while closed. */
export function formView(s: AnswerState, note: string = ANSWER_NOTE): FormView | undefined {
  if (s.kind === 'idle') return undefined
  const base: FormView = { showText: true, text: s.text, canSave: true, note, closeLabel: 'Cancel', cancelDisabled: false }
  if (s.target.entry !== undefined) base.entry = s.target.entry
  switch (s.kind) {
    case 'editing':
      return s.error === undefined ? base : { ...base, error: s.error }
    case 'saving':
      return { ...base, canSave: false, status: 'Saving…', cancelDisabled: true }
    case 'error':
      return { ...base, error: s.message, closeLabel: 'Close' }
    case 'result': {
      const r = s.result
      const result: NonNullable<FormView['result']> = { words: resultWords(r), chip: outcomeChip(r.outcome) }
      if (!r.logged) result.note = 'Not saved to the action log.'
      const answered = r.outcome === 'answered'
      return { ...base, showText: !answered, canSave: !answered, result, closeLabel: 'Close' }
    }
  }
}
