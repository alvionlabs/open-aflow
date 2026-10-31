import type { WaitingRow } from './queue-view.ts'
import { busyLabel, type ResolveFlow, type ResolveState, type ResolveTarget } from './resolve-flow.ts'

/** The muted line under an entry: `Done: <reason>`, or the value in use as the default, cut to one line with the whole in a title. */
export function TriageLine({ row }: { row: WaitingRow }) {
  const text = row.done !== undefined ? `Done: ${row.done}` : row.keep !== undefined ? `Default: ${row.keep}` : undefined
  if (text === undefined) return null
  return (
    <p className="wait-hint" title={text}>
      {text}
    </p>
  )
}

/** Close or Keep, a secondary button beside Answer. `busy`: another write runs, so it waits. */
export function TriageButton({ target, state, flow, busy, size }: { target: ResolveTarget; state: ResolveState; flow: ResolveFlow; busy: boolean; size: 'sm' | 'md' }) {
  const label = busyLabel(state, target) ?? (target.kind === 'close' ? 'Close' : 'Keep')
  return (
    <button className={size === 'sm' ? 'btn sm quiet' : 'btn quiet'} type="button" disabled={busy || state.kind === 'saving'} onClick={() => flow.start(target)}>
      {label}
    </button>
  )
}

/** A failed Close or Keep: the reason, and Dismiss. */
export function TriageError({ state, flow }: { state: ResolveState; flow: ResolveFlow }) {
  if (state.kind !== 'error') return null
  return (
    <div className="triage-error">
      <p className="answer-error" role="alert">
        {state.message}
      </p>
      <button className="btn sm quiet" type="button" onClick={() => flow.dismiss()}>
        Dismiss
      </button>
    </div>
  )
}
