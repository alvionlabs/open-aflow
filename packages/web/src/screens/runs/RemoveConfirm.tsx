import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { MENU_TRIGGER_ID } from './BarMenu.tsx'
import type { RemoveView } from './remove-flow.ts'

type ViewProps = {
  view: RemoveView
  onRemove: () => void
  onCancel: () => void
  onKey: (key: string) => void
  panelRef?: RefObject<HTMLElement | null>
}

/** The confirm's markup: an in-place panel, not a dialog. */
export function RemoveConfirmView({ view, onRemove, onCancel, onKey, panelRef }: ViewProps) {
  return (
    <section
      ref={panelRef}
      className="inplace remove-confirm"
      aria-label={view.heading}
      tabIndex={-1}
      onKeyDown={(e: KeyboardEvent) => onKey(e.key)}
    >
      <div className="merge-head">
        <b>{view.heading}</b>
        <span className="mono note remove-path">{view.path}</span>
      </div>
      <p className="remove-body">{view.body}</p>
      {view.claimNote && <p className="remove-body muted">{view.claimNote}</p>}
      {view.status && (
        <p className="muted merge-status" role="status">
          {view.status}
        </p>
      )}
      {view.error && (
        <p className="merge-error" role="alert">
          {view.error}
        </p>
      )}
      <div className="inplace-actions">
        <button className="btn primary" type="button" disabled={view.busy} onClick={onRemove}>
          Remove
        </button>
        <button className="btn quiet" type="button" disabled={view.busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}

/** The confirm under the run header. Focus moves into it when it opens and back to the ⋯ trigger when it closes. */
export function RemoveConfirm(props: Omit<ViewProps, 'panelRef'>) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus()
    // After a removal the menu remounts for the next run, so find the trigger once the page has settled.
    return () => {
      setTimeout(() => document.getElementById(MENU_TRIGGER_ID)?.focus(), 0)
    }
  }, [])
  // Buttons go disabled while removing; keep focus in the panel so Escape still reaches it.
  useEffect(() => {
    const panel = ref.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
  }, [props.view.busy, props.view.error])
  return <RemoveConfirmView {...props} panelRef={ref} />
}
