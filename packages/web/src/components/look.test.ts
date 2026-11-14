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
/** A field's own error is the one red text, in the text-safe red. */
const RED_TEXT = { selector: '.modal-field-error', colour: 'var(--danger)' }

/** What breaks the tokens-only rule in one CSS text, as readable lines. */
function offences(css: string, tokens: Set<string>): string[] {
  const out: string[] = []
  for (const r of rules(css)) {
    const where = r.selectors.join(', ')
    for (const [prop, value] of r.decls) {
      if (prop.startsWith('--')) out.push(`${where}: declares ${prop} (no new tokens)`)
      if (LITERAL.test(value) || NAMED.test(value)) out.push(`${where}: ${prop}: ${value} (a colour literal)`)
      for (const m of value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) if (!tokens.has(m[1]!)) out.push(`${where}: ${m[1]} is not a token`)
      const red = r.selectors.length === 1 && r.selectors[0] === RED_TEXT.selector && value === RED_TEXT.colour
      if (prop === 'color' && !red && !TEXT_COLOURS.has(value.toLowerCase())) out.push(`${where}: color: ${value} (text is --fg or --muted)`)
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

/** An sRGB `color-mix` of two hex colours, `pct` percent of `a`, as hex. */
function mix(a: string, pct: number, b: string): string {
  const [x, y] = [rgb(a), rgb(b)]
  return '#' + x.map((v, i) => Math.round((v * pct + y[i]! * (100 - pct)) / 100).toString(16).padStart(2, '0')).join('')
}

/** One rule's declarations, by selector, outside any media query. */
function declsOf(css: string, selector: string): Record<string, string> {
  const r = rules(css).find((x) => x.selectors.includes(selector))
  return Object.fromEntries(r?.decls ?? [])
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
      '.modal-field-error { color: var(--blocked) }',
      '.modal-field-error, .a { color: var(--danger) }',
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
      '.b::before { background: var(--ready); } .c { color: var(--muted); background: color-mix(in srgb, var(--fg) 30%, transparent) }' +
      '.modal-field-error { color: var(--danger) }'
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
    // Both files set their text in --fg and --muted, and a field's own error in --danger.
    expect([...used].sort()).toEqual(['danger', 'fg', 'muted'])
    // The text sits on the panel (--surface) or, for the list, on a card or the page (--surface or --bg).
    const grounds = ['surface', 'bg']
    for (const [theme, t] of [['light', light()], ['dark', dark()]] as const) {
      for (const text of used) for (const ground of grounds) {
        const ratio = contrast(t[`--${text}`]!, t[`--${ground}`]!)
        expect(ratio, `${theme} --${text} on --${ground} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('modal alert: a blocked border, a light blocked tint on the panel, --fg text at 4.5:1', () => {
    const css = readCss('modal.css')
    const box = declsOf(css, '.modal-alert')
    expect(box['border']).toBe('1px solid var(--blocked)')
    // Padding by DESIGN.md: multiples of 4, horizontal larger than vertical.
    expect(box['padding']).toBe('12px 16px')
    const tint = /^color-mix\(in srgb, var\(--blocked\) (\d+)%, var\(--surface\)\)$/.exec(box['background'] ?? '')
    expect(tint, `background: ${box['background']}`).not.toBeNull()
    const pct = Number(tint![1])
    expect(pct).toBeGreaterThanOrEqual(10)
    expect(pct).toBeLessThanOrEqual(14)
    // The icon is the status red; the message is --fg at the modal's dense size.
    expect(declsOf(css, '.modal-alert svg')['stroke']).toBe('var(--blocked)')
    const text = declsOf(css, '.modal-alert-text')
    expect(text['color']).toBe('var(--fg)')
    expect(text['font-size']).toBe('var(--size-dense)')
    // The 16 px icon sits centred on the first line of text: half the spare line height above it.
    const line = /^(\d+)px$/.exec(text['line-height'] ?? '')
    expect(line, `line-height: ${text['line-height']}`).not.toBeNull()
    expect(declsOf(css, '.modal-alert svg')['margin-top']).toBe(`${(Number(line![1]) - 16) / 2}px`)
    for (const [theme, t] of [['light', light()], ['dark', dark()]] as const) {
      const ground = mix(t['--blocked']!, pct, t['--surface']!)
      const ratio = contrast(t['--fg']!, ground)
      expect(ratio, `${theme} --fg on ${ground} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
    // The old red dot is gone: every modal error is the alert box.
    expect(css).not.toContain('.modal-error')
  })
})

// The Add repo modal's own rules live in runs.css (its field error is the shared `.modal-field-error`), scoped under `.add-repo-modal`, so Remove repo and Forget keep
// the shared modal's spacing.
describe('Add repo modal look', () => {
  const runsCss = () => stripComments(readFileSync(join(here, '..', 'screens', 'runs', 'runs.css'), 'utf8'))
  const px = (value: string | undefined, what: string) => {
    if (value === '0') return 0
    const m = /^(\d+)px$/.exec(value ?? '')
    expect(m, `${what}: ${value}`).not.toBeNull()
    return Number(m![1])
  }

  it('inline path error: red 14 px text on a 20 px line, the 16 px alert icon in --blocked centred on it, 4.5:1', () => {
    const css = readCss('modal.css')
    const text = declsOf(css, '.modal-field-error')
    expect(text['display']).toBe('flex')
    expect(text['align-items']).toBe('flex-start')
    expect(text['font-size']).toBe('var(--size-dense)')
    // --blocked is never text (tokens.test.ts); --danger is the text-safe red, the same hex in dark.
    expect(text['color']).toBe('var(--danger)')
    const line = px(text['line-height'], 'line-height')
    expect(px(text['gap'], 'gap') % 4).toBe(0)
    const icon = declsOf(css, '.modal-field-error svg')
    expect(icon['stroke']).toBe('var(--blocked)')
    expect(icon['flex']).toBe('none')
    expect(icon['margin-top']).toBe(`${(line - 16) / 2}px`)
    for (const [theme, t] of [['light', light()], ['dark', dark()]] as const) {
      const ratio = contrast(t['--danger']!, t['--surface']!)
      expect(ratio, `${theme} --danger on --surface = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the field and Browse… share a row that wraps before it overflows at 375 px', () => {
    const css = runsCss()
    const row = declsOf(css, '.add-repo-row')
    expect(row['display']).toBe('flex')
    expect(row['flex-wrap']).toBe('wrap')
    const gap = px(row['gap'], 'row gap')
    const field = declsOf(css, '.add-repo-row .input')
    const flex = /^1 1 (\d+)px$/.exec(field['flex'] ?? '')
    expect(flex, `flex: ${field['flex']}`).not.toBeNull()
    expect(field['min-width']).toBe('0')
    // At 375 px the panel is 343 px wide; less 24 px padding and a 1 px border a side, 293 px of content.
    // Browse… measures 118 px in the browser (16 px, the 16 px icon, 6 px, the label, 20 px); the row must fit.
    expect(Number(flex![1]) + gap + 118).toBeLessThanOrEqual(293)
  })

  it('spacing by DESIGN.md: multiples of 4, inside a group at or below the space between groups, and more air than the draft', () => {
    const css = runsCss()
    const panelGap = px(declsOf(css, '.add-repo-modal .modal-panel')['gap'], 'panel gap')
    const fieldGap = px(declsOf(css, '.add-repo-field')['gap'], 'field group gap')
    const alertTop = px(declsOf(css, '.add-repo-modal .modal-alert')['margin-top'], 'alert margin-top')
    const actionsTop = px(declsOf(css, '.add-repo-modal .modal-actions')['margin-top'], 'actions margin-top')
    const gaps = {
      'heading to field group': panelGap,
      'label to row, row to inline error': fieldGap,
      'field group to alert': panelGap + alertTop,
      'field group or alert to actions': panelGap + actionsTop,
    }
    for (const [what, v] of Object.entries(gaps)) expect(v % 4, `${what} = ${v}px`).toBe(0)
    expect(fieldGap).toBe(8)
    for (const [what, v] of Object.entries(gaps)) if (what !== 'label to row, row to inline error') expect(v, what).toBeGreaterThan(fieldGap)
    // The draft drew 8 px everywhere and 20 px above the actions (an 8 px gap and a 12 px margin).
    expect(gaps['field group or alert to actions']).toBeGreaterThanOrEqual(24)
    expect(gaps['heading to field group']).toBeGreaterThan(8)
  })
})

// An invalid field shows one red signal: its focus ring is the same red as its border, not the blue ring.
// Add repo's path field and the answer form's textarea both set aria-invalid on an `.input`.
describe('invalid field focus ring', () => {
  const baseCss = () => stripComments(readFileSync(join(here, '..', 'theme', 'base.css'), 'utf8'))
  const INVALID = '.input[aria-invalid="true"]:focus-visible'

  it('an invalid field rings in --blocked; valid fields, buttons, and the global ring stay --focus', () => {
    const css = baseCss()
    expect(declsOf(css, ':focus-visible')['outline']).toBe('2px solid var(--focus)')
    const valid = declsOf(css, '.input:focus-visible')
    expect(valid['outline']).toBe('2px solid var(--focus)')
    const invalid = declsOf(css, INVALID)
    // Same width as the field's own ring, so keyboard users still see where focus is; only the colour changes.
    expect(invalid['outline']).toBe('2px solid var(--blocked)')
    // The same offset too: the field's ring sits on its border (0), and the invalid rule leaves it alone.
    expect(valid['outline-offset']).toBe('0')
    expect(invalid['outline-offset']).toBeUndefined()
    // The border stays red on focus, whatever the order of the rules.
    expect(invalid['border-color']).toBe('var(--blocked)')
    // No other rule draws a red ring: buttons and the rest keep the blue one.
    const red = rules(css).filter((r) => r.decls.some(([p, v]) => p.startsWith('outline') && v.includes('--blocked')))
    expect(red.map((r) => r.selectors.join(', '))).toEqual([INVALID])
  })

  it('the red ring meets 3:1 against the surface and the page, light and dark (WCAG 1.4.11)', () => {
    // The ring's colour, as the rule names it.
    const ring = /var\((--[a-z0-9-]+)\)/.exec(declsOf(baseCss(), INVALID)['outline'] ?? '')?.[1]
    expect(ring, 'the invalid ring names a token').toBe('--blocked')
    // Both fields sit on --surface (the modal panel, the in-place form); --bg covers a field on the page.
    for (const [theme, t] of [['light', light()], ['dark', dark()]] as const) {
      for (const ground of ['surface', 'bg']) {
        const ratio = contrast(t[ring!]!, t[`--${ground}`]!)
        expect(ratio, `${theme} ${ring} on --${ground} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
