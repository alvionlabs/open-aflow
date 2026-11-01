import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { Icon } from '../../theme/icons.tsx'
import { RemoveRepoItem, useMenu } from './menu-parts.tsx'
import { menuPosition } from './menu-position.ts'
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

/** A sidebar card's ⋯ menu. It opens fixed under its button (above it near the bottom), right edges aligned, inside the viewport. */
export function RunMoreMenu({ runName, triggerId, onRemove }: { runName: string; triggerId: string; onRemove: () => void }) {
  const { open, send, triggerRef, menuRef } = useMenu(triggerId)
  const [position, setPosition] = useState<CSSProperties>()

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      setPosition(menuPosition(r, menuRef.current?.offsetHeight ?? 0, { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    // The menu is fixed, so it follows its button when the page or the sidebar scrolls, or the window resizes.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
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
