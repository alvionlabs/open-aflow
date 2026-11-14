// A yes-or-no question in the shared modal: the heading, the detail, mono lines (paths, port bases), muted notes,
// the status and the error (the shared alert box), then Cancel (quiet) and the confirm (danger). Busy turns both buttons off.
import { useId } from 'react'
import { Modal } from './Modal.tsx'
import { ModalAlert } from './ModalAlert.tsx'

export type ConfirmModalProps = {
  heading: string
  detail: string
  mono?: string[]
  notes?: string[]
  confirmLabel: string
  busy: boolean
  status?: string
  error?: string
  onConfirm: () => void
  onCancel: () => void
  /** The id that takes focus back on close, unless focus moved elsewhere. */
  returnFocusTo: string
}

export function ConfirmModal({ heading, detail, mono, notes, confirmLabel, busy, status, error, onConfirm, onCancel, returnFocusTo }: ConfirmModalProps) {
  const headingId = useId()
  return (
    <Modal labelledBy={headingId} busy={busy} onClose={onCancel} className="confirm-modal" returnFocusTo={returnFocusTo}>
      <h2 id={headingId} className="modal-heading">
        {heading}
      </h2>
      <p className="modal-detail">{detail}</p>
      {mono?.map((line, i) => (
        <p key={`m${i}`} className="mono modal-mono">
          {line}
        </p>
      ))}
      {notes?.map((line, i) => (
        <p key={`n${i}`} className="muted modal-note">
          {line}
        </p>
      ))}
      <p className="muted modal-status" role="status">
        {status}
      </p>
      {error && <ModalAlert message={error} />}
      <div className="modal-actions">
        <button className="btn quiet" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" type="button" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
