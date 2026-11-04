import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const themeDir = join(here, '..', '..', 'theme')
const publicDir = join(here, '..', '..', '..', 'public')
const setupFile = join(here, 'setup.css')

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const theme = (name: string) => stripComments(readFileSync(join(themeDir, name), 'utf8'))

/** setup.css with no comments. A missing file fails here, on an assertion. */
function setupCss(): string {
  expect(existsSync(setupFile), 'setup.css exists').toBe(true)
  return stripComments(readFileSync(setupFile, 'utf8'))
}

type Rule = { selectors: string[]; body: string; media?: string }

/** Flat list of style rules; a rule inside a conditional at-rule carries its condition. */
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
    if (/^@(media|supports|container|layer)/.test(prelude)) out.push(...rules(body, prelude))
    else if (!prelude.startsWith('@')) out.push({ selectors: prelude.split(',').map((s) => s.trim()), body, media })
    i = close + 1
  }
  return out
}

type Decl = { selectors: string[]; prop: string; value: string }

/** Every declaration of every style rule, so a selector such as `#id` is never read as a value. */
function decls(css: string): Decl[] {
  return rules(css).flatMap(({ selectors, body }) =>
    [...body.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+)/gi)].map((m) => ({
      selectors,
      prop: m[1]!.toLowerCase(),
      value: m[2]!.trim(),
    })),
  )
}

