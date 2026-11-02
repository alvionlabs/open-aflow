import { describe, expect, it } from 'vitest'
import { focusOnArrival, opensHere, type OpenClick } from './open-focus.ts'

const click = (over: Partial<OpenClick> = {}): OpenClick => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over })

describe('opens here', () => {
  it('a plain primary click opens the link in this tab', () => {
    expect(opensHere(click())).toBe(true)
  })

  it('a modified, middle or prevented click does not', () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }, { ctrlKey: true, shiftKey: true }]) {
      expect(opensHere(click(over)), JSON.stringify(over)).toBe(false)
    }
  })
})

describe('focus on arrival', () => {
  it('focuses when the run shown is the one Open run went to', () => {
    expect(focusOnArrival('#/chess/ladder', '#/chess/ladder')).toBe(true)
  })

  it('never focuses with no Open run waiting', () => {
    expect(focusOnArrival(undefined, '#/chess/ladder')).toBe(false)
    expect(focusOnArrival(undefined, 'none')).toBe(false)
  })

  it('never focuses when another run opens first', () => {
    // A click that opened nowhere in this tab, then a sidebar pick or Back.
    expect(focusOnArrival('#/chess/ladder', '#/chess/other')).toBe(false)
    expect(focusOnArrival('#/chess/ladder', '#/chess')).toBe(false)
    expect(focusOnArrival('#/chess/ladder', 'none')).toBe(false)
  })
})
