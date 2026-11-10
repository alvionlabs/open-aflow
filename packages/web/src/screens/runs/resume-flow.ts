// The auto-continue switch in the run bar, and the Continue and Go buttons in the Reply panel.
// Two pure reducers with small drivers, like merge-flow.ts and answer-flow.ts. Each request is
// sent only on a press, and each reply carries the number of the request it answers, so an
// older one is dropped. The switch only ever posts auto-continue; only a press of Go sends go.

import type { Board, ResumeResult, RunSummary } from '@openaflow/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import { outcomeChip } from './action-log-view.ts'
import type { Chip } from './view.ts'

/** The run a request is for: its repo and its run (a plan slug or `fix-<slug>`). */
export type RunTarget = { repoId: string; run: string }
export type Post = <T>(path: string, body: object) => Promise<ActionReply<T>>

const defaultPost: Post = (path, body) => postAction(path, body)

// The switch

/** The switch for a plan or fix run: on when the Board lists it in autoContinue. None for a repo row. */
export function switchView(run: RunSummary | undefined, board: Board | undefined): { on: boolean } | undefined {
  if (!run || run.plan === undefined) return undefined
  const on = (board?.autoContinue ?? []).some((t) => t.repoId === run.repoId && t.run === run.plan)
  return { on }
}

/**
 * `saving` shows the value asked for; `saved` the value the server confirmed, until the Board
 * agrees; `error` the Board's value (the one before the press) with the message.
 */
export type ToggleState =
  | { kind: 'idle'; seq: number }
  | { kind: 'saving'; seq: number; on: boolean }
  | { kind: 'saved'; seq: number; on: boolean }
  | { kind: 'error'; seq: number; on: boolean; message: string }

export type ToggleEvent =
  | { type: 'press'; boardOn: boolean }
  | { type: 'reply'; seq: number; reply: ActionReply<{ on: boolean }>; boardOn: boolean }
  | { type: 'board'; on: boolean }

export const TOGGLE_INITIAL: ToggleState = { kind: 'idle', seq: 0 }

export type ToggleView = { on: boolean; disabled: boolean; error?: string }

/** What the switch shows, given the Board's value for its run. */
export function toggleView(boardOn: boolean, s: ToggleState): ToggleView {
  switch (s.kind) {
    case 'idle':
      return { on: boardOn, disabled: false }
    case 'saving':
      return { on: s.on, disabled: true }
    case 'saved':
      return { on: s.on, disabled: false }
    case 'error':
      return { on: boardOn, disabled: false, error: s.message }
  }
}

export function reduceToggle(s: ToggleState, e: ToggleEvent): ToggleState {
  switch (e.type) {
    case 'press':
      if (s.kind === 'saving') return s
      return { kind: 'saving', seq: s.seq + 1, on: !toggleView(e.boardOn, s).on }
    case 'reply': {
      if (s.kind !== 'saving' || e.seq !== s.seq) return s
      if (!e.reply.ok) return { kind: 'error', seq: s.seq, on: e.boardOn, message: e.reply.message }
      const on = typeof e.reply.data?.on === 'boolean' ? e.reply.data.on : s.on
      return on === e.boardOn ? { kind: 'idle', seq: s.seq } : { kind: 'saved', seq: s.seq, on }
    }
    case 'board':
      // The Board caught up with the saved value: it's the source again.
      return s.kind === 'saved' && e.on === s.on ? { kind: 'idle', seq: s.seq } : s
  }
}

export type ToggleFlow = {
  state(): ToggleState
  /** Flip the switch: posts the opposite of what it shows. Nothing while saving. */
  press(): void
  /** The Board's value for this run, on every Board. */
  board(on: boolean): void
}

/** Runs the toggle reducer and posts auto-continue as it moves to saving. */
export function createToggleFlow(target: RunTarget, onChange: (s: ToggleState) => void, post: Post = defaultPost): ToggleFlow {
  let state = TOGGLE_INITIAL
  let boardOn = false
  const dispatch = (e: ToggleEvent) => {
    const prev = state
    state = reduceToggle(state, e)
    if (state === prev) return
    onChange(state)
    const s = state
    if (s.kind === 'saving' && prev.kind !== 'saving') {
      void post<{ on: boolean }>('auto-continue', { repoId: target.repoId, run: target.run, on: s.on }).then((reply) =>
        dispatch({ type: 'reply', seq: s.seq, reply, boardOn }),
      )
    }
  }
  return {
    state: () => state,
    press: () => dispatch({ type: 'press', boardOn }),
    board: (on) => {
      boardOn = on
      dispatch({ type: 'board', on })
    },
  }
}

