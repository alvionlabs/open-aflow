import { describe, expect, it } from 'vitest'
import type { TabStorage } from './tab-memory.ts'
import { SIDE_DEFAULT, SIDE_KEY, SIDE_MAX, SIDE_MIN, SIDE_STEP, clampWidth, dragWidth, keyWidth, readWidth, saveWidth } from './sidebar-width.ts'

/** A store keyed like localStorage; `broken` throws on every call, as a locked-down browser can. */
function store(init: Record<string, string> = {}, broken = false): TabStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init))
  const guard = () => {
    if (broken) throw new Error('SecurityError')
  }
  return {
    data,
    getItem: (k) => (guard(), data.get(k) ?? null),
    setItem: (k, v) => (guard(), void data.set(k, v)),
    removeItem: (k) => (guard(), void data.delete(k)),
  }
}

describe('sidebar width', () => {
  it('is 200 to 400 px, 260 by default, in steps on the 4 px scale', () => {
    expect([SIDE_MIN, SIDE_DEFAULT, SIDE_MAX]).toEqual([200, 260, 400])
    expect(SIDE_STEP % 4).toBe(0)
    expect(SIDE_STEP).toBeGreaterThan(0)
  })

  it('clamps to the range and rounds to whole pixels; a value that is not a number is the default', () => {
    expect(clampWidth(260)).toBe(260)
    expect(clampWidth(199)).toBe(200)
    expect(clampWidth(-50)).toBe(200)
    expect(clampWidth(401)).toBe(400)
    expect(clampWidth(300.6)).toBe(301)
    expect(clampWidth(Number.NaN)).toBe(260)
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(260)
  })

  it('reads the stored width, clamped; nothing, junk, or a storage that throws reads as the default', () => {
    expect(readWidth(store())).toBe(260)
    expect(readWidth(store({ [SIDE_KEY]: '320' }))).toBe(320)
    expect(readWidth(store({ [SIDE_KEY]: '9000' }))).toBe(400)
    expect(readWidth(store({ [SIDE_KEY]: '12' }))).toBe(200)
    expect(readWidth(store({ [SIDE_KEY]: '-300' }))).toBe(200)
    for (const junk of ['', ' ', 'wide', '300px', 'NaN', 'Infinity', '1e9x', '{}']) expect(readWidth(store({ [SIDE_KEY]: junk })), junk).toBe(260)
    expect(readWidth(store({}, true))).toBe(260)
    expect(readWidth(undefined)).toBe(260)
  })

  it('saves the clamped width under its own key; a storage that throws is ignored', () => {
    const s = store({ 'pod-board-tab': 'log' })
    saveWidth(s, 333)
    expect(s.data.get(SIDE_KEY)).toBe('333')
    saveWidth(s, 9000)
    expect(s.data.get(SIDE_KEY)).toBe('400')
    // The tab memory's key is left alone.
    expect(s.data.get('pod-board-tab')).toBe('log')
    expect(() => saveWidth(store({}, true), 300)).not.toThrow()
    expect(() => saveWidth(undefined, 300)).not.toThrow()
  })

  it('keys: Left and Right step and stop at the ends; Home resets; any other key does nothing', () => {
    expect(keyWidth(260, 'ArrowRight')).toBe(260 + SIDE_STEP)
    expect(keyWidth(260, 'ArrowLeft')).toBe(260 - SIDE_STEP)
    expect(keyWidth(SIDE_MAX, 'ArrowRight')).toBe(SIDE_MAX)
    expect(keyWidth(SIDE_MAX - 1, 'ArrowRight')).toBe(SIDE_MAX)
    expect(keyWidth(SIDE_MIN, 'ArrowLeft')).toBe(SIDE_MIN)
    expect(keyWidth(SIDE_MIN + 1, 'ArrowLeft')).toBe(SIDE_MIN)
    expect(keyWidth(352, 'Home')).toBe(SIDE_DEFAULT)
    for (const k of ['ArrowUp', 'ArrowDown', 'End', 'Enter', ' ', 'Tab', 'a']) expect(keyWidth(300, k), k).toBeUndefined()
  })

  it('drag: the pointer’s distance from the sidebar’s left edge, clamped', () => {
    expect(dragWidth(300, 0)).toBe(300)
    // The sidebar's left edge is where the page starts, but the math doesn't assume it.
    expect(dragWidth(330, 30)).toBe(300)
    expect(dragWidth(50, 0)).toBe(SIDE_MIN)
    expect(dragWidth(5000, 0)).toBe(SIDE_MAX)
    expect(dragWidth(-20, 0)).toBe(SIDE_MIN)
    expect(dragWidth(280.4, 0)).toBe(280)
  })
})
