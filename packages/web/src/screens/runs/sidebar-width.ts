// The sidebar's width, set by dragging its handle or with the keys, and remembered per browser.
// Pure; the screen passes `localStorage` and the pointer's position.

import type { TabStorage } from './tab-memory.ts'

export const SIDE_MIN = 200
export const SIDE_MAX = 400
export const SIDE_DEFAULT = 260
/** One Left or Right key press. */
export const SIDE_STEP = 16
export const SIDE_KEY = 'pod-board-sidebar-width'

/** Whole pixels from SIDE_MIN to SIDE_MAX; anything that isn't a finite number is the default. */
export function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDE_DEFAULT
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(n)))
}

/** The stored width, clamped. Nothing stored, a value that isn't a plain number, or a storage that throws: the default. */
export function readWidth(storage: TabStorage | null | undefined): number {
  try {
    const value = storage?.getItem(SIDE_KEY)?.trim()
    if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return SIDE_DEFAULT
    return clampWidth(Number(value))
  } catch {
    return SIDE_DEFAULT
  }
}

/** Stores the clamped width. A storage that refuses is ignored: the width still holds for this page view. */
export function saveWidth(storage: TabStorage | null | undefined, width: number): void {
  try {
    storage?.setItem(SIDE_KEY, String(clampWidth(width)))
  } catch {
    // Not remembered, nothing more.
  }
}

/** The width after a key press on the handle: Left and Right step, Home resets; undefined for any other key. */
export function keyWidth(width: number, key: string): number | undefined {
  if (key === 'ArrowLeft') return clampWidth(width - SIDE_STEP)
  if (key === 'ArrowRight') return clampWidth(width + SIDE_STEP)
  if (key === 'Home') return SIDE_DEFAULT
  return undefined
}

/** The width while dragging: the pointer's distance from the sidebar's left edge, clamped. */
export const dragWidth = (clientX: number, sideLeft: number): number => clampWidth(clientX - sideLeft)
