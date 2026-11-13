// The shared modal: a native <dialog> opened with showModal(), so the page behind is inert and Escape
// arrives as `cancel`. It is open while mounted. The rules are in modal.ts; this file only wires them.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createModalEvents, keepFocusInside, returnFocus } from './modal.ts'
import './modal.css'

export type ModalProps = {
  /** The id of the element that names the dialog, usually its heading. */
  labelledBy: string
  /** While true, Escape and a backdrop press don't call onClose. */
  busy: boolean
  onClose: () => void
  className?: string
  /** The id that takes focus back when the modal leaves, unless something else took it. */
  returnFocusTo?: string
  children?: ReactNode
}

export function Modal({ labelledBy, busy, onClose, className, returnFocusTo, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const props = useRef({ busy, onClose })
  props.current = { busy, onClose }
  const [events] = useState(() => createModalEvents(() => props.current))

  // Before any child effect: a closed dialog can't take focus.
  useLayoutEffect(() => {
    const el = ref.current
    events.mount()
    if (el && !el.open) el.showModal()
    return () => {
      events.unmount()
      if (el?.open) el.close()
      // The page settles first (a menu remounts, a card leaves), so look the element up then.
      if (returnFocusTo) setTimeout(() => returnFocus(returnFocusTo, document), 0)
    }
  }, [])

  useEffect(() => keepFocusInside(ref.current, document))

  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : 'modal'}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onCancel={(e) => events.cancel(e)}
      onClose={(e) => events.nativeClose(e.currentTarget)}
      onPointerDown={(e) => events.pointerDown(e)}
      onPointerUp={(e) => events.pointerUp(e)}
      onClick={(e) => events.click(e)}
    >
      <div className="modal-panel">{children}</div>
    </dialog>
  )
}
