import type { RemoveView } from './remove-flow.ts'

type ViewProps = { view: RemoveView; onRemove: () => void; onCancel: () => void; onKey: (key: string) => void }

export function RemoveConfirmView(_props: ViewProps) {
  return null
}
