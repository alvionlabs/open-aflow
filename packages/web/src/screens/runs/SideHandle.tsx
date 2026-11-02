import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, dragWidth, keyWidth } from './sidebar-width.ts'

type Props = {
  width: number
  /** Each new width while dragging or on a key press. */
  onResize: (width: number) => void
  /** The width to remember: at the end of a drag, after a key press, or on a reset. */
  onCommit: (width: number) => void
}

/**
 * The drag handle on the sidebar's right edge: a vertical separator. Drag it, press Left or Right, or
 * Home or a double-click to reset. The width rules are in sidebar-width.ts; this only wires the events.
 */
export function SideHandle({ width, onResize, onCommit }: Props) {
  const drag = useRef<{ left: number; width: number } | undefined>(undefined)

  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = undefined
    delete document.documentElement.dataset.resizing
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onCommit(d.width)
  }

  return (
    <div
      className="side-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-controls="side"
      aria-valuenow={width}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0
        drag.current = { left, width }
        document.documentElement.dataset.resizing = ''
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        d.width = dragWidth(e.clientX, d.left)
        onResize(d.width)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onCommit(SIDE_DEFAULT)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        const next = keyWidth(width, e.key)
        if (next === undefined) return
        e.preventDefault()
        onCommit(next)
      }}
    />
  )
}
