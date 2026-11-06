import { describe, expect, it } from 'vitest'
import { moveOldKeys } from './old-storage-keys.ts'
import { SIDE_KEY } from './screens/runs/sidebar-width.ts'
import { TAB_KEY } from './screens/runs/tab-memory.ts'
import { THEME_KEY } from './theme/theme.ts'

const store = (init: Record<string, string>) => {
  const data = new Map(Object.entries(init))
  const writes: string[] = []
  return {
    data,
    writes,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void (writes.push(`set ${k}`), data.set(k, v)),
    removeItem: (k: string) => void (writes.push(`remove ${k}`), data.delete(k)),
  }
}

const OLD = { theme: 'pod-board-theme', tab: 'pod-board-tab', side: 'pod-board-sidebar-width' }

describe('moveOldKeys', () => {
  it('moves the theme, the open tab, and the sidebar width to the new keys, and removes the old ones', () => {
    const s = store({ [OLD.theme]: 'light', [OLD.tab]: 'log', [OLD.side]: '320', other: 'x' })
    moveOldKeys(s)
    expect(Object.fromEntries(s.data)).toEqual({ [THEME_KEY]: 'light', [TAB_KEY]: 'log', [SIDE_KEY]: '320', other: 'x' })
  })

  it('keeps a value already under the new key, and still removes the old one', () => {
    const s = store({ [OLD.theme]: 'light', [THEME_KEY]: 'system' })
    moveOldKeys(s)
    expect(Object.fromEntries(s.data)).toEqual({ [THEME_KEY]: 'system' })
  })

  it('moves once: a second run writes nothing', () => {
    const s = store({ [OLD.side]: '300' })
    moveOldKeys(s)
    const after = s.writes.length
    moveOldKeys(s)
    expect(s.writes).toHaveLength(after)
    expect(s.data.get(SIDE_KEY)).toBe('300')
  })

  it('writes nothing when no old key is stored', () => {
    const s = store({ [THEME_KEY]: 'dark' })
    moveOldKeys(s)
    expect(s.writes).toEqual([])
  })

  it('a storage that throws, or none, is ignored', () => {
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => {}, removeItem: () => {} }
    expect(() => moveOldKeys(throwing)).not.toThrow()
    expect(() => moveOldKeys(undefined)).not.toThrow()
    expect(() => moveOldKeys(null)).not.toThrow()
  })

  it('a refused write keeps the old key, so the next page load tries again', () => {
    const s = store({ [OLD.tab]: 'waiting' })
    s.setItem = () => { throw new Error('quota') }
    moveOldKeys(s)
    expect(s.data.get(OLD.tab)).toBe('waiting')
  })

  it('the new keys carry the new name', () => {
    expect([THEME_KEY, TAB_KEY, SIDE_KEY]).toEqual(['open-aflow-theme', 'open-aflow-tab', 'open-aflow-sidebar-width'])
  })
})

describe('the page start', () => {
  it('moves the old keys before it reads the theme', async () => {
    const { readFileSync } = await import('node:fs')
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
    const moved = main.indexOf('moveOldKeys(storage)')
    expect(moved).toBeGreaterThan(-1)
    expect(moved).toBeLessThan(main.indexOf('readChoice(storage)'))
  })
})
