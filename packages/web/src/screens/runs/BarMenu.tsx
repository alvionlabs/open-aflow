import type { RefObject } from 'react'
import { Icon } from '../../theme/icons.tsx'
import type { ChoiceStorage } from '../../theme/theme.ts'
import { AutoContinueSwitch } from './AutoContinueSwitch.tsx'
import { RemoveRepoItem, useMenu } from './menu-parts.tsx'
import { runKey } from './menu-view.ts'
import type { RunTarget } from './resume-flow.ts'
import { ThemeControl } from './ThemeControl.tsx'
import './menu.css'

type AutoContinue = { target: RunTarget; on: boolean }
/** The menu's last item: removes the selected run's repo from the board, after a confirm. */
type Remove = { onPick: () => void }

/** The ⋯ trigger's id: the remove confirm sends focus back to it when it closes. */
export const MENU_TRIGGER_ID = 'run-menu-trigger'

export type BarMenuViewProps = {
  open: boolean
  onToggle: () => void
  /** Called when a theme is picked or the switch is pressed; the menu stays open. */
  onThemePick?: () => void
  onSwitchPress?: () => void
  autoContinue?: AutoContinue
  portBase?: number
  remove?: Remove
  /** Where the theme is read from and saved; the page's local storage when not given. */
  storage?: ChoiceStorage
  triggerRef?: RefObject<HTMLButtonElement | null>
  menuRef?: RefObject<HTMLDivElement | null>
}

/** The trigger and, when open, the menu. */
export function BarMenuView({ open, onToggle, onThemePick, onSwitchPress, autoContinue, portBase, remove, storage, triggerRef, menuRef }: BarMenuViewProps) {
  return (
    <div className="bar-menu">
      <button ref={triggerRef} id={MENU_TRIGGER_ID} type="button" className="btn sm icon ghost" aria-label="Menu" aria-expanded={open} onClick={onToggle}>
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menuRef} className="menu bar-menu-panel" role="group" aria-label="Menu">
          {autoContinue && (
            <>
              <div className="mi">
                <AutoContinueSwitch target={autoContinue.target} on={autoContinue.on} onPress={onSwitchPress} />
                <span className="mi-note">this run</span>
              </div>
              <hr />
            </>
          )}
          <div className="mi mi-block">
            <ThemeControl storage={storage} onPick={onThemePick} />
          </div>
          {portBase !== undefined && (
            <div className="mi">
              <span>Ports</span>
              <span className="mi-note mono">{portBase}</span>
            </div>
          )}
          {remove && (
            <>
              <hr />
              <RemoveRepoItem onPick={remove.onPick} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The bar's ⋯ menu: the run's auto-continue switch, the theme, the run's port base, and Remove repo. */
export function BarMenu({ autoContinue, portBase, remove }: { autoContinue?: AutoContinue; portBase?: number; remove?: Remove }) {
  const { open, send, triggerRef, menuRef } = useMenu(runKey(autoContinue))
  return (
    <BarMenuView
      open={open}
      onToggle={() => send('toggle')}
      onThemePick={() => send('pick-theme')}
      onSwitchPress={() => send('press-switch')}
      autoContinue={autoContinue}
      portBase={portBase}
      {...(remove ? { remove: { onPick: () => (send('pick-remove'), remove.onPick()) } } : {})}
      triggerRef={triggerRef}
      menuRef={menuRef}
    />
  )
}
