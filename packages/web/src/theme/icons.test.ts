import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Icon, ICON_NAMES, type IconName } from './icons.tsx'

const NAMES: IconName[] = ['plus', 'more', 'check', 'chevron-right', 'chevron-down', 'arrow-up', 'arrow-right', 'folder', 'close', 'dot', 'circle', 'alert', 'blocked', 'fast-forward', 'pause']

const render = (name: IconName) => renderToStaticMarkup(createElement(Icon, { name }))

/** Attributes of the outer `<svg>` tag. */
function svgAttrs(markup: string): Record<string, string> {
  const tag = /^<svg\b([^>]*)>/.exec(markup)
  expect(tag, `starts with <svg>: ${markup}`).not.toBeNull()
  return Object.fromEntries([...tag![1]!.matchAll(/([a-z-]+)="([^"]*)"/gi)].map((m) => [m[1]!, m[2]!]))
}

describe('icons', () => {
  it('icons are 16 px SVGs', () => {
    expect([...ICON_NAMES].sort()).toEqual([...NAMES].sort())
    const seen = new Set<string>()
    for (const name of NAMES) {
      const markup = render(name)
      const a = svgAttrs(markup)
      expect(a['width'], `${name} width`).toBe('16')
      expect(a['height'], `${name} height`).toBe('16')
      expect(a['viewBox'], `${name} viewBox`).toBe('0 0 16 16')
      // Decorative: the button's label or aria-label names it.
      expect(a['aria-hidden'], `${name} aria-hidden`).toBe('true')
      expect(a['focusable'], `${name} focusable`).toBe('false')
      // It draws in the text colour, and a stroked icon uses a 1.5 px line.
      const strokes = [...markup.matchAll(/\sstroke="([^"]*)"/g)].map((m) => m[1]!).filter((v) => v !== 'none')
      const fills = [...markup.matchAll(/\sfill="([^"]*)"/g)].map((m) => m[1]!).filter((v) => v !== 'none')
      expect(strokes.length + fills.length, `${name} paints something`).toBeGreaterThan(0)
      for (const v of [...strokes, ...fills]) expect(v, `${name} paint`).toBe('currentColor')
      const widths = [...markup.matchAll(/\sstroke-width="([^"]*)"/g)].map((m) => m[1]!)
      if (strokes.length > 0) {
        expect(widths.length, `${name} has a stroke width`).toBeGreaterThan(0)
        for (const w of widths) expect(w, `${name} stroke-width`).toBe('1.5')
      }
      // Shapes only: no text glyph inside.
      expect(markup, name).not.toMatch(/<text\b/)
      expect(markup.replace(/<[^>]*>/g, ''), `${name} has no text`).toBe('')
      seen.add(markup)
    }
    // Each name draws its own shape.
    expect(seen.size).toBe(NAMES.length)
  })
})

describe('the Auto-continue icons', () => {
  const paths = (name: IconName) => [...render(name).matchAll(/<path d="([^"]*)"/g)].map((m) => m[1])
  it('fast-forward is two right-pointing triangles, as drawn in round 3', () => {
    expect(paths('fast-forward')).toEqual(['M2 3.5l5.5 4.5L2 12.5zM8.5 3.5L14 8l-5.5 4.5z'])
  })
  it('pause is two vertical bars, as drawn in round 3', () => {
    expect(paths('pause')).toEqual(['M5.5 3.5v9M10.5 3.5v9'])
  })
})

describe('the plus fills its box', () => {
  it('spans 3 to 13 on both axes, so it reads as large as a 14 px label', () => {
    const markup = renderToStaticMarkup(createElement(Icon, { name: 'plus' }))
    const d = /<path d="([^"]*)"/.exec(markup)?.[1] ?? ''
    const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
    expect(d).toMatch(/^M8 3v10M3 8h10$/)
    expect(Math.min(...nums)).toBe(3)
  })
})
