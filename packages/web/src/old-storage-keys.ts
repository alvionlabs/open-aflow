// The browser keys from before the rename to Open AFlow, moved once at page start, so the theme, the open tab, and
// the sidebar width stay. Pure; main.tsx passes `localStorage`.

import { SIDE_KEY } from './screens/runs/sidebar-width.ts'
import { TAB_KEY } from './screens/runs/tab-memory.ts'
import { THEME_KEY } from './theme/theme.ts'

export type KeyStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const MOVES: readonly [old: string, key: string][] = [
  ['pod-board-theme', THEME_KEY],
  ['pod-board-tab', TAB_KEY],
  ['pod-board-sidebar-width', SIDE_KEY],
]

/**
 * For each old key that holds a value: copies it to the new key when that one is empty, then removes the old key.
 * A value under the new key wins. A storage that throws is ignored; a refused write keeps the old key for next time.
 */
export function moveOldKeys(storage: KeyStorage | null | undefined): void {
  if (!storage) return
  for (const [old, key] of MOVES) {
    try {
      const value = storage.getItem(old)
      if (value === null) continue
      if (storage.getItem(key) === null) storage.setItem(key, value)
      storage.removeItem(old)
    } catch {
      // Blocked or full storage: the page still works with the defaults.
    }
  }
}
