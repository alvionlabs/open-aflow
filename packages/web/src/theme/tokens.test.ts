import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const themeDir = dirname(fileURLToPath(import.meta.url))
const srcDir = join(themeDir, '..')
const publicDir = join(themeDir, '..', '..', 'public')

const read = (name: string) => readFileSync(join(themeDir, name), 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Body of the first `{ … }` block that follows `selector`, braces balanced. */
function blockAfter(css: string, selector: string): string {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`selector not found: ${selector}`)
  // A selector written with its own `{` opens there; otherwise the next `{` does.
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
    if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
      out.push(...rules(body, prelude.replace(/^@\w+\s*/, '').trim()))
    } else if (!prelude.startsWith('@')) out.push({ selectors: prelude.split(',').map((s) => s.trim()), body, media })
    i = close + 1
  }
  return out
}

/** Declarations of a rule body as [property, value] pairs, custom properties included. */
function declList(body: string): [string, string][] {
  return [...body.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;}]+)/gi)].map((m) => [m[1]!.toLowerCase(), m[2]!.trim()])
}

/** Every `.css` file under packages/web/src, so CSS added by later slices is covered too. */
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return cssFiles(p)
    return name.endsWith('.css') ? [p] : []
  })
}

const tokensCss = () => stripComments(read('tokens.css'))
const light = () => customProps(blockAfter(tokensCss(), ':root {'))
const darkMedia = () =>
  customProps(blockAfter(blockAfter(tokensCss(), '@media (prefers-color-scheme: dark)'), ':root:not([data-theme="light"])'))
const darkAttr = () => customProps(blockAfter(tokensCss(), ':root[data-theme="dark"]'))

// ---- colour math (WCAG 2.x) ----
type Rgb = [number, number, number]

function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb
  throw new Error(`not a colour this test reads: ${value}`)
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const x = luminance(parseColor(a))
  const y = luminance(parseColor(b))
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// ---- the plan's ## Look palette, [dark, light] ----
const LOOK = {
  bg: ['#000000', '#ffffff'],
  surface: ['#0a0a0a', '#fafafa'],
  hover: ['#1a1a1a', '#f2f2f2'],
  border: ['#262626', '#eaeaea'],
  'border-strong': ['#3a3a3a', '#d4d4d4'],
  fg: ['#ededed', '#171717'],
  muted: ['#a1a1a1', '#666666'],
  faint: ['#6e6e6e', '#8f8f8f'],
  'primary-bg': ['#ededed', '#171717'],
  'primary-fg': ['#0a0a0a', '#ffffff'],
  focus: ['#52a8ff', '#0068d6'],
  blocked: ['#ff5f5f', '#d0262f'],
  'needs-you': ['#f5a623', '#b25d00'],
  running: ['#52a8ff', '#0068d6'],
  ready: ['#3ecf72', '#1a8a45'],
  idle: ['#8f8f8f', '#7d7d7d'],
} as const

/** Tokens that are never a text colour: `--faint` fails 4.5:1, status colours are for dots only. */
const NOT_TEXT = ['faint', 'blocked', 'needs-you', 'running', 'ready', 'idle']

/** Token names L1 retires. */
const OLD_TOKEN = /--(?:panel|panel-2|line|accent|ok|warn|bad|display|body)(?![\w-])|--[a-z0-9-]+-(?:soft|ink)(?![\w-])/gi

const themes = () => [
  ['dark', darkMedia()],
  ['light', light()],
] as const

