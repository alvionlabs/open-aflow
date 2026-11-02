import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunSummary } from '@pod-board/model'
import type { Elsewhere } from './elsewhere.ts'
import type { OpenClick } from './open-focus.ts'
import type { NextItem } from './next-step.ts'
import { UrgentBanner } from './UrgentBanner.tsx'

const run: RunSummary = { repoId: 'chess', repo: 'chess-web', plan: 'sparring-ladder', where: 'wave 3', state: 'blocked' }
const LINE = '- `[2026-10-19 · BLOCKED · orchestrator → human · plan: sparring-ladder]` Gate 1: T1 is blocked. **Resolution:** pending'
const item: NextItem = {
  key: `entry:${LINE}`,
  tier: 'blocked',
  status: 'blocked',
  title: 'Autopilot stopped: a slice is blocked',
  detail: 'The run is stopped until you answer.',
  action: { kind: 'answer', repoId: 'chess', line: LINE },
}
const at = (over: Partial<Elsewhere> = {}): Elsewhere => ({ run, item, name: 'Sparring ladder', repo: 'chess-web', more: 0, href: '#/chess/sparring-ladder', ...over })
const html = (e: Elsewhere) => renderToStaticMarkup(createElement(UrgentBanner, { at: e }))
const text = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
/** The "Open run" link's own markup. */
function openOf(h: string): string {
  const m = /<a [^>]*>[\s\S]*?<\/a>/.exec(h)
  expect(m, 'the Open run link').not.toBeNull()
  return m![0]
}

/** The first <a> element in a rendered tree. */
function linkOf(node: ReactNode): ReactElement {
  const walk = (n: ReactNode): ReactElement | undefined => {
    if (Array.isArray(n)) {
      for (const c of n) {
        const f = walk(c)
        if (f) return f
      }
      return undefined
    }
    if (!isValidElement(n)) return undefined
    if (n.type === 'a') return n
    return walk((n.props as { children?: ReactNode }).children)
  }
  const found = walk(node)
  expect(found, 'the Open run link').toBeDefined()
  return found!
}

