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

/** The confirm's markup: an in-place panel, not a dialog. Remove is the danger button; Cancel stays neutral. */
export function RemoveConfirmView({ view, onRemove, onCancel, onKey, panelRef }: ViewProps) {
  return (
    <section ref={panelRef} className="inplace remove-confirm" aria-label={view.heading} tabIndex={-1} onKeyDown={(e: KeyboardEvent) => onKey(e.key)}>
      <div className="merge-head">
        <b>{view.heading}</b>
        <span className="mono note remove-path">{view.path}</span>
      </div>
      <p className="remove-body">{view.body}</p>
      {view.runsLine && <p className="remove-body">{view.runsLine}</p>}
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
        <button className="btn danger" type="button" disabled={view.busy} onClick={onRemove}>
          Remove
        </button>
        <button className="btn quiet" type="button" disabled={view.busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}

/**
 * The confirm, under the run header or under a sidebar card. Focus moves into it when it opens and back
 * to the ⋯ button it came from (`returnTo`) when it closes; when that button left with its card, to the
 * header's ⋯.
 */
export function RemoveConfirm({ returnTo, ...props }: Omit<ViewProps, 'panelRef'> & { returnTo: string }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = ref.current
    panel?.focus()
    // After a removal the page settles first (the menu remounts, the card leaves), so look the button up then.
    // A panel still on the page wasn't closed (StrictMode runs this cleanup once on mount): keep focus.
    return () => {
      setTimeout(() => {
        if (panel?.isConnected) return
        ;(document.getElementById(returnTo) ?? document.getElementById(MENU_TRIGGER_ID))?.focus()
      }, 0)
    }
  }, [])
  // Buttons go disabled while removing; keep focus in the panel so Escape still reaches it.
  useEffect(() => {
    const panel = ref.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
  }, [props.view.busy, props.view.error])
  return <RemoveConfirmView {...props} panelRef={ref} />
}
