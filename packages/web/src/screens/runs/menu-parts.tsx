// What the run header's ⋯ menu and each sidebar card's ⋯ menu share: the open and close
// rules (Escape and an outside press close it and give focus back to the trigger) and the
// danger Remove repo item.

import { useEffect, useRef, useState } from 'react'
import { reduceMenu, type MenuEvent } from './menu-view.ts'
import { REMOVE_ITEM } from './remove-flow.ts'

/** A ⋯ menu's state. A change of `resetKey` (the selected run) closes it. */
export function useMenu(resetKey: string) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const send = (event: MenuEvent) => {
    const next = reduceMenu(open, event)
    setOpen(next.open)
    if (next.focusTrigger) triggerRef.current?.focus()
  }

  const lastKey = useRef(resetKey)
  useEffect(() => {
    if (lastKey.current === resetKey) return
    lastKey.current = resetKey
    send('run-change')
  }, [resetKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') send('escape')
    }
    const onPress = (e: PointerEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) send('outside')
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress)
    }
  }, [open])

  return { open, send, triggerRef, menuRef }
}

/** The menu's danger item. Picking it opens the remove confirm. */
export function RemoveRepoItem({ onPick }: { onPick: () => void }) {
  return (
    <button type="button" className="mi mi-action mi-danger" onClick={onPick}>
      {REMOVE_ITEM}
    </button>
  )
}
