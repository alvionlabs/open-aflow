import type { RefObject } from 'react'
import { Icon } from '../../theme/icons.tsx'
import type { ChoiceStorage } from '../../theme/theme.ts'
import { ForgetRunItem, RemoveRepoItem, useMenu } from './menu-parts.tsx'
import { ThemeControl } from './ThemeControl.tsx'
import './menu.css'

/** The menu's last items, each after a confirm: Forget drops the selected run's claim, Remove its repo. */
type MenuAction = { onPick: () => void }

/** The ⋯ trigger's id: the remove confirm sends focus back to it when it closes. */
export const MENU_TRIGGER_ID = 'run-menu-trigger'

export type BarMenuViewProps = {
  open: boolean
  onToggle: () => void
  /** Called when a theme is picked; the menu stays open. */
  onThemePick?: () => void
  portBase?: number
  forget?: MenuAction
  remove?: MenuAction
  /** Where the theme is read from and saved; the page's local storage when not given. */
  storage?: ChoiceStorage
  triggerRef?: RefObject<HTMLButtonElement | null>
  menuRef?: RefObject<HTMLDivElement | null>
}

/** The trigger and, when open, the menu. */
export function BarMenuView({ open, onToggle, onThemePick, portBase, forget, remove, storage, triggerRef, menuRef }: BarMenuViewProps) {
  return (
    <div className="bar-menu">
      <button ref={triggerRef} id={MENU_TRIGGER_ID} type="button" className="btn sm icon ghost" aria-label="Menu" aria-expanded={open} onClick={onToggle}>
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menuRef} className="menu bar-menu-panel" role="group" aria-label="Menu">
          <div className="mi mi-block">
            <ThemeControl storage={storage} onPick={onThemePick} />
          </div>
          {portBase !== undefined && (
            <div className="mi">
              <span>Ports</span>
              <span className="mi-note mono">{portBase}</span>
            </div>
          )}
          {(forget || remove) && <hr />}
          {forget && <ForgetRunItem onPick={forget.onPick} />}
          {remove && <RemoveRepoItem onPick={remove.onPick} />}
        </div>
      )}
    </div>
  )
}

/**
 * The run header's ⋯ menu: the theme, the run's port base, Forget this run, and Remove repo. Auto-continue is a
 * button in the run header, not here. The screen keys the menu by run, so a new run gets a closed menu.
 */
export function BarMenu({ portBase, forget, remove }: { portBase?: number; forget?: MenuAction; remove?: MenuAction }) {
  const { open, send, triggerRef, menuRef } = useMenu('')
  return (
    <BarMenuView
      open={open}
      onToggle={() => send('toggle')}
      onThemePick={() => send('pick-theme')}
      portBase={portBase}
      {...(forget ? { forget: { onPick: () => (send('pick-remove'), forget.onPick()) } } : {})}
      {...(remove ? { remove: { onPick: () => (send('pick-remove'), remove.onPick()) } } : {})}
      triggerRef={triggerRef}
      menuRef={menuRef}
    />
  )
}
