import type { RunTarget } from './resume-flow.ts'

/** What happens to the ⋯ menu. `outside` is a press anywhere but the trigger and the menu. */
export type MenuEvent = 'toggle' | 'escape' | 'outside' | 'pick-theme' | 'press-switch' | 'run-change' | 'pick-remove'

export type MenuNext = { open: boolean; focusTrigger: boolean }

/**
 * The menu's open state after an event. `focusTrigger` is true when focus must
 * go back to the trigger: Escape and an outside press close the menu from
 * wherever focus was. A closed menu ignores every event but `toggle`.
 */
export function reduceMenu(open: boolean, event: MenuEvent): MenuNext {
  switch (event) {
    case 'toggle':
      return { open: !open, focusTrigger: false }
    case 'escape':
    case 'outside':
      return { open: false, focusTrigger: open }
    case 'run-change':
    case 'pick-remove':
      // Remove repo and Forget this run open the shared confirm modal, which takes focus.
      return { open: false, focusTrigger: false }
    case 'pick-theme':
    case 'press-switch':
      return { open, focusTrigger: false }
  }
}

/** Names the selected run, so the menu can tell when it changed. Empty when no run has a switch. */
export function runKey(autoContinue: { target: RunTarget; on: boolean } | undefined): string {
  return autoContinue ? JSON.stringify([autoContinue.target.repoId, autoContinue.target.run]) : ''
}
