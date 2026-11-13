/**
 * The shared modal's rules, with no DOM: Modal.tsx and ConfirmModal.tsx only wire them.
 *
 * The modal is controlled by mount: while the component is on the page, its native <dialog> is open. React owns the
 * close, so Escape (`cancel`) and a backdrop press only ask the parent through `onClose`, and never while `busy`.
 */

/**
 * Whether a press closes the modal as a backdrop click. A click lands on the nearest common ancestor of where the
 * press went down and came up, so it hits the `<dialog>` whenever either end is on `::backdrop`: a drag out of a text
 * box, or a press from the dimmed page into the panel. Only a press that goes down, clicks, and comes up on the
 * dialog element itself counts. The panel is a child, so a press on it never targets the dialog.
 */
export function backdropClose(downOnDialog: boolean, clickOnDialog: boolean, upOnDialog: boolean): boolean {
  return downOnDialog && clickOnDialog && upOnDialog
}

export type ModalState = { busy: boolean; onClose: () => void }
export type PressEvent = { target: unknown; currentTarget: unknown }
export type DialogLike = { open: boolean; showModal(): void }

/**
 * The dialog's event handlers. `state` is read at each event, so a handler made once sees the latest props.
 * - `cancel` (Escape) is always prevented; it asks to close unless busy.
 * - A backdrop press asks to close unless busy; each press starts clean.
 * - `nativeClose` is the `close` event: Chromium can skip `cancel` on a repeated Escape and close the dialog itself.
 *   While mounted, the dialog opens again; unless busy, it asks to close, once, if no cancel or press asked already.
 *   A close event that arrives after unmount, or after a StrictMode remount reopened the dialog, does nothing.
 */
export function createModalEvents(state: () => ModalState) {
  let mounted = false
  let asked = false
  let down = false
  let up = false

  const ask = () => {
    const { busy, onClose } = state()
    if (busy) return
    asked = true
    onClose()
  }

  return {
    mount() {
      mounted = true
      asked = false
    },
    unmount() {
      mounted = false
    },
    cancel(e: { preventDefault(): void }) {
      e.preventDefault()
      ask()
    },
    pointerDown(e: PressEvent) {
      down = e.target === e.currentTarget
      up = false
    },
    pointerUp(e: PressEvent) {
      up = e.target === e.currentTarget
    },
    click(e: PressEvent) {
      const hit = backdropClose(down, e.target === e.currentTarget, up)
      down = false
      up = false
      if (hit) ask()
    },
    nativeClose(dialog: DialogLike) {
      if (!mounted || dialog.open) return
      dialog.showModal()
      if (!asked) ask()
    },
  }
}

/**
 * Runs once the modal has left and the page has settled. Focus that something else took stays there. Else focus
 * fell to the body with the dialog, so it goes to `#id`, when that is still on the page.
 */
export function returnFocus(id: string, doc: Pick<Document, 'getElementById' | 'activeElement' | 'body'>): void {
  if (doc.activeElement !== null && doc.activeElement !== doc.body) return
  doc.getElementById(id)?.focus()
}

/**
 * A focused button that goes disabled drops focus to the body; take it to the dialog instead, so Escape still
 * reaches it. Chromium drops the focus only at its next frame, after React's effects, so a disabled control that
 * still holds focus counts as lost too.
 */
export function keepFocusInside(dialog: { contains(node: unknown): boolean; focus(): void } | null, doc: { activeElement: unknown }): void {
  if (!dialog) return
  const active = doc.activeElement as { disabled?: unknown } | null
  if (!dialog.contains(active) || active?.disabled === true) dialog.focus()
}