describe('tokens', () => {
  it('palette tokens match the Look', () => {
    const l = light()
    const d = darkMedia()
    for (const [name, [dv, lv]] of Object.entries(LOOK)) {
      expect(d[`--${name}`]?.toLowerCase(), `dark --${name}`).toBe(dv)
      expect(l[`--${name}`]?.toLowerCase(), `light --${name}`).toBe(lv)
    }
    // Both dark selectors hold the same set, value for value.
    expect(darkAttr()).toEqual(d)
    // Every colour token has a dark value, and dark adds none of its own.
    const colours = (t: Record<string, string>) => Object.keys(t).filter((k) => /^(#|hsl\(|rgb\()/i.test(t[k]!)).sort()
    expect(colours(d), 'dark colour tokens').toEqual(colours(l))
    // Dark also flips native controls and scrollbars.
    for (const sel of [':root[data-theme="dark"]', '@media (prefers-color-scheme: dark)']) {
      expect(blockAfter(tokensCss(), sel)).toMatch(/color-scheme:\s*dark/)
    }
    expect(blockAfter(tokensCss(), ':root {')).toMatch(/color-scheme:\s*light/)
    // Geist for the UI, Geist Mono for paths, commands and numbers.
    expect(l['--font']).toMatch(/^"Geist",/)
    expect(l['--mono']).toMatch(/^"Geist Mono",/)
    // Size and radius tokens keep their names.
    for (const name of ['--size-micro', '--size-small', '--size-dense', '--size-body', '--radius-sm', '--radius-md', '--radius-lg']) {
      expect(l[name], name).toBeDefined()
    }
  })

  it('text contrast is at least 4.5 to 1', () => {
    for (const [theme, t] of themes()) {
      const pairs: [string, string][] = []
      for (const text of ['fg', 'muted']) for (const surface of ['bg', 'surface', 'hover']) pairs.push([text, surface])
      pairs.push(['primary-fg', 'primary-bg'])
      for (const [fg, bg] of pairs) {
        const a = t[`--${fg}`]
        const b = t[`--${bg}`]
        expect(a, `${theme} --${fg}`).toBeDefined()
        expect(b, `${theme} --${bg}`).toBeDefined()
        const ratio = contrast(a!, b!)
        expect(ratio, `${theme} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('danger text and the danger button reach 4.5 to 1, and the focus ring shows on the page', () => {
    for (const [theme, t] of themes()) {
      const danger = t['--danger']
      const dangerFg = t['--danger-fg']
      expect(danger, `${theme} --danger`).toBeDefined()
      expect(dangerFg, `${theme} --danger-fg`).toBeDefined()
      for (const surface of ['bg', 'surface', 'hover']) {
        const ratio = contrast(danger!, t[`--${surface}`]!)
        expect(ratio, `${theme} danger on ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(dangerFg!, danger!), `${theme} danger-fg on danger`).toBeGreaterThanOrEqual(4.5)
      // The ring sits 2 px outside the button, on the page, so it must stand out from the page.
      expect(contrast(t['--focus']!, t['--bg']!), `${theme} focus on bg`).toBeGreaterThanOrEqual(3)
    }
    // Dark's own selector holds the same danger values.
    expect(darkAttr()['--danger']).toBe(darkMedia()['--danger'])
    expect(darkAttr()['--danger-fg']).toBe(darkMedia()['--danger-fg'])
  })

  it('faint and status colors are never text', () => {
    // The guarded names are the theme's own, in both themes.
    for (const name of NOT_TEXT) {
      expect(light()[`--${name}`], `light --${name}`).toBeDefined()
      expect(darkMedia()[`--${name}`], `dark --${name}`).toBeDefined()
    }
    const banned = new RegExp(`var\\(\\s*--(?:${NOT_TEXT.join('|')})\\s*[,)]`, 'i')
    // The detector itself catches the cases it is for, and lets icons and dots through.
    const hits = (css: string) =>
      rules(stripComments(css)).flatMap((r) =>
        // An icon is drawn in currentColor; colouring an svg is not colouring text.
        r.selectors.every((s) => /(^|[\s>])svg$/.test(s))
          ? []
          : declList(r.body).filter(([p, v]) => p === 'color' && banned.test(v)).map(([, v]) => `${r.selectors.join(', ')} { color: ${v} }`),
      )
    expect(hits('.a { color: var(--faint) } .b { color: var(--ready); } .c { color: var(--idle, red) }')).toHaveLength(3)
    expect(hits('.a { background: var(--ready); color: var(--muted) } .b::before { background: var(--blocked) } .p svg { color: var(--ready) }')).toEqual([])

    const files = cssFiles(srcDir)
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) expect(hits(readFileSync(file, 'utf8')), relative(srcDir, file)).toEqual([])
  })

  it('screens use only the new tokens', () => {
    const files = cssFiles(srcDir)
    expect(files.map((f) => relative(srcDir, f).replace(/\\/g, '/'))).toEqual(
      expect.arrayContaining(['screens/board/board.css', 'screens/engineer/engineer.css', 'screens/runs/runs.css', 'theme/base.css']),
    )
    for (const file of files) {
      const found = stripComments(readFileSync(file, 'utf8')).match(OLD_TOKEN) ?? []
      expect(found, relative(srcDir, file)).toEqual([])
    }
    // The pattern itself.
    expect('var(--panel-2) var(--accent) var(--ok-soft) var(--bad-ink) var(--body)'.match(OLD_TOKEN)).toHaveLength(5)
    expect('var(--border-strong) var(--primary-bg) var(--ready) var(--font) var(--chip-dot)'.match(OLD_TOKEN)).toBeNull()
  })

  it('fonts are served from the app', () => {
    const fonts = stripComments(read('fonts.css'))
    const faces = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!)
    const declared = new Set<string>()
    for (const face of faces) {
      const family = /font-family:\s*"([^"]+)"/.exec(face)?.[1]
      const weight = /font-weight:\s*(\d+)/.exec(face)?.[1]
      const urls = [...face.matchAll(/url\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!)
      expect(urls.length, `${family} ${weight} has a url`).toBeGreaterThan(0)
      for (const url of urls) {
        expect(url.startsWith('/fonts/'), url).toBe(true)
        expect(url.endsWith('.woff2'), url).toBe(true)
        const file = join(publicDir, url)
        expect(existsSync(file), `${url} exists`).toBe(true)
        expect(readFileSync(file).subarray(0, 4).toString('latin1'), `${url} is woff2`).toBe('wOF2')
      }
      expect(face).toMatch(/font-display:\s*swap/)
      declared.add(`${family} ${weight}`)
    }
    expect([...declared].sort()).toEqual(['Geist 400', 'Geist 500', 'Geist 600', 'Geist Mono 400', 'Geist Mono 500'])
    // Each family ships its OFL license beside the font files.
    for (const family of ['geist', 'geist-mono']) {
      const license = join(publicDir, 'fonts', `${family}-OFL.txt`)
      expect(existsSync(license), license).toBe(true)
      expect(readFileSync(license, 'utf8')).toContain('SIL Open Font License')
    }
    // The old faces are gone: only Geist files are in public/fonts.
    for (const name of readdirSync(join(publicDir, 'fonts'))) expect(name, 'public/fonts').toMatch(/^geist-/)
    // No theme file reaches another host.
    for (const name of readdirSync(themeDir)) {
      if (name.endsWith('.test.ts') || !statSync(join(themeDir, name)).isFile()) continue
      expect(read(name), name).not.toMatch(/https?:\/\//i)
    }
    // index.css pulls in the rest.
    const index = stripComments(read('index.css'))
    for (const part of ['fonts.css', 'tokens.css', 'base.css']) expect(index).toContain(`@import './${part}'`)
  })

  it('type sizes', () => {
    const tokens = light()
    const toPx = (value: string): number => {
      const v = value.trim()
      const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(v)
      if (ref) {
        const target = tokens[ref[1]!]
        if (!target) throw new Error(`unknown size token ${ref[1]}`)
        return toPx(target)
      }
      const rem = /^([\d.]+)rem$/.exec(v)
      if (rem) return Number(rem[1]) * 16
      const px = /^([\d.]+)px$/.exec(v)
      if (px) return Number(px[1])
      throw new Error(`font size this test can't read: ${v}`)
    }
    // The size inside a `font:` shorthand is the token before the optional `/line-height`.
    const shorthandSize = (value: string): string => {
      const m = /(var\(--[a-z0-9-]+\)|[\d.]+(?:rem|px))(?:\s*\/|\s+(?:var\(--(?:font|mono)\)|"))/i.exec(value)
      if (!m) throw new Error(`font shorthand without a size: ${value}`)
      return m[1]!
    }

    const base = stripComments(read('base.css'))
    const bodySize = /font-size:\s*([^;]+);/.exec(blockAfter(base, 'body {'))?.[1]
    expect(bodySize, 'body font-size').toBeDefined()
    expect(toPx(bodySize!)).toBe(16)

    const sizes: [string, number][] = []
    for (const [name, value] of Object.entries(tokens)) if (name.startsWith('--size-')) sizes.push([name, toPx(value)])
    expect(sizes.length, 'size tokens').toBeGreaterThan(0)
    for (const file of ['tokens.css', 'base.css', 'fonts.css', 'index.css']) {
      const css = stripComments(read(file))
      for (const m of css.matchAll(/font-size:\s*([^;}]+)/g)) sizes.push([`${file} font-size ${m[1]}`, toPx(m[1]!)])
      for (const m of css.matchAll(/(?<![-\w])font:\s*([^;}]+)/g)) {
        if (/^\s*inherit\s*$/.test(m[1]!)) continue
        sizes.push([`${file} font ${m[1]}`, toPx(shorthandSize(m[1]!))])
      }
    }
    for (const [where, px] of sizes) expect(px, where).toBeGreaterThanOrEqual(12)
  })
})
