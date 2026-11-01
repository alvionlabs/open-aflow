import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { Icon } from '../../theme/icons.tsx'
import { RemoveRepoItem, useMenu } from './menu-parts.tsx'
import './menu.css'

export type RunMoreMenuViewProps = {
  open: boolean
  onToggle: () => void
  onRemove: () => void
  /** The run's name, for the button's label: `More for <run name>`. */
  runName: string
  /** The button's id: the remove confirm gives focus back to it. */
  triggerId: string
  /** Where the fixed menu sits on the page. */
  position?: CSSProperties
  triggerRef?: RefObject<HTMLButtonElement | null>
  menuRef?: RefObject<HTMLDivElement | null>
}

/** A sidebar card's ⋯ button and, when open, its menu: the same Remove repo item as the header's. */
export function RunMoreMenuView({ open, onToggle, onRemove, runName, triggerId, position, triggerRef, menuRef }: RunMoreMenuViewProps) {
  return (
    <div className="run-more-wrap">
      <button ref={triggerRef} id={triggerId} type="button" className="btn icon run-more" aria-label={`More for ${runName}`} aria-expanded={open} onClick={onToggle}>
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menuRef} className="menu run-more-panel" role="group" aria-label={`More for ${runName}`} style={position}>
          <RemoveRepoItem onPick={onRemove} />
        </div>
      )}
    </div>
  )
}

const GAP = 4
const EDGE = 8

/** A sidebar card's ⋯ menu. It opens fixed under its button, right edges aligned, inside the viewport. */
export function RunMoreMenu({ runName, triggerId, onRemove }: { runName: string; triggerId: string; onRemove: () => void }) {
  const { open, send, triggerRef, menuRef } = useMenu(triggerId)
  const [position, setPosition] = useState<CSSProperties>()

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const right = Math.max(EDGE, window.innerWidth - r.right)
      setPosition({ top: r.bottom + GAP, right })
    }
    place()
    // The menu is fixed, so it closes when the page or the sidebar scrolls under it.
    const close = () => send('outside')
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  return (
    <RunMoreMenuView
      open={open}
      onToggle={() => send('toggle')}
      onRemove={() => {
        send('pick-remove')
        onRemove()
      }}
      runName={runName}
      triggerId={triggerId}
      {...(position ? { position } : {})}
      triggerRef={triggerRef}
      menuRef={menuRef}
    />
  )
}