function blockAfter(css: string, selector: string): string {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', at + selector.length - 1)
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

const varNames = (css: string) => [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!)

const COLOR_FUNCTION = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const COLOR_PROP =
  /^(?:color|caret-color|accent-color|fill|stroke|box-shadow|text-shadow|background(?:-color)?|outline(?:-color)?|text-decoration(?:-color)?|column-rule(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?)$/
/** The words a colour property may hold beside tokens. `transparent` and `currentColor` name no colour of their own. */
const NOT_A_COLOR = new Set(['none', 'solid', 'dashed', 'dotted', 'inherit', 'inset', 'underline', 'transparent', 'currentcolor', 'color-mix', 'in', 'srgb'])

/** Colour literals in declaration values: hex and colour functions anywhere, any other word (a named colour) in a colour property. */
function colorLiterals(css: string): string[] {
  return decls(css).flatMap(({ prop, value }) => {
    if (COLOR_FUNCTION.test(value)) return [`${prop}: ${value}`]
    if (!COLOR_PROP.test(prop)) return []
    const words = value
      .replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, ' ')
      .replace(/-?[\d.]+[a-z%]*/gi, ' ')
      .match(/[a-z-]+/gi)
    return (words ?? []).filter((w) => !NOT_A_COLOR.has(w.toLowerCase())).map((w) => `${prop}: ${w}`)
  })
}

/** Custom properties a stylesheet defines, inside any rule, and through `@property`. */
const ownTokens = (css: string) => [...css.matchAll(/@property\s+--[a-z0-9-]+|--[a-z0-9-]+(?=\s*:)/gi)].map((m) => m[0]!)

/** `color` and non-pseudo `background` values outside the text colours and surfaces that the contrast check proves. */
function unprovenColors(css: string): string[] {
  return decls(css).flatMap(({ selectors, prop, value }) => {
    const text = prop === 'color' && !/^var\(--(?:fg|muted)\)$|^inherit$/.test(value)
    const isDot = selectors.every((s) => s.includes('::'))
    const surface = /^background(?:-color)?$/.test(prop) && !isDot && !/^var\(--(?:bg|surface)\)$|^transparent$/.test(value)
    return text || surface ? [`${selectors.join(', ')} { ${prop}: ${value} }`] : []
  })
}

/** `font` and `font-family` values that could reach a family outside the tokens, and at-rules that could load one. */
function badFonts(css: string): string[] {
  const shorthand = /^(?:\d{3}\s+)?var\(--size-[a-z0-9]+\)(?:\s*\/\s*[\d.]+)?\s+var\(--(?:font|mono)\)$/
  const family = /^var\(--(?:font|mono)\)$/
  const values = decls(css).flatMap(({ prop, value }) => {
    if (prop === 'font-family' && !family.test(value) && value !== 'inherit') return [`${prop}: ${value}`]
    if (prop === 'font' && !shorthand.test(value) && value !== 'inherit') return [`${prop}: ${value}`]
    return []
  })
  return [...values, ...(css.match(/@font-face|@import|url\(/gi) ?? [])]
}

const fontValues = (css: string) => decls(css).filter((d) => d.prop === 'font' || d.prop === 'font-family')

const spacing = (css: string) => decls(css).filter((d) => /^(?:gap|row-gap|column-gap|grid-gap|padding|margin)(?:-|$)/.test(d.prop))

/** Gap, padding, and margin values that aren't 0, `auto` on a margin, or a multiple of 4 px. A value this can't read fails. */
function badSpacing(css: string): string[] {
  return spacing(css).flatMap(({ prop, value }) =>
    value
      .split(/\s+/)
      .filter((part) => {
        if (part === '0') return false
        if (part === 'auto' && prop.startsWith('margin')) return false
        const px = /^-?(\d+)px$/.exec(part)
        return !px || Number(px[1]) % 4 !== 0
      })
      .map((part) => `${prop}: ${part}`),
  )
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (!m) throw new Error(`not a colour this test reads: ${hex}`)
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const s = parseInt(m[1]!.slice(i, i + 2), 16) / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const themes = (): [string, Record<string, string>][] => {
  const tokens = theme('tokens.css')
  return [
    ['light', customProps(blockAfter(tokens, ':root {'))],
    ['dark, by the OS', customProps(blockAfter(blockAfter(tokens, '@media (prefers-color-scheme: dark)'), ':root:not([data-theme="light"])'))],
    ['dark, by choice', customProps(blockAfter(tokens, ':root[data-theme="dark"]'))],
  ]
}

describe('setup check look', () => {
  it('uses only existing tokens', () => {
    const css = setupCss()
    const defined = new Set(ownTokens(theme('tokens.css')))
    const used = varNames(css)
    expect(used.length, 'setup.css uses the tokens').toBeGreaterThan(0)
    expect(used.filter((name) => !defined.has(name))).toEqual([])
    expect(colorLiterals(css)).toEqual([])

    // The checks themselves.
    expect(varNames('.a { color: var(--nope); margin: var( --also-nope , 4px) }')).toEqual(['--nope', '--also-nope'])
    expect(defined.has('--dot'), 'base.css sets --dot on .status; it is no token').toBe(false)
    for (const bad of [
      '.a { color: #fff }',
      '.a { color: #ABCDEF }',
      '.a { background: rgb(0 0 0) }',
      '.a { box-shadow: 0 0 4px hsl(0 0% 0%) }',
      '.a { border: 1px solid red }',
      '.a { color: white }',
      '.a { color: var(--fg, red) }',
      '@media (min-width: 1px) { .a { outline-color: oklch(0 0 0) } }',
    ]) {
      expect(colorLiterals(bad), bad).not.toEqual([])
    }
    for (const fine of [
      '.a { color: var(--fg); border: 1px solid var(--border); background: transparent; }',
      '#id { color: var(--fg) }',
      '.a { background: color-mix(in srgb, var(--danger) 14%, transparent) }',
      '.a { text-decoration: underline; outline: 2px solid currentColor }',
    ]) {
      expect(colorLiterals(fine), fine).toEqual([])
    }
  })

  it('adds no tokens', () => {
    expect(ownTokens(setupCss())).toEqual([])

    // The check itself: in a rule, in a condition, and through @property. A use is no definition.
    expect(ownTokens('.a { --tone: var(--muted) }')).toEqual(['--tone'])
    expect(ownTokens('@media (min-width: 1px) { .a { --tone : 1px } }')).toEqual(['--tone'])
    expect(ownTokens('@property --tone { syntax: "*"; inherits: false }')).toHaveLength(1)
    expect(ownTokens('.a { color: var(--fg); gap: var(--size-small) }')).toEqual([])
  })

  it('text contrast', () => {
    const css = setupCss()
    expect(decls(css).some((d) => d.prop === 'color'), 'setup.css sets a text colour').toBe(true)
    // The ratios below speak for this screen only if its text and surfaces stay on these tokens.
    expect(unprovenColors(css)).toEqual([])

    for (const [name, tokens] of themes()) {
      for (const text of ['--fg', '--muted']) {
        for (const surface of ['--bg', '--surface']) {
          const ratio = contrast(tokens[text]!, tokens[surface]!)
          expect(ratio, `${name} ${text} on ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }

    // The check itself.
    expect(unprovenColors('.a { color: var(--faint) }')).toHaveLength(1)
    expect(unprovenColors('.a { background: var(--hover) }')).toHaveLength(1)
    expect(unprovenColors('.a { color: var(--muted); background: var(--surface) } .a::before { background: var(--blocked) }')).toEqual([])
  })

  it('self-hosted fonts', () => {
    const css = setupCss()
    expect(fontValues(css).length, 'setup.css sets its fonts through the tokens').toBeGreaterThan(0)
    expect(badFonts(css)).toEqual([])

    const sameSite = /^\/fonts\/[^/]+$/
    const faces = [...theme('fonts.css').matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!)
    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) {
      const sources = [...face.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!)
      expect(sources.length, 'each face has a source').toBeGreaterThan(0)
      for (const source of sources) {
        expect(source, 'loads from this site').toMatch(sameSite)
        expect(existsSync(join(publicDir, source)), `${source} exists`).toBe(true)
      }
    }

    // The checks themselves.
    expect(badFonts('.a { font-family: "Arial" }')).toHaveLength(1)
    expect(badFonts('.a { font: 400 14px / 1.4 Georgia, serif }')).toHaveLength(1)
    expect(badFonts('@font-face { font-family: "X"; src: url(https://example.com/x.woff2) }')).not.toEqual([])
    expect(badFonts('@import url("https://example.com/x.css");')).not.toEqual([])
    expect(badFonts('.a { font: 500 var(--size-small) / 1.4 var(--mono); font-family: var(--font) } .b { font: inherit }')).toEqual([])
    expect('//fonts.example.com/x.woff2').not.toMatch(sameSite)
  })

  it('follows DESIGN.md spacing and layout', () => {
    const css = setupCss()
    expect(spacing(css).length, 'setup.css sets its spacing').toBeGreaterThan(0)
    expect(badSpacing(css)).toEqual([])

    const value = (selector: string, prop: string) => {
      const rule = rules(css).find((r) => !r.media && r.selectors.includes(selector))
      expect(rule, `a rule for ${selector}`).toBeDefined()
      return decls(`x {${rule!.body}}`).find((d) => d.prop === prop)?.value
    }

    // The root: capped and centred, on a page with no sidebar.
    expect(value('.setup', 'max-width'), '.setup max-width').toMatch(/^\d+px$/)
    expect(value('.setup', 'margin-inline'), '.setup margin-inline').toBe('auto')

    // The status column comes first and has a fixed width, so the dots line up on one rail.
    expect(value('.setup-row', 'display'), '.setup-row display').toBe('grid')
    expect(value('.setup-row', 'grid-template-columns')?.split(/\s+/)[0], 'first column').toMatch(/^\d+px$/)

    // The checks themselves.
    for (const bad of [
      '.a { gap: 6px }',
      '.a { padding: 1rem }',
      '.a { margin: 8px 2px }',
      '.a { padding-inline: 4% }',
      '.a { gap: var(--x) }',
      '.a { padding: auto }',
      '@media (min-width: 1px) { .a { margin-top: -3px } }',
    ]) {
      expect(badSpacing(bad), bad).not.toEqual([])
    }
    expect(badSpacing('.a { gap: 8px; padding: 12px 16px; margin: 0 auto; margin-block: -4px 0; width: 3px; outline-offset: 2px }')).toEqual([])
  })
})