describe('urgent banner', () => {
  it('renders the item, its run and the count', () => {
    const h = html(at({ more: 2 }))
    expect(h).toMatch(/^<div class="urgent">/)
    expect(h).toMatch(/<span class="status s-bad">Blocked<\/span>/)
    expect(text(h)).toBe('Blocked Autopilot stopped: a slice is blocked · chess-web · Sparring ladder +2 more Open run')
    expect(h).toMatch(/class="urgent-title">Autopilot stopped: a slice is blocked</)
    const whereOf = (x: string) => text(/class="urgent-where muted">([\s\S]*?)<\/span>(?=<\/span> <span class="urgent-more|<\/span><a )/.exec(x)?.[1] ?? '')
    expect(whereOf(h)).toBe('· chess-web · Sparring ladder')
    // The repo in mono, as the Look says.
    expect(h).toMatch(/<span class="urgent-repo">chess-web<\/span>/)
    expect(h).toMatch(/class="urgent-more">\+2 more</)
    // No count at 0.
    const none = html(at())
    expect(none).not.toMatch(/urgent-more|more</)
    expect(text(none)).toBe('Blocked Autopilot stopped: a slice is blocked · chess-web · Sparring ladder Open run')
    // A repo row: its name only.
    const row = html(at({ name: 'chess-web', repo: undefined }))
    expect(whereOf(row)).toBe('· chess-web')
    expect(row).not.toMatch(/urgent-repo/)
    // Other statuses take their own class.
    expect(html(at({ item: { ...item, tier: 'merge', status: 'needs-you', title: 'Merge PR #78' } }))).toMatch(/<span class="status s-you">Needs you<\/span>/)
    expect(html(at({ item: { ...item, tier: 'reply', status: 'ready', title: 'Send continue' } }))).toMatch(/<span class="status s-ok">Ready<\/span>/)
    // A title link reads as text only: the one link is Open run.
    const linked = html(at({ item: { ...item, title: 'Autopilot held PR #80 for you to merge', titleLink: { text: 'PR #80', href: 'https://github.com/o/r/pull/80' } } }))
    expect(linked.match(/<a /g)).toHaveLength(1)
    expect(linked).not.toMatch(/github\.com/)
    expect(text(linked)).toMatch(/Autopilot held PR #80 for you to merge/)
  })

  it('stacks one layer for one other item, two for two or more, none for none', () => {
    const layersOf = (more: number) => [...html(at({ more })).matchAll(/<span class="urgent-layer urgent-layer-(\d)"([^>]*)>/g)]
    expect(layersOf(0).map((m) => m[1])).toEqual([])
    expect(layersOf(1).map((m) => m[1])).toEqual(['1'])
    expect(layersOf(2).map((m) => m[1])).toEqual(['1', '2'])
    expect(layersOf(5).map((m) => m[1])).toEqual(['1', '2'])
    // Decoration only: hidden from screen readers and empty, so the status region's text doesn't change.
    for (const m of layersOf(5)) expect(m[2]).toMatch(/aria-hidden="true"/)
    expect(html(at({ more: 5 }))).toMatch(/<span class="urgent-layer urgent-layer-2" aria-hidden="true"><\/span>/)
    // The root stays exactly class="urgent": the tones and runs-screen.test.ts read it.
    for (const more of [0, 1, 2, 5]) expect(html(at({ more }))).toMatch(/^<div class="urgent">/)
    // No other item: nothing is added to the markup.
    expect(html(at())).not.toMatch(/urgent-layer/)
  })

  it('the count is a pill right before open run, and stays in the status text', () => {
    const h = html(at({ more: 99 }))
    // A child of the banner, not of the text, immediately before the link.
    expect(h).toMatch(/Sparring ladder<\/span><\/span> <span class="urgent-more">\+99 more<\/span><a [^>]*urgent-open/)
    // A real space, so a screen reader doesn't read "Sparring ladder+99 more".
    expect(h.replace(/<[^>]*>/g, '')).toBe('BlockedAutopilot stopped: a slice is blocked · chess-web · Sparring ladder +99 moreOpen run')
    // Not muted: the pill's text is --fg.
    expect(h).not.toMatch(/urgent-more[^"]*muted/)
  })

  it('tints by the item status: blocked, needs you and ready only', () => {
    // Rendered status class to CSS tone. The root stays exactly class="urgent" (runs-screen.test.ts pins it).
    const toneOf = (status: NextItem['status']) => {
      const cls = /^<div class="urgent"><span class="status (s-[a-z]+)"/.exec(html(at({ item: { ...item, status } })))?.[1]
      expect(cls, status).toBeDefined()
      return styleOf(`.urgent:has(> .status.${cls})`, desktop)['--tone']
    }
    expect(toneOf('blocked')).toBe('var(--blocked)')
    expect(toneOf('needs-you')).toBe('var(--needs-you)')
    expect(toneOf('ready')).toBe('var(--ready)')
    // Any other status: the plain box, no tone.
    expect(toneOf('running')).toBeUndefined()
    expect(toneOf('idle')).toBeUndefined()
  })

  it('open run is a named quiet text link', () => {
    const a = openOf(html(at()))
    expect(a).toMatch(/href="#\/chess\/sparring-ladder"/)
    expect(a).toMatch(/aria-label="Open run Sparring ladder"/)
    // A text button: quiet, so no box until hover.
    expect(a).toMatch(/class="btn sm quiet trail urgent-open"/)
    expect(a).not.toMatch(/primary/)
    // The shared arrow-right icon, after the label.
    expect(a).toMatch(/>Open run<svg[^>]*aria-hidden="true"[^>]*><path d="M3 8h9.5M8 3.5L12.5 8 8 12.5"/)
    expect(text(a)).toBe('Open run')
    expect(a).not.toMatch(/[→›»↗+]|&gt;/)
  })

  it('open run reports its target only for a click that opens in this tab', () => {
    const opened: unknown[] = []
    const a = linkOf(UrgentBanner({ at: at(), onOpen: (href) => opened.push(href) }))
    const onClick = (a.props as { onClick: (e: OpenClick) => void }).onClick
    const click = (over: Partial<OpenClick> = {}): OpenClick => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over })
    // New tab, new window, download, middle click, or a click another handler took: this tab stays.
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) onClick(click(over))
    expect(opened).toEqual([])
    onClick(click())
    expect(opened).toEqual(['#/chess/sparring-ladder'])
    // No onOpen: a click still works.
    const bare = linkOf(UrgentBanner({ at: at() }))
    expect(() => (bare.props as { onClick: (e: OpenClick) => void }).onClick(click())).not.toThrow()
  })

  it('navigation only', () => {
    for (const e of [at(), at({ more: 3 }), at({ item: { ...item, tier: 'merge', status: 'needs-you', title: 'Merge PR #78', action: { kind: 'merge', repoId: 'chess', number: 78 } } })]) {
      const h = html(e)
      expect(h).not.toMatch(/<button|<form|<input|<textarea/)
      expect(h.match(/<a /g)).toHaveLength(1)
      const labels = [...h.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])
      expect(labels).toEqual(['Open run Sparring ladder'])
      // The item's own title may say Merge; nothing else names an action.
      expect(text(h.replace(/<span class="urgent-title">[\s\S]*?<\/span>/, ''))).not.toMatch(/\b(Answer|Merge|Close|Keep|Continue|Go|Copy|Dismiss)\b/)
      expect(h).not.toMatch(/name="close"|M4 4l8 8/)
    }
  })
})

// The banner's CSS, read as rules.
const here = dirname(fileURLToPath(import.meta.url))
type Rule = { selectors: string[]; body: string; media?: string }
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
    if (/^@(media|container)/.test(prelude)) out.push(...rules(body, prelude.trim()))
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
const CSS = readFileSync(join(here, 'urgent-banner.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const all = rules(CSS)
const styleOf = (sel: string, match: (media?: string) => boolean) =>
  Object.assign({}, ...all.filter((r) => match(r.media) && r.selectors.includes(sel)).map((r) => decls(r.body))) as Record<string, string>
const desktop = (m?: string) => m === undefined
/** The banner's slot is the container: the switch follows the banner's own width, not the viewport's. */
const stacked = (m?: string) => m === '@container urgent (max-width: 620px)'
const stackedPlain = (m?: string) => m === '@container urgent (max-width: 520px)'
/** The banner with a count: only it has the 620 and 760 px switches. */
const COUNTED = '.urgent:has(> .urgent-more)'
const noRepo = (m?: string) => m === '@container urgent (max-width: 760px)'
const TOKENS = readFileSync(join(here, '../../theme/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const tokensOf = (sel: string) => Object.assign({}, ...rules(TOKENS).filter((r) => r.media === undefined && r.selectors.includes(sel)).map((r) => decls(r.body))) as Record<string, string>
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const THEMES: [string, Record<string, string>][] = [
  ['light', tokensOf(':root')],
  ['dark', tokensOf(':root[data-theme="dark"]')],
]
/** The WCAG ratio of two declared CSS values, resolved through a theme's tokens with --tone as `tone`. */
function ratio(tokens: Record<string, string>, tone: string, fore: string | undefined, back: string | undefined, where: string): number {
  const paint = (value: string | undefined): number[] => {
    const name = (v: string) => (v === '--tone' ? `--${tone}` : v)
    const plain = /^var\((--[a-z-]+)\)$/.exec(value ?? '')
    if (plain) return rgb(tokens[name(plain[1]!)]!)
    const mix = /^color-mix\(in srgb, var\((--[a-z-]+)\) (\d+)%, var\((--[a-z-]+)\)\)$/.exec(value ?? '')
    expect(mix, `${where}: ${value}`).not.toBeNull()
    const a = rgb(tokens[name(mix![1]!)]!)
    const b = rgb(tokens[name(mix![3]!)]!)
    const p = Number(mix![2]) / 100
    return a.map((v, i) => v * p + b[i]! * (1 - p))
  }
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
  const [hi, lo] = [lum(paint(fore)), lum(paint(back))].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('urgent banner css', () => {
  it('css tokens, radius and tones', () => {
    // Only tokens, no raw colours: color-mix() and transparent are allowed, but each colour in a mix is a token or transparent.
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(|(?<![-\w])(red|orange|green|white|black|currentcolor)(?![-\w])/i)
    const mixes = [...CSS.matchAll(/color-mix\(\s*in srgb\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]!)
    expect(mixes.length).toBeGreaterThan(0)
    expect(CSS.match(/color-mix\(/g)).toHaveLength(mixes.length)
    for (const args of mixes) {
      for (const part of args.split(',')) expect(part.trim(), `color-mix(${args})`).toMatch(/^(var\(--[a-z-]+\)|transparent)( \d+%)?$/)
    }
    const used = new Set([...CSS.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]))
    const allowed = new Set(['--border-strong', '--bg', '--fg', '--muted', '--font', '--mono', '--size-dense', '--size-small', '--size-micro', '--radius-md', '--radius-pill', '--tone', '--blocked', '--needs-you', '--ready'])
    expect([...used].filter((t) => !allowed.has(t!))).toEqual([])
    // Running and idle never tint, and the focus ring stays the base one.
    expect(CSS).not.toMatch(/--(running|idle|focus)/)
    // The plain box: no tone.
    const box = styleOf('.urgent', desktop)
    expect(box.border).toBe('1px solid var(--border-strong)')
    expect(box.background).toBe('var(--bg)')
    expect(['8px', 'var(--radius-md)']).toContain(box['border-radius'])
    expect(box.padding).toBe('12px 8px 12px 16px')
    expect(styleOf(COUNTED, stacked).padding).toBe('12px')
    expect(styleOf('.urgent', stackedPlain).padding).toBe('12px')
    // Each tone sets --tone from its status token.
    const TONES: [string, string][] = [['s-bad', 'blocked'], ['s-you', 'needs-you'], ['s-ok', 'ready']]
    for (const [cls, token] of TONES) {
      const t = `.urgent:has(> .status.${cls})`
      expect(styleOf(t, desktop)['--tone'], t).toBe(`var(--${token})`)
      // A toned box: 10 % fill on the page, 50 % border.
      expect(styleOf(t, desktop).background, t).toBe('color-mix(in srgb, var(--tone) 10%, var(--bg))')
      expect(styleOf(t, desktop)['border-color'], t).toBe('color-mix(in srgb, var(--tone) 50%, transparent)')
      expect(styleOf(`${t} .urgent-open.btn.quiet:hover`, desktop).background, t).toBe('color-mix(in srgb, var(--tone) 16%, transparent)')
    }
    // Only those three tint: never running or idle.
    expect(CSS).not.toMatch(/s-(run|idle)/)
    expect(styleOf('.urgent-title', desktop)['font-weight']).toBe('500')
    // Every background and border uses the box's own tokens or the tone; nothing else.
    for (const r of all) {
      for (const [p, v] of Object.entries(decls(r.body))) {
        // A layer copies the card it sits behind.
        if (r.selectors.includes('.urgent-layer') && (/^background/.test(p) || p === 'border')) {
          expect(v, `.urgent-layer ${p}`).toBe('inherit')
          continue
        }
        if (/^background/.test(p) || /^border(-(top|right|bottom|left))?(-color)?$/.test(p)) expect(v, `${r.selectors.join(',')} ${p}`).toMatch(/^(var\(--bg\)|1px solid var\(--border-strong\)|color-mix\(in srgb, var\(--tone\) \d+%, (var\(--bg\)|transparent)\))$/)
      }
    }
    // The quiet text button: the label in --fg (base quiet is muted), no box until hover.
    const open = styleOf('.urgent-open.btn.quiet', desktop)
    expect(open.color).toBe('var(--fg)')
    // An empty slot takes no space.
    const slot = Object.assign({}, ...all.filter((r) => r.selectors.includes('.urgent-slot')).map((r) => decls(r.body))) as Record<string, string>
    for (const p of Object.keys(slot)) expect(p, `.urgent-slot ${p}`).not.toMatch(/^(padding|margin|border|gap|row-gap|column-gap|min-height|height)/)
    // A grid item of .main: without min-width 0 a long title widens the column and the page scrolls sideways.
    expect(slot['min-width']).toBe('0')
    // Desktop: one line, the title ends in an ellipsis.
    const title = styleOf('.urgent-title', desktop)
    expect(title['text-overflow']).toBe('ellipsis')
    expect(title['white-space']).toBe('nowrap')
  })

  it('layers follow the card, and the stack stays on the column', () => {
    const layer = styleOf('.urgent-layer', desktop)
    // Empty boxes on the card's own border box, so they follow its height when its text wraps.
    expect(layer.position).toBe('absolute')
    expect(layer.inset).toBe('-1px')
    expect(layer.width).toBeUndefined()
    expect(layer.height).toBeUndefined()
    expect(layer.background).toBe('inherit')
    expect(layer.border).toBe('inherit')
    expect(layer['border-radius']).toBe('inherit')
    expect(layer['pointer-events']).toBe('none')
    expect(styleOf('.urgent', desktop).position).toBe('relative')
    // Stepped 8 px down and right per layer, behind the card and in order.
    expect(styleOf('.urgent-layer-1', desktop).transform).toBe('translate(8px, 8px)')
    expect(styleOf('.urgent-layer-2', desktop).transform).toBe('translate(16px, 16px)')
    expect(styleOf('.urgent-layer-1', desktop)['z-index']).toBe('-1')
    expect(styleOf('.urgent-layer-2', desktop)['z-index']).toBe('-2')
    // Negative layers need a stacking context on the slot, and none on the card: on the card they would paint over its fill.
    expect(styleOf('.urgent-slot', desktop).isolation).toBe('isolate')
    for (const p of ['isolation', 'transform', 'opacity', 'filter', 'z-index', 'contain', 'container']) expect(styleOf('.urgent', desktop)[p], p).toBeUndefined()
    // The card gives up the layers' room on the right; the gap below is measured from the lowest layer.
    expect(styleOf('.urgent', desktop)['margin-bottom']).toBe('24px')
    expect(styleOf('.urgent', desktop)['margin-right']).toBeUndefined()
    expect(styleOf('.urgent:has(> .urgent-layer-1)', desktop).margin).toBe('0 8px 32px 0')
    expect(styleOf('.urgent:has(> .urgent-layer-2)', desktop).margin).toBe('0 16px 40px 0')
    // Same specificity, so the later rule wins: the two-layer stack comes after the one-layer stack.
    const one = CSS.indexOf('.urgent:has(> .urgent-layer-1)')
    expect(one).toBeGreaterThan(-1)
    expect(CSS.indexOf('.urgent:has(> .urgent-layer-2)')).toBeGreaterThan(one)
    // The narrow layout doesn't undo them.
    for (const sel of [COUNTED, '.urgent:has(> .urgent-layer-1)', '.urgent:has(> .urgent-layer-2)']) expect(styleOf(sel, stacked).margin, sel).toBeUndefined()
    expect(styleOf('.urgent', stackedPlain).margin).toBeUndefined()
  })

  it('the count pill keeps its shape and never gives way', () => {
    const pill = styleOf('.urgent-more', desktop)
    expect(pill.height).toBe('24px')
    expect(pill.padding).toBe('0 8px')
    expect(pill['border-radius']).toBe('var(--radius-pill)')
    expect(pill.font).toBe('500 var(--size-small) / 1 var(--mono)')
    expect(pill.color).toBe('var(--fg)')
    expect(pill.background).toBe('color-mix(in srgb, var(--tone) 24%, var(--bg))')
    expect(pill.flex).toBe('none')
    expect(pill['white-space']).toBe('nowrap')
    // Status and button never shrink either; the title gives way first.
    expect(styleOf('.urgent > .status', desktop).flex).toBe('none')
    expect(styleOf('.urgent-open', desktop).flex).toBe('none')
    expect(styleOf('.urgent-title', desktop)['min-width']).toBe('0')
    // A status with no tone still gets a fill for the pill: a mix of an unset --tone is invalid and paints nothing.
    expect(styleOf('.urgent', desktop)['--tone']).toBe('var(--muted)')
  })

  it('pill text reaches 4.5:1 on its fill, for every tone and theme', () => {
    const pill = styleOf('.urgent-more', desktop)
    for (const [theme, tokens] of THEMES) {
      for (const tone of ['blocked', 'needs-you', 'ready', 'muted']) {
        const where = `${theme} ${tone}`
        expect(ratio(tokens, tone, pill.color, pill.background, where), where).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('the slot is the container, and an empty one takes no space', () => {
    const slot = styleOf('.urgent-slot', desktop)
    expect(slot.container).toBe('urgent / inline-size')
    expect(slot['min-width']).toBe('0')
    expect(slot.display).toBe('block')
    // The switch reads the banner's width: the sidebar can take 400 px from the column at any viewport above 820 px.
    expect(CSS).not.toMatch(/@media/)
    expect(CSS).toMatch(/@container urgent \(max-width: 520px\)/)
  })

  it('stacked with a count: status and pill, then the text, then a 44 px open run', () => {
    const box = styleOf(COUNTED, stacked)
    expect(box.display).toBe('grid')
    expect(box['grid-template-columns']).toBe('minmax(0, 1fr) auto')
    expect(box['grid-template-areas']).toBe('"status more" "text text" "open open"')
    expect(box.gap).toBe('8px 12px')
    expect(styleOf(`${COUNTED} > .status`, stacked)['grid-area']).toBe('status')
    expect(styleOf(`${COUNTED} > .urgent-text`, stacked)['grid-area']).toBe('text')
    expect(styleOf('.urgent-more', stacked)['grid-area']).toBe('more')
    expect(styleOf(`${COUNTED} > .urgent-open`, stacked)['grid-area']).toBe('open')
    // Row 1's two ends: never on top of each other.
    expect(styleOf(`${COUNTED} > .status`, stacked)['justify-self']).toBe('start')
    expect(styleOf('.urgent-more', stacked)['justify-self']).toBe('end')
    // The text wraps, even a title with no spaces.
    expect(styleOf(`${COUNTED} > .urgent-text`, stacked).display).toBe('block')
    for (const sel of [`${COUNTED} .urgent-title`, `${COUNTED} .urgent-where`]) {
      expect(styleOf(sel, stacked)['white-space'], sel).toBe('normal')
      expect(styleOf(sel, stacked)['overflow-wrap'], sel).toBe('anywhere')
    }
    // Full width, at least 44 px tall.
    const btn = styleOf(`${COUNTED} > .urgent-open`, stacked)
    expect(btn.width).toBe('100%')
    expect(Number(/^(\d+)px$/.exec(btn['min-height'] ?? '')?.[1] ?? 0)).toBeGreaterThanOrEqual(44)
  })

  it('with a count, short of room on one line, the repo goes first and the title keeps most of the text', () => {
    expect(styleOf(`${COUNTED} .urgent-at`, noRepo).display).toBe('none')
    expect(styleOf(`${COUNTED} .urgent-where`, noRepo)['max-width']).toBe('40%')
    // Wide: the run may take half.
    expect(styleOf('.urgent-where', desktop)['max-width']).toBe('50%')
    // The narrow rules come later, so they win: 760 px holds 620 px.
    expect(CSS.indexOf('(max-width: 760px)')).toBeGreaterThan(-1)
    expect(CSS.indexOf('(max-width: 620px)')).toBeGreaterThan(CSS.indexOf('(max-width: 760px)'))
  })

  it('with no count, the 620 and 760 px switches change nothing', () => {
    // Every rule in those two blocks is for a banner with a pill, so a banner with none keeps its one line and its repo.
    const blocks = all.filter((r) => stacked(r.media) || noRepo(r.media))
    expect(blocks.length).toBeGreaterThan(0)
    for (const r of blocks) for (const sel of r.selectors) expect(sel, r.media).toMatch(/urgent-more/)
    // And the only other switch is the narrow one.
    const media = new Set(all.map((r) => r.media).filter(Boolean))
    expect([...media].sort()).toEqual(['@container urgent (max-width: 520px)', '@container urgent (max-width: 620px)', '@container urgent (max-width: 760px)'])
  })

  it('with no count, it stacks at 520 px, in the same rows as a banner with a count', () => {
    // Below this the title drops under about 20 characters. Above it, 528 px (viewport 1024, sidebar 400) stays on one line.
    const PAIRS: [string, string][] = [
      ['.urgent', COUNTED],
      ['.urgent > .status', `${COUNTED} > .status`],
      ['.urgent-text', `${COUNTED} > .urgent-text`],
      ['.urgent-title', `${COUNTED} .urgent-title`],
      ['.urgent-where', `${COUNTED} .urgent-where`],
      ['.urgent-open', `${COUNTED} > .urgent-open`],
    ]
    // Two blocks with the same body: they can't drift apart.
    for (const [plain, counted] of PAIRS) {
      const body = styleOf(plain, stackedPlain)
      expect(Object.keys(body).length, plain).toBeGreaterThan(0)
      expect(body, plain).toEqual(styleOf(counted, stacked))
    }
    // The repo hides here, as it does on phones today.
    expect(styleOf('.urgent-at', stackedPlain).display).toBe('none')
    // The 44 px target stays.
    expect(Number(/^(\d+)px$/.exec(styleOf('.urgent-open', stackedPlain)['min-height'] ?? '')?.[1] ?? 0)).toBeGreaterThanOrEqual(44)
  })

  it('status word keeps its tone and reaches 4.5:1 on the tint, in both themes', () => {
    const STATUSES: [string, string, number][] = [
      ['s-bad', 'blocked', 95],
      ['s-you', 'needs-you', 90],
      ['s-ok', 'ready', 85],
    ]
    for (const [theme, tokens] of THEMES) {
      for (const [cls, token, percent] of STATUSES) {
        const where = `${theme} ${cls}`
        const sel = `.urgent:has(> .status.${cls})`
        // The value the CSS really declares, resolved through this theme's tokens.
        const declared = styleOf(`${sel} > .status`, desktop).color
        expect(ratio(tokens, token, declared, styleOf(sel, desktop).background, where), `${where}: ${declared}`).toBeGreaterThanOrEqual(4.5)
        // Toned, not plain --fg: the tone stays the larger part of the mix.
        expect(declared, where).toBe(`color-mix(in srgb, var(--tone) ${percent}%, var(--fg))`)
      }
    }
  })
})
