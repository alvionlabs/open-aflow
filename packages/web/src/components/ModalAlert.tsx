// The shared modal's error: a box with a red border and a light red tint, the alert icon, and the message in --fg.
// Every modal error uses it (Add repo, Remove repo, Forget), so they all look the same. Styles are in modal.css.
import { Icon } from '../theme/icons.tsx'

/** `id` lets a field point at the message with `aria-describedby`. */
export function ModalAlert({ message, id }: { message: string; id?: string }) {
  return (
    <div id={id} className="modal-alert" role="alert">
      <Icon name="alert" />
      <p className="modal-alert-text">{message}</p>
    </div>
  )
}
