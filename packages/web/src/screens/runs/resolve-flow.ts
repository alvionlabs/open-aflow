// Close and Keep: one click, one request, no form. A pure reducer (idle → saving → idle once written,
// or → error) and a small driver that sends `resolve`. The server reads the text it writes from the
// Board; the request carries only the repo, the entry's line, and which button. Every reply carries the
// number of the request it answers, so an older one is dropped, as in answer-flow.ts.

import type { ResolveOutcome, ResolveResult } from '@openaflow/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import type { Post } from './answer-flow.ts'
import type { WaitingRow } from './queue-view.ts'

export type ResolveKind = 'close' | 'keep'
export type ResolveTarget = { repoId: string; line: string; kind: ResolveKind }

export type ResolveState =
  | { kind: 'idle'; seq: number }
  | { kind: 'saving'; seq: number; target: ResolveTarget }
  | { kind: 'error'; seq: number; target: ResolveTarget; message: string }

export type ResolveEvent = { type: 'start'; target: ResolveTarget } | { type: 'saved'; seq: number; reply: ActionReply<ResolveResult> } | { type: 'dismiss' }

export const INITIAL_RESOLVE: ResolveState = { kind: 'idle', seq: 0 }

const FALLBACK: Record<Exclude<ResolveOutcome, 'closed' | 'kept'>, string> = {
  changed: 'The entry changed since you looked.',
  failed: "Couldn't write the queue.",
}

export function reduceResolve(s: ResolveState, e: ResolveEvent): ResolveState {
  switch (e.type) {
    case 'start':
      // One write at a time.
      if (s.kind === 'saving') return s
      return { kind: 'saving', seq: s.seq + 1, target: e.target }
    case 'saved': {
      if (s.kind !== 'saving' || e.seq !== s.seq) return s
      if (!e.reply.ok) return { kind: 'error', seq: s.seq, target: s.target, message: e.reply.message }
      const r = e.reply.data
      // Written: the Board drops the row, so there is nothing left to show.
      if (r.outcome === 'closed' || r.outcome === 'kept') return { kind: 'idle', seq: s.seq }
      return { kind: 'error', seq: s.seq, target: s.target, message: r.message?.trim() || FALLBACK[r.outcome] }
    }
    case 'dismiss':
      return s.kind === 'error' ? { kind: 'idle', seq: s.seq } : s
  }
}

export type ResolveFlow = { state(): ResolveState; start(target: ResolveTarget): void; dismiss(): void }

/** Runs the reducer and sends `resolve` as it moves to saving. */
export function createResolveFlow(onChange: (s: ResolveState) => void, post: Post = (path, body) => postAction(path, body)): ResolveFlow {
  let state = INITIAL_RESOLVE
  const dispatch = (e: ResolveEvent) => {
    const prev = state
    state = reduceResolve(state, e)
    if (state === prev) return
    onChange(state)
    const s = state
    if (e.type === 'start' && s.kind === 'saving') {
      void post<ResolveResult>('resolve', { repoId: s.target.repoId, line: s.target.line, kind: s.target.kind }).then((reply) =>
        dispatch({ type: 'saved', seq: s.seq, reply }),
      )
    }
  }
  return {
    state: () => state,
    start: (target) => dispatch({ type: 'start', target }),
    dismiss: () => dispatch({ type: 'dismiss' }),
  }
}

/** The pressed button's words while its request runs (`Closing…`, `Keeping…`); undefined for any other button. */
export function busyLabel(s: ResolveState, target: ResolveTarget): string | undefined {
  if (s.kind !== 'saving' || s.target.line !== target.line || s.target.kind !== target.kind || s.target.repoId !== target.repoId) return undefined
  return target.kind === 'close' ? 'Closing…' : 'Keeping…'
}

/** The key of the row an error shows under; `end` once its row left the list; undefined with no error or for another repo. */
export function resolveAnchor(s: ResolveState, rows: Pick<WaitingRow, 'key' | 'line'>[], repoId: string): string | undefined {
  if (s.kind !== 'error' || s.target.repoId !== repoId) return undefined
  return rows.find((r) => r.line === s.target.line)?.key ?? 'end'
}

/** What Close or Keep would act on for this row, or undefined when the row offers neither. */
export function triageTarget(row: WaitingRow | undefined, repoId: string): ResolveTarget | undefined {
  if (!row) return undefined
  if (row.done !== undefined) return { repoId, line: row.line, kind: 'close' }
  if (row.keep !== undefined) return { repoId, line: row.line, kind: 'keep' }
  return undefined
}
