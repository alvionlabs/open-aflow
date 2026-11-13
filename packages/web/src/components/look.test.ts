import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The shared modal's and the "what happened" list's own CSS: existing tokens only, text in --fg or --muted.

const here = dirname(fileURLToPath(import.meta.url))
const FILES = ['modal.css', 'stop-list.css'] as const

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const readCss = (name: string) => (existsSync(join(here, name)) ? stripComments(readFileSync(join(here, name), 'utf8')) : '')
const tokensCss = () => stripComments(readFileSync(join(here, '..', 'theme', 'tokens.css'), 'utf8'))

/** Body of the first `{ … }` block that follows `selector`, braces balanced. */
function blockAfter(css: string, selector: string): string {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`selector not found: ${selector}`)
  const open = selector.endsWith('{') ? at + selector.length - 1 : css.indexOf('{', at + selector.length)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`unclosed block: ${selector}`)
}

function customProps(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) out[m[1]!] = m[2]!.trim()
  return out
}

type Rule = { selectors: string[]; decls: [string, string][] }

/** Flat list of style rules, the ones inside `@media` and `@supports` included. */
function rules(css: string): Rule[] {
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
    if (prelude.startsWith('@media') || prelude.startsWith('@supports')) out.push(...rules(body))
    else if (!prelude.startsWith('@')) {
      const decls = [...body.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;}]+)/gi)].map((m) => [m[1]!.toLowerCase(), m[2]!.trim()] as [string, string])
      out.push({ selectors: prelude.split(',').map((s) => s.trim()), decls })
    }
    i = close + 1
  }
  return out
}

const light = () => customProps(blockAfter(tokensCss(), ':root {'))
const dark = () => customProps(blockAfter(tokensCss(), ':root[data-theme="dark"]'))

const NAMED = /\b(black|white|red|green|blue|gr[ae]y|silver|orange|yellow|purple|pink|navy|teal|maroon|olive|lime|aqua|fuchsia|brown|gold)\b/i
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const TEXT_COLOURS = new Set(['var(--fg)', 'var(--muted)', 'inherit', 'currentcolor'])

/** What breaks the tokens-only rule in one CSS text, as readable lines. */
function offences(css: string, tokens: Set<string>): string[] {
  const out: string[] = []
  for (const r of rules(css)) {
    const where = r.selectors.join(', ')
    for (const [prop, value] of r.decls) {
      if (prop.startsWith('--')) out.push(`${where}: declares ${prop} (no new tokens)`)
      if (LITERAL.test(value) || NAMED.test(value)) out.push(`${where}: ${prop}: ${value} (a colour literal)`)
      for (const m of value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) if (!tokens.has(m[1]!)) out.push(`${where}: ${m[1]} is not a token`)
      if (prop === 'color' && !TEXT_COLOURS.has(value.toLowerCase())) out.push(`${where}: color: ${value} (text is --fg or --muted)`)
      if (prop === 'font-family' && !/^var\(--(?:font|mono)\)$/.test(value)) out.push(`${where}: font-family: ${value}`)
      if (prop === 'font-size' && !/^var\(--size-[a-z0-9]+\)$/.test(value)) out.push(`${where}: font-size: ${value}`)
      if (prop === 'font' && (!/var\(--(?:font|mono)\)/.test(value) || !/var\(--size-[a-z0-9]+\)/.test(value))) out.push(`${where}: font: ${value}`)
    }
  }
  return out
}

/** Every text colour the files set, as token names. */
function textColours(css: string): Set<string> {
  const out = new Set<string>()
  for (const r of rules(css)) for (const [prop, value] of r.decls) {
    const m = prop === 'color' ? /^var\(--([a-z0-9-]+)\)$/.exec(value) : null
    if (m) out.add(m[1]!)
  }
  return out
}

/** The token a rule's `background` names, when it is exactly one token. */
function backgroundOf(css: string, selector: string): string | undefined {
  const r = rules(css).find((x) => x.selectors.includes(selector))
  const bg = r?.decls.find(([p]) => p === 'background' || p === 'background-color')?.[1]
  return bg && /^var\(--([a-z0-9-]+)\)$/.exec(bg)?.[1]
}

// ---- colour math (WCAG 2.x) ----
function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (!hex) throw new Error(`not a colour this test reads: ${value}`)
  return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as [number, number, number]
}
function luminance(value: string): number {
  const [r, g, b] = rgb(value).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('modal and list look', () => {
  it('tokens only', () => {
    const tokens = new Set(Object.keys(light()))
    expect(tokens.has('--surface')).toBe(true)

    // The detector catches what it is for, and lets token-only CSS through.
    const bad = [
      '.a { background: #0a0a0a }',
      '.a { box-shadow: 0 0 4px rgb(0 0 0 / 0.6) }',
      '.a::backdrop { background: black }',
      '.a { color: var(--ready) }',
      '.a { color: var(--danger) }',
      '.a { border-color: var(--accent) }',
      '.a { --dim: 0.6 }',
      '.a { font-family: Inter }',
      '.a { font-size: 13px }',
      '.a { font: 500 13px var(--mono) }',
      '@media (max-width: 480px) { .a { color: #fff } }',
    ]
    for (const css of bad) expect(offences(css, tokens), css).not.toEqual([])
    const good =
      '.a { background: var(--surface); color: var(--fg); border: 1px solid var(--border-strong); font: 500 var(--size-small) / 1.4 var(--mono) }' +
      '.b::before { background: var(--ready); } .c { color: var(--muted); background: color-mix(in srgb, var(--fg) 30%, transparent) }'
    expect(offences(good, tokens)).toEqual([])

    for (const name of FILES) {
      const css = readCss(name)
      expect(rules(css).length, `${name} has rules`).toBeGreaterThan(2)
      expect(offences(css, tokens), name).toEqual([])
    }
    // The panel sits on --surface; the list's dots are the done and needs-you colours.
    expect(backgroundOf(readCss('modal.css'), '.modal-panel')).toBe('surface')
    const list = readCss('stop-list.css')
    expect(list).toMatch(/var\(--ready\)/)
    expect(list).toMatch(/var\(--needs-you\)/)
  })

  it('text contrast', () => {
    const used = new Set<string>()
    for (const name of FILES) for (const c of textColours(readCss(name))) used.add(c)
    // Both files set their text, in --fg and --muted only.
    expect([...used].sort()).toEqual(['fg', 'muted'])
    // The text sits on the panel (--surface) or, for the list, on a card or the page (--surface or --bg).
    const grounds = ['surface', 'bg']
    for (const [theme, t] of [['light', light()], ['dark', dark()]] as const) {
      for (const text of used) for (const ground of grounds) {
        const ratio = contrast(t[`--${text}`]!, t[`--${ground}`]!)
        expect(ratio, `${theme} --${text} on --${ground} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
