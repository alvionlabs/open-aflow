import { describe, expect, it } from 'vitest'
import { reduceMenu, runKey, type MenuEvent } from './menu-view.ts'

const run = (open: boolean, ...events: MenuEvent[]) => {
  let state = { open, focusTrigger: false }
  for (const e of events) state = reduceMenu(state.open, e)
  return state
}

describe('open and close', () => {
  it('the trigger toggles the menu', () => {
    expect(run(false, 'toggle').open).toBe(true)
    expect(run(false, 'toggle', 'toggle').open).toBe(false)
  })

  it('Escape closes it and returns focus to the trigger', () => {
    expect(run(true, 'escape')).toEqual({ open: false, focusTrigger: true })
  })

  it('a click outside closes it and returns focus to the trigger', () => {
    expect(run(true, 'outside')).toEqual({ open: false, focusTrigger: true })
  })

  it('Escape and outside clicks on a closed menu do nothing, and take no focus', () => {
    expect(run(false, 'escape')).toEqual({ open: false, focusTrigger: false })
    expect(run(false, 'outside')).toEqual({ open: false, focusTrigger: false })
  })

  it('picking a theme or pressing the switch keeps it open', () => {
    expect(run(true, 'pick-theme')).toEqual({ open: true, focusTrigger: false })
    expect(run(true, 'press-switch')).toEqual({ open: true, focusTrigger: false })
    expect(run(true, 'pick-theme', 'press-switch', 'pick-theme').open).toBe(true)
  })

  it('a change of the selected run closes it without moving focus', () => {
    expect(run(true, 'run-change')).toEqual({ open: false, focusTrigger: false })
    expect(run(false, 'run-change').open).toBe(false)
  })

  it('closing with the trigger does not move focus (it already holds it)', () => {
    expect(run(true, 'toggle')).toEqual({ open: false, focusTrigger: false })
  })

  it('runKey names the selected run, and is the same for the same run', () => {
    expect(runKey({ target: { repoId: 'r', run: 'a' }, on: true })).toBe(runKey({ target: { repoId: 'r', run: 'a' }, on: false }))
    expect(runKey({ target: { repoId: 'r', run: 'a' }, on: true })).not.toBe(runKey({ target: { repoId: 'r', run: 'b' }, on: true }))
    expect(runKey({ target: { repoId: 'r', run: 'a' }, on: true })).not.toBe(runKey({ target: { repoId: 'q', run: 'a' }, on: true }))
    expect(runKey(undefined)).toBe('')
  })
})

describe('Remove from the board', () => {
  it('picking Remove closes the menu without taking focus back: the confirm panel takes it', () => {
    expect(run(true, 'pick-remove')).toEqual({ open: false, focusTrigger: false })
  })
})
