import { describe, expect, it } from 'vitest'
import { menuPosition } from './menu-position.ts'

const view = { width: 1000, height: 360 }

describe('sidebar ⋯ menu position', () => {
  it('opens under its button, right edges aligned', () => {
    expect(menuPosition({ top: 100, bottom: 124, right: 240 }, 46, view)).toEqual({ top: 128, right: 760 })
  })

  it('flips above its button when it would run off the bottom', () => {
    expect(menuPosition({ top: 300, bottom: 324, right: 240 }, 46, view)).toEqual({ top: 300 - 4 - 46, right: 760 })
  })

  it('stays under when there is no room above either', () => {
    expect(menuPosition({ top: 30, bottom: 54, right: 240 }, 340, view)).toEqual({ top: 58, right: 760 })
  })

  it('keeps 8 px from the right edge of the viewport', () => {
    expect(menuPosition({ top: 100, bottom: 124, right: 998 }, 46, view).right).toBe(8)
  })
})
