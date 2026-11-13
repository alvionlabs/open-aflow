import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Chip } from './Chip.tsx'
import { INITIAL, confirmView, createMergeFlow, type MergeFlow, type MergeState } from './merge-flow.ts'

/**
 * One merge flow, owned by the pipeline that shows the Merge buttons. With `onMerged` (the Next step card), the panel
 * closes on `merged` and the owner shows the merge; without it (the Waiting tab), the result stays in the panel.
 */
export function useMergeFlow(onMerged?: (number: number, at: number) => void): [MergeState, MergeFlow] {
  const [state, setState] = useState<MergeState>(INITIAL)
  // Read at the reply, so the flow made once calls the latest one.
  const merged = useRef(onMerged)
  useEffect(() => {
    merged.current = onMerged
  })
  const hooked = onMerged !== undefined
  const flow = useMemo(() => createMergeFlow(setState, undefined, hooked ? { onMerged: (n, at) => merged.current?.(n, at) } : {}), [hooked])
  return [state, flow]
}

export const mergeButtonId = (number: number) => `merge-pr-${number}`

/** `returnFocus`: where focus goes when the panel closes; by default, back to its Merge button. */
type Props = { state: MergeState; flow: MergeFlow; label: string; returnFocus?: () => void }

/** The confirm, opened in place under the pipeline step it acts on. */
export function MergeConfirm({ state, flow, label, returnFocus }: Props) {
  const view = confirmView(state)
  const ref = useRef<HTMLElement>(null)
  const number = state.kind === 'idle' ? undefined : state.target.number

  const back = useRef(returnFocus)
  useEffect(() => {
    back.current = returnFocus
  })
  // Focus moves into the panel when it opens, so Escape reaches it, and back to its Merge button when it closes.
  useEffect(() => {
    if (number === undefined) return
    ref.current?.focus()
    return () => {
      if (back.current) back.current()
      else document.getElementById(mergeButtonId(number))?.focus()
    }
  }, [number])
  // A step's buttons change (Check again gives way to Merge); keep focus in the panel so Escape still works.
  useEffect(() => {
    const panel = ref.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
  }, [state.kind])

  if (!view) return null
  const onKey = (e: KeyboardEvent) => flow.key(e.key)
  const whyId = `merge-why-${number}`
  return (
    <section ref={ref} className="inplace merge-confirm" aria-label={`Merge ${view.heading}`} tabIndex={-1} onKeyDown={onKey}>
      <div className="merge-head">
        <span className="eyebrow">{label}</span>
        <span>
          <b>{view.heading}</b>
          {view.title && <span className="merge-title"> {view.title}</span>}
        </span>
      </div>
      {view.checks && (
        <div className="merge-facts">
          <Chip chip={view.checks} />
          <span>{view.mergeability}</span>
          <span className="mono note">head {view.sha}</span>
        </div>
      )}
      {view.blockReason && (
        <p id={whyId} className="merge-why">
          {view.blockReason}
        </p>
      )}
      {view.status && (
        <p className="muted merge-status" role="status">
          {view.status}
        </p>
      )}
      {view.result && (
        <div className="merge-result" role="status">
          <Chip chip={view.result.chip} />
          <span>{view.result.words}</span>
          {view.result.note && <span className="note">{view.result.note}</span>}
        </div>
      )}
      {view.error && (
        <p className="merge-error" role="alert">
          {view.error}
        </p>
      )}
      <div className="inplace-actions">
        {view.showMerge && (
          <button className="btn primary" type="button" disabled={!view.canMerge} aria-describedby={view.blockReason ? whyId : undefined} onClick={() => flow.merge()}>
            Merge (merge commit)
          </button>
        )}
        {view.checkAgain && (
          <button className="btn" type="button" onClick={() => flow.retry()}>
            Check again
          </button>
        )}
        {view.tryAgain && (
          <button className="btn" type="button" onClick={() => flow.retry()}>
            Try again
          </button>
        )}
        <button className="btn quiet" type="button" disabled={view.cancelDisabled} onClick={() => flow.cancel()}>
          {view.closeLabel}
        </button>
      </div>
    </section>
  )
}