// Continue and Go

export type ResumeWord = 'continue' | 'go'

export type ResumeState =
  | { kind: 'idle'; seq: number }
  | { kind: 'sending'; seq: number; word: ResumeWord }
  | { kind: 'result'; seq: number; word: ResumeWord; result: ResumeResult }
  | { kind: 'error'; seq: number; word: ResumeWord; message: string }

export type ResumeEvent =
  | { type: 'press'; word: ResumeWord }
  | { type: 'reply'; seq: number; reply: ActionReply<ResumeResult> }
  | { type: 'close' }

export const RESUME_INITIAL: ResumeState = { kind: 'idle', seq: 0 }

export function reduceResume(s: ResumeState, e: ResumeEvent): ResumeState {
  switch (e.type) {
    case 'press':
      // One send at a time: every button is off while one is in flight.
      return s.kind === 'sending' ? s : { kind: 'sending', seq: s.seq + 1, word: e.word }
    case 'reply':
      if (s.kind !== 'sending' || e.seq !== s.seq) return s
      return e.reply.ok
        ? { kind: 'result', seq: s.seq, word: s.word, result: e.reply.data }
        : { kind: 'error', seq: s.seq, word: s.word, message: e.reply.message }
    case 'close':
      return s.kind === 'idle' || s.kind === 'sending' ? s : { kind: 'idle', seq: s.seq }
  }
}

export type ResumeFlow = {
  state(): ResumeState
  press(word: ResumeWord): void
  close(): void
}

/** Runs the resume reducer and posts resume once per press. */
export function createResumeFlow(target: RunTarget, onChange: (s: ResumeState) => void, post: Post = defaultPost): ResumeFlow {
  let state = RESUME_INITIAL
  const dispatch = (e: ResumeEvent) => {
    const prev = state
    state = reduceResume(state, e)
    if (state === prev) return
    onChange(state)
    const s = state
    if (s.kind === 'sending') {
      void post<ResumeResult>('resume', { repoId: target.repoId, run: target.run, reply: s.word }).then((reply) => dispatch({ type: 'reply', seq: s.seq, reply }))
    }
  }
  return {
    state: () => state,
    press: (word) => dispatch({ type: 'press', word }),
    close: () => dispatch({ type: 'close' }),
  }
}

export const RESUME_FAILED = "The session didn't start."
export const NOT_LOGGED = 'Not saved to the action log.'

/** The started line. A terminal already open on the session doesn't show what the board sent. */
export function startedText(resume: string | undefined): string {
  const base = "The session started again. A terminal open on it won't show the board's send"
  return resume ? `${base}: run ${resume} to see it.` : `${base}.`
}

export type ResumeView = {
  /** A request is in flight: every Continue and Go button is off. */
  busy: boolean
  /** The word last pressed, so the result shows under its row. */
  word?: ResumeWord
  status?: string
  result?: { chip: Chip; words: string; note?: string }
  /** The route's refusal or the action client's message. */
  error?: string
}

/** What the panel shows for the buttons. `resume` is the session's `claude --resume <id>`. */
export function resumeView(s: ResumeState, resume: string | undefined): ResumeView {
  switch (s.kind) {
    case 'idle':
      return { busy: false }
    case 'sending':
      return { busy: true, word: s.word, status: `Sending ${s.word}…` }
    case 'error':
      return { busy: false, word: s.word, error: s.message }
    case 'result': {
      const r = s.result
      const words = r.outcome === 'started' ? startedText(resume) : r.message?.trim() || RESUME_FAILED
      const result: NonNullable<ResumeView['result']> = { chip: outcomeChip(r.outcome), words }
      if (!r.logged) result.note = NOT_LOGGED
      return { busy: false, word: s.word, result }
    }
  }
}
