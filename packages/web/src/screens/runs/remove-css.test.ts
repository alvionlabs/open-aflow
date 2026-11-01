import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]) => readFileSync(join(here, ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

type Rule = { selectors: string[]; body: string; media?: string }

/** Flat list of style rules; a rule inside `@media` carries its condition. */
function rules(css: string, media?: string): Rule[] {
  const out: Rule[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const prelude = css.slice(i, open).trim()
    let depth = 0
    let close = open
    for (; close < css.length; close++) {
      if (css[close] === '{') depth++
      else if (css[close] === '}' && --depth === 0) break
    }
    const body = css.slice(open + 1, close)
    if (prelude.startsWith('@media')) out.push(...rules(body, prelude.replace(/^@media\s*/, '').trim()))
    else if (!prelude.startsWith('@')) out.push({ selectors: prelude.split(',').map((s) => s.trim()), body, media })
    i = close + 1
  }
  return out
}

function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/gi)) out[m[1]!.toLowerCase()] = m[2]!.trim()
  return out
}

/** The merged declarations of every rule listing `sel`, where `media` matches. */
const style = (css: string, sel: string, media: (m?: string) => boolean = (m) => !m) =>
  Object.assign({}, ...rules(css).filter((r) => media(r.media) && r.selectors.includes(sel)).map((r) => decls(r.body))) as Record<string, string>

const base = () => read('..', '..', 'theme', 'base.css')
const menu = () => read('menu.css')
const runs = () => read('runs.css')

describe('danger style', () => {
  it('the danger button fills with --danger and writes in --danger-fg, in every state', () => {
    for (const sel of ['.btn.danger', '.btn.danger:hover', '.btn.danger:active']) {
      const d = style(base(), sel)
      expect(d.background, sel).toBe('var(--danger)')
      expect(d['border-color'], sel).toBe('var(--danger)')
      expect(d.color, sel).toBe('var(--danger-fg)')
    }
  })

  it('the Remove repo menu item writes in --danger', () => {
    expect(style(menu(), '.mi-danger').color).toBe('var(--danger)')
    expect(style(menu(), '.mi-danger:hover').color).toBe('var(--danger)')
  })
})

describe('sidebar ⋯ button', () => {
  it('is hidden until the card is hovered or holds focus, or its menu is open', () => {
    expect(style(runs(), '.run-more').opacity).toBe('0')
    for (const sel of ['.run-item:hover .run-more', '.run-item:focus-within .run-more', '.run-more[aria-expanded="true"]']) {
      expect(style(runs(), sel).opacity, sel).toBe('1')
    }
  })

  it('is at least 24 px, and always shown with a 44 px target on touch', () => {
    const d = style(runs(), '.run-more')
    expect(parseInt(d.width!, 10)).toBeGreaterThanOrEqual(24)
    expect(parseInt(d.height!, 10)).toBeGreaterThanOrEqual(24)
    const touch = (m?: string) => !!m && /\(\s*hover:\s*none\s*\)/.test(m)
    expect(style(runs(), '.run-more', touch).opacity).toBe('1')
    expect(parseInt(style(runs(), '.run-more::after', touch).width!, 10)).toBeGreaterThanOrEqual(44)
    expect(parseInt(style(runs(), '.run-more::after', touch).height!, 10)).toBeGreaterThanOrEqual(44)
  })
})
