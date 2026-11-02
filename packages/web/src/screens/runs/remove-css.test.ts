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

  it('the Remove repo menu item gets a red tint on hover and keyboard focus, and a stronger one on press', () => {
    const tint = (pct: number) => `color-mix(in srgb, var(--danger) ${pct}%, transparent)`
    expect(style(menu(), '.mi-danger:hover').background).toBe(tint(14))
    expect(style(menu(), '.mi-danger:focus-visible').background).toBe(tint(14))
    expect(style(menu(), '.mi-danger:active').background).toBe(tint(18))
    expect(style(menu(), '.mi-danger:active').color).toBe('var(--danger)')
    // After .mi-action:hover, so the tint wins at the same specificity.
    const css = menu()
    expect(css.indexOf('.mi-danger:hover')).toBeGreaterThan(css.indexOf('.mi-action:hover'))
  })
})

describe('sidebar ⋯ button', () => {
  it('is hidden until the card is hovered or holds focus, or its menu is open', () => {
    expect(style(runs(), '.run-more').opacity).toBe('0')
    for (const sel of ['.run-wrap:hover .run-more', '.run-wrap:focus-within .run-more', '.run-more[aria-expanded="true"]']) {
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

describe('ghost icon button', () => {
  it('is transparent with no outline at rest', () => {
    const d = style(base(), '.btn.ghost')
    expect(d.background).toBe('transparent')
    expect(d['border-color']).toBe('transparent')
  })

  it('gets a subtle background on hover, keyboard focus, and while its menu is open, seen on a hovered card too', () => {
    for (const sel of ['.btn.ghost:hover', '.btn.ghost:focus-visible', '.btn.ghost[aria-expanded="true"]']) {
      const d = style(base(), sel)
      expect(d.background, sel).toBe('color-mix(in srgb, var(--fg) 10%, transparent)')
      expect(d['border-color'], sel).toBe('transparent')
    }
  })

  it('keeps the focus ring: no ghost or sidebar rule turns the outline off', () => {
    for (const r of [...rules(base()), ...rules(runs())]) {
      if (r.selectors.some((s) => s.includes('.ghost') || s.includes('.run-more'))) expect(decls(r.body).outline, r.selectors.join()).toBeUndefined()
    }
  })

  it('is the sidebar ⋯ look too: the sidebar rule sets no background, border, or colour of its own', () => {
    for (const sel of ['.run-more', '.btn.icon.run-more', '.run-more:hover', '.run-more[aria-expanded="true"]']) {
      const d = style(runs(), sel)
      for (const prop of ['background', 'border-color', 'color']) expect(d[prop], `${sel} ${prop}`).toBeUndefined()
    }
  })
})

describe('sidebar run card', () => {
  it('reserves no right column: nothing pads the card for the ⋯', () => {
    expect(runs()).not.toMatch(/:has\(> ?\.run-more-wrap\)/)
    expect(style(runs(), '.run')['padding-right']).toBeUndefined()
  })

  it('holds the ⋯ on the second line at the right, clear of the status', () => {
    const wrap = style(runs(), '.run-more-wrap')
    expect(wrap.position).toBe('absolute')
    expect(wrap.bottom).toBeDefined()
    expect(wrap.top).toBeUndefined()
    // An inline button would sit on a text baseline, a few px above the wrapper's bottom.
    expect(wrap.display).toBe('flex')
    expect(style(runs(), '.run-wrap').position).toBe('relative')
  })

  it('keeps the second line tall enough for the ⋯ on every card, repo line or not, with room beside the text', () => {
    const line = style(runs(), '.run-line')
    expect(parseInt(line['min-height']!, 10)).toBeGreaterThanOrEqual(24)
    expect(parseInt(line['padding-right']!, 10)).toBeGreaterThanOrEqual(24)
    expect(style(runs(), '.run-body')['grid-template-rows']).toBeUndefined()
  })

  it('puts each status in a fixed-width column on the 4 px scale, dot first, so every dot sits on one x', () => {
    const columns = style(runs(), '.run-body')['grid-template-columns']!
    const column = /^minmax\(0, 1fr\) (\d+)px$/.exec(columns)
    expect(column, columns).not.toBeNull()
    // `update pod`, the longest label the sidebar shows, measures 84.9 px with its dot.
    expect(Number(column![1])).toBeGreaterThanOrEqual(85)
    expect(Number(column![1]) % 4).toBe(0)
    const status = style(runs(), '.run .status')
    expect(status['flex-direction']).toBeUndefined()
    expect(status['justify-self']).toBe('start')
    expect(runs()).not.toContain('row-reverse')
    // Never wraps: the shared .status rule keeps it on one line.
    expect(style(base(), '.status')['white-space']).toBe('nowrap')
  })

  it('stacks by a named container query on the card, not a media query', () => {
    expect(style(runs(), '.run').container).toBe('run-card / inline-size')
    const m = /@container run-card \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/.exec(runs())
    expect(m, 'the container rule').not.toBeNull()
    // Just above the threshold, the name column still fits `claim-only` (70 px at 14 px / 500) beside the status.
    const threshold = Number(m![1])
    const column = Number(/(\d+)px$/.exec(style(runs(), '.run-body')['grid-template-columns']!)![1])
    expect(threshold % 4).toBe(0)
    expect(threshold - column - parseInt(style(runs(), '.run-body')['column-gap']!, 10)).toBeGreaterThanOrEqual(70)
    const stacked = rules(m![2]!)
    const of = (sel: string) => Object.assign({}, ...stacked.filter((r) => r.selectors.includes(sel)).map((r) => decls(r.body))) as Record<string, string>
    expect(of('.run-body')['grid-template-columns']).toBe('minmax(0, 1fr)')
    // Name, then status, then the repo line: the document's order in one column.
    expect(of('.run .status')['min-height']).toBe('0')
  })

  it('never breaks a word in the middle while it can wrap between words', () => {
    expect(style(runs(), '.run b')['overflow-wrap']).toBe('break-word')
    const word = style(runs(), '.run-word')
    expect(word.display).toBe('inline-block')
    expect(word['max-width']).toBe('100%')
  })
})

describe('sidebar cards stack by default', () => {
  // Sidebar → card: 16 px of padding each side and its 1 px border. Card → content: 16 px of padding and a 1 px border each side.
  const contentOf = (sidebar: number) => sidebar - 33 - 34
  const threshold = () => Number(/@container run-card \(max-width: (\d+)px\)/.exec(runs())![1])
  const stacks = (sidebar: number) => contentOf(sidebar) <= threshold()

  it('stacks at the default 260 px sidebar and up to 320 px, and uses two columns from 324 px', () => {
    for (const sidebar of [200, 240, 260, 300, 320]) expect(stacks(sidebar), `sidebar ${sidebar}`).toBe(true)
    for (const sidebar of [324, 360, 400]) expect(stacks(sidebar), `sidebar ${sidebar}`).toBe(false)
  })

  // Measured in the browser at 14 px / 500 in the app's own font, rounded up.
  const WORDS = { authentication: 95, skyscraperviewpanel: 139, pod_board_long_repo: 145 }

  it('fits real long words whole on the stacked line at the default width, so none breaks', () => {
    for (const [word, width] of Object.entries(WORDS)) expect(contentOf(260), word).toBeGreaterThanOrEqual(width)
  })

  it('at the narrowest sidebar, breaks only the words wider than the 133 px line', () => {
    expect(contentOf(200)).toBe(133)
    expect(WORDS.authentication).toBeLessThanOrEqual(contentOf(200))
    expect(WORDS.skyscraperviewpanel).toBeGreaterThan(contentOf(200))
    expect(WORDS.pod_board_long_repo).toBeGreaterThan(contentOf(200))
  })

  it('fits them whole in the name column just above the threshold too', () => {
    const column = Number(/(\d+)px$/.exec(style(runs(), '.run-body')['grid-template-columns']!)![1])
    const gap = parseInt(style(runs(), '.run-body')['column-gap']!, 10)
    for (const [word, width] of Object.entries(WORDS)) expect(contentOf(324) - column - gap, word).toBeGreaterThanOrEqual(width)
  })

  it('breaks inside a word only as a last resort, for a word wider than its line', () => {
    expect(style(runs(), '.run b')['overflow-wrap']).toBe('break-word')
    expect(style(runs(), '.run-repo')['overflow-wrap']).toBe('break-word')
    expect(style(runs(), '.run b')['word-break']).toBeUndefined()
    expect(style(runs(), '.run-word')['overflow-wrap']).toBe('break-word')
  })

  it('says the real threshold in the comment above the rule', () => {
    const at = runs().length && readFileSync(join(here, 'runs.css'), 'utf8')
    expect(at).toContain(`At ${threshold()} px of content or less`)
  })

  it('has no dead flex rule on the status, which is a grid item', () => {
    expect(style(runs(), '.run .status').flex).toBeUndefined()
  })
})
