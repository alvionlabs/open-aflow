// `window-state.json` in the shell data folder. Anything odd in it reads as the default, and a failed
// save costs only the window's place, so neither direction ever throws.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH } from './window-rules.ts'

export type Rect = { x: number; y: number; width: number; height: number }
export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean }

export const DEFAULT_STATE: WindowState = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false }

/** This much of a window must sit on one display, so the user can still grab it. */
const MIN_VISIBLE_WIDTH = 100
const MIN_VISIBLE_HEIGHT = 50
/** Above this, a number is damage, not a place. */
const LARGEST = 100_000

const isPlace = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LARGEST
const isSize = (v: unknown): v is number => isPlace(v) && v > 0

const overlap = (aStart: number, aSize: number, bStart: number, bSize: number) => Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart)

const onDisplay = (r: Rect, d: Rect) => overlap(r.x, r.width, d.x, d.width) >= MIN_VISIBLE_WIDTH && overlap(r.y, r.height, d.y, d.height) >= MIN_VISIBLE_HEIGHT

export function readWindowState(file: string, displays: Rect[]): WindowState {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return DEFAULT_STATE
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_STATE
  const { x, y, width, height, maximized } = raw as Record<string, unknown>
  if (!isPlace(x) || !isPlace(y) || !isSize(width) || !isSize(height)) return DEFAULT_STATE
  const rect: Rect = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(Math.round(width), MIN_WIDTH),
    height: Math.max(Math.round(height), MIN_HEIGHT),
  }
  if (!displays.some((d) => onDisplay(rect, d))) return DEFAULT_STATE
  return { ...rect, maximized: maximized === true }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(state))
    renameSync(temp, file)
  } catch {
    // The window just opens at its default next time.
  }
}
