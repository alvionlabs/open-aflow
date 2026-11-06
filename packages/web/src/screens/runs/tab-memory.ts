// The one open tab under the Next step card (Waiting or Log), remembered per browser, not per run.
// Nothing stored means every tab is closed. Pure; the screen passes `localStorage`.

import type { View } from '../../selection.ts'

export type Tab = 'waiting' | 'log'

/** The part of `Storage` the tab memory needs, so tests can pass a plain object. */
export type TabStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const TAB_KEY = 'open-aflow-tab'

// A `plan` stored before the flow replaced the Plan tab is unknown now, so it reads as closed.
const TABS: readonly string[] = ['waiting', 'log'] satisfies Tab[]

const isTab = (value: unknown): value is Tab => typeof value === 'string' && TABS.includes(value)

/** The stored tab; anything missing, unknown, or unreadable reads as closed. */
export function readTab(storage: TabStorage | null | undefined): Tab | undefined {
  try {
    const value = storage?.getItem(TAB_KEY)
    return isTab(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Stores the open tab; `undefined` (every tab closed) removes the key. A storage that refuses is ignored. */
export function saveTab(storage: TabStorage | null | undefined, tab: Tab | undefined): void {
  try {
    if (tab === undefined) storage?.removeItem(TAB_KEY)
    else storage?.setItem(TAB_KEY, tab)
  } catch {
    // The tab still opens for this page view; it just isn't remembered.
  }
}

/** Clicking the open tab closes it; any other click opens the clicked tab. */
export const toggleTab = (open: Tab | undefined, clicked: Tab): Tab | undefined => (open === clicked ? undefined : clicked)

/** The tab to show: the stored one, except an engineer's view always shows Log (the caller doesn't save it). */
export function shownTab(stored: Tab | undefined, at: { view: View }): Tab | undefined {
  return at.view === 'agent' ? 'log' : stored
}
