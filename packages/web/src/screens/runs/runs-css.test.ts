import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

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
    else if (prelude.startsWith('@container')) out.push(...rules(body, prelude))
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

const NARROW = /^\(\s*max-width:\s*480px\s*\)$/
const runsRules = () => rules(stripComments(readFileSync(join(here, 'runs.css'), 'utf8')))

/** Declarations of every rule that lists `sel` exactly under `match`, merged in source order. */
function styleOf(sel: string, match: (media?: string) => boolean): Record<string, string> {
  return Object.assign({}, ...runsRules().filter((r) => match(r.media) && r.selectors.includes(sel)).map((r) => decls(r.body)))
}

describe('runs.css reply panel', () => {
  // On a phone the rows stack as columns, so a 14rem flex-basis would become a 14rem height.
  it('reply text does not grow tall on narrow screens', () => {
    for (const sel of ['.reply-row', '.reply-cmd']) {
      expect(styleOf(sel, (m) => !!m && NARROW.test(m))['flex-direction'], `${sel} stacks at ≤ 480 px`).toBe('column')
    }
    for (const sel of ['.reply-why', '.reply-cmd code']) {
      expect(styleOf(sel, (m) => !!m && NARROW.test(m))['flex'], `${sel} flex at ≤ 480 px`).toBe('0 0 auto')
    }
  })

  it('reply text keeps its desktop flex', () => {
    for (const sel of ['.reply-why', '.reply-cmd code']) {
      expect(styleOf(sel, (m) => !m)['flex'], `${sel} flex on wide screens`).toBe('1 1 14rem')
    }
  })
})

/** Whether a rule's media applies at `width` px: none, or max-width at or above it, or min-width at or below it. */
function appliesAt(media: string | undefined, width: number): boolean {
  if (!media) return true
  const max = /max-width:\s*(\d+)px/.exec(media)
  const min = /min-width:\s*(\d+)px/.exec(media)
  if (!max && !min) return !/print/.test(media) && !/prefers-/.test(media)
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]))
}

/** Every selector's declarations at `width` px, merged in source order. */
function stylesAt(width: number): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const r of runsRules()) {
    if (!appliesAt(r.media, width)) continue
    for (const sel of r.selectors) out.set(sel, { ...out.get(sel), ...decls(r.body) })
  }
  return out
}

const pxOver = (value: string | undefined, limit: number) => [...(value ?? '').matchAll(/(\d+(?:\.\d+)?)px/g)].some((m) => Number(m[1]) > limit)

describe('runs.css layout', () => {
  it('phone layout is one column', () => {
    for (const width of [480, 375]) {
      const styles = stylesAt(width)
      const body = styles.get('.screen-body')
      expect(body, '.screen-body has rules').toBeDefined()
      expect(body!['display']).toBe('grid')
      expect(body!['grid-template-columns'], `.screen-body at ${width} px`).toMatch(/^(1fr|minmax\(0,\s*1fr\))$/)
      for (const [sel, d] of styles) {
        for (const prop of ['width', 'min-width', 'flex-basis']) {
          expect(pxOver(d[prop], 375), `${sel} ${prop}: ${d[prop]} at ${width} px`).toBe(false)
        }
        expect(pxOver(d['grid-template-columns'], 375), `${sel} columns at ${width} px`).toBe(false)
      }
    }
  })

  it('the main column is one shared column, about 1120 px at most, on desktop', () => {
    expect(stylesAt(1280).get('.main')?.['max-width']).toBe('1120px')
    expect(stylesAt(1280).get('.main:not(.wide) > *')?.['max-width']).toBeUndefined()
    expect(stylesAt(1280).get('.screen-body')?.['grid-template-columns']).not.toMatch(/^(1fr|minmax\(0,\s*1fr\))$/)
  })
})

describe('runs.css sidebar', () => {
  it('is a full-height left column with a right border on desktop', () => {
    const side = stylesAt(1280).get('.side')
    expect(side?.['position']).toBe('sticky')
    expect(side?.['height']).toBe('100dvh')
    expect(side?.['border-right']).toMatch(/1px solid var\(--border\)/)
    // Title on top, the list in the middle, Add repo pinned to the bottom.
    expect(side?.['grid-template-rows']).toMatch(/1fr/)
    expect(stylesAt(1280).get('.screen-body')?.['padding'] ?? '0').toMatch(/^0(px)?$/)
  })

  it('scrolls a long runs list inside its row, so Add repo stays in view', () => {
    const runs = stylesAt(1280).get('.runs')
    expect(runs?.['overflow-y']).toBe('auto')
    expect(runs?.['min-height']).toBe('0')
    // The list clips its corners (overflow: hidden), so an auto row would squash it instead of scrolling.
    expect(runs?.['grid-auto-rows']).toBe('max-content')
  })

  it('stacks above the main column on phones, as before', () => {
    for (const width of [820, 480, 375]) {
      const side = stylesAt(width).get('.side')
      expect(side?.['position'], `.side at ${width} px`).toBe('static')
      expect(side?.['height'], `.side at ${width} px`).toBe('auto')
      expect(side?.['border-right'], `.side at ${width} px`).toBe('0')
      expect(side?.['border-bottom'], `.side at ${width} px`).toMatch(/1px solid var\(--border\)/)
    }
  })

  it('takes its width from the resize handle on desktop, 260 px until it is set', () => {
    expect(stylesAt(1280).get('.screen-body')?.['grid-template-columns']).toBe('var(--side-width, 260px) minmax(0, 1fr)')
    // The sidebar, its handle, and the main column sit in fixed cells, so the handle overlaps the border line.
    expect(stylesAt(1280).get('.side')?.['grid-column']).toBe('1')
    expect(stylesAt(1280).get('.side-handle')?.['grid-column']).toBe('1')
    expect(stylesAt(1280).get('.main')?.['grid-column']).toBe('2')
  })

  it('the handle: a col-resize strip on the right edge, with a hover and drag line and a visible focus ring', () => {
    const at = stylesAt(1280)
    const handle = at.get('.side-handle')
    expect(handle?.['cursor']).toBe('col-resize')
    expect(handle?.['justify-self']).toBe('end')
    expect(handle?.['position']).toBe('sticky')
    expect(handle?.['height']).toBe('100dvh')
    // A pointer drag never scrolls or zooms the page instead.
    expect(handle?.['touch-action']).toBe('none')
    // The visible line shows on hover, on focus, and while dragging.
    for (const sel of ['.side-handle:hover::after', '.side-handle:focus-visible::after', '[data-resizing] .side-handle::after']) {
      expect(at.get(sel)?.['background'], sel).toBe('var(--focus)')
    }
    expect(at.get('.side-handle:focus-visible')?.['outline']).toMatch(/2px solid/)
  })

  it('while dragging: col-resize everywhere and no text selection', () => {
    const drag = stylesAt(1280).get('[data-resizing]')
    expect(drag?.['cursor']).toBe('col-resize')
    expect(drag?.['user-select']).toBe('none')
    expect(drag?.['-webkit-user-select']).toBe('none')
  })

  it('is off on phones, where the sidebar stacks', () => {
    for (const width of [820, 480, 375]) {
      expect(stylesAt(width).get('.side-handle')?.['display'], `.side-handle at ${width} px`).toBe('none')
      expect(stylesAt(width).get('.main')?.['grid-column'], `.main at ${width} px`).toBe('1')
      expect(stylesAt(width).get('.main')?.['grid-row'], `.main at ${width} px`).toBe('2')
    }
  })

  it('has no top bar rules left', () => {
    expect(runsRules().some((r) => r.selectors.includes('.bar'))).toBe(false)
  })
})

describe('runs.css main column and run cards', () => {
  it('centres the 720 px column beside the sidebar', () => {
    const styles = stylesAt(1280)
    const main = styles.get('.main')
    expect(main?.['margin-inline']).toBe('auto')
    expect(main?.['box-sizing']).toBe('content-box')
    // Every part spans the one column, so all their left and right edges line up.
    const part = styles.get('.main:not(.wide) > *')
    expect(part?.['width']).toBe('100%')
    expect(part?.['max-width']).toBeUndefined()
    expect(part?.['justify-self']).toBeUndefined()
    // Text inside the card and the Waiting rows stops near 72 characters.
    for (const sel of ['.next-title', '.next-detail']) expect(styles.get(sel)?.['max-width'], sel).toBe('72ch')
    // The wave board keeps the full width.
    expect(styles.get('.main.wide')?.['max-width']).toBe('none')
  })

  it('lets the flow use more width than the column, centred, scrolling inside its own box', () => {
    const styles = stylesAt(1280)
    const px = (v: string | undefined) => Number(/^(\d+)px$/.exec(v ?? '')?.[1] ?? NaN)
    const mainCap = px(styles.get('.main')?.['max-width'])
    // The flow spans the shared column like every other part; the column is the flow's width.
    expect(styles.get('.main:not(.wide) > .flow-frame')).toBeUndefined()
    expect(mainCap).toBe(1120)
    // Its columns share the column equally and shrink to 152 px before the box scrolls.
    expect(styles.get('.flow')?.['grid-template-columns']).toBe('repeat(var(--flow-cols), minmax(152px, 1fr))')
    // The columns scroll in their own box inside the flow, so the fold line and the board link stay put.
    const frame = styles.get('.flow-scroll')
    expect(frame?.['overflow-x']).toBe('auto')
    expect(frame?.['min-width']).toBe('0')
    // On a phone it still scrolls inside its box.
    expect(stylesAt(375).get('.flow-scroll')?.['overflow-x']).toBe('auto')
    // The cards' screen-reader words are absolutely placed: the box must hold them, or they widen the page.
    expect(frame?.['position']).toBe('relative')
  })

  const STATUS = /var\(--(blocked|needs-you|running|ready|idle)\)/

  it('gives cards a plain border and colours only the highlighted one', () => {
    const styles = stylesAt(1280)
    expect(styles.get('.flow-step')?.['border']).toBe('1px solid var(--border)')
    expect(styles.get('.flow-step.hi.live')?.['border-color']).toBe('var(--running)')
    expect(styles.get('.flow-step.hi.you')?.['border-color']).toBe('var(--needs-you)')
    expect(styles.get('.flow-step.hi.blocked')?.['border-color']).toBe('var(--blocked)')
    // No coloured card edges: a status colour on a border or background only on a highlighted card.
    for (const r of runsRules().filter((x) => x.selectors.some((sel) => sel.includes('flow')))) {
      const d = decls(r.body)
      for (const prop of Object.keys(d)) {
        if (!/^(border|background|box-shadow)/.test(prop) || !STATUS.test(d[prop]!)) continue
        for (const sel of r.selectors) expect(sel, `${sel} ${prop}`).toMatch(/^\.flow-step\.hi\./)
      }
    }
  })

  it('folds the flow to one line on phones, and never on desktop', () => {
    const desk = stylesAt(1280)
    const phone = stylesAt(375)
    // The fold button: hidden on desktop, a 44 px line on phones.
    expect(desk.get('.flow-fold')?.['display']).toBe('none')
    expect(phone.get('.flow-fold')?.['display']).toBe('flex')
    expect(phone.get('.flow-fold')?.['min-height']).toBe('44px')
    // Folded (no .open): the columns and the board link hide on phones only.
    for (const sel of ['.flow-frame:not(.open) > .flow-scroll']) {
      expect(phone.get(sel)?.['display'], sel).toBe('none')
      expect(desk.get(sel)?.['display'], sel).toBeUndefined()
    }
  })

  it('keeps the folded flow tight on phones, so the Next step card and its button fit 375 × 667', () => {
    const px = (v: string | undefined) => Number(/^(\d+)px$/.exec(v ?? '')?.[1] ?? NaN)
    const phone = stylesAt(375)
    expect(px(phone.get('.flow-frame')?.['margin-bottom'])).toBeLessThanOrEqual(16)
    expect(px(phone.get('.run-header')?.['margin-bottom'])).toBeLessThanOrEqual(12)
    // The plan's title is longer than its slug and wraps beside the link and the menu, so the strip, the
    // card's heading and its button sit 8, 8 and 16 px closer in (measured: the button's bottom at 674 px without).
    expect(px(phone.get('.run-meta')?.['margin-top'])).toBeLessThanOrEqual(8)
    expect(px(phone.get('.next-top')?.['margin-bottom'])).toBeLessThanOrEqual(8)
    expect(px(phone.get('.next-acts')?.['margin-top'])).toBeLessThanOrEqual(16)
  })

  it('shortens the wave board link on phones', () => {
    expect(stylesAt(1280).get('.board-link-short')?.['display']).toBe('none')
    expect(stylesAt(1280).get('.board-link-long')?.['display']).toBeUndefined()
    expect(stylesAt(375).get('.board-link-short')?.['display']).toBe('inline')
    expect(stylesAt(375).get('.board-link-long')?.['display']).toBe('none')
  })

  it('draws the progress strip under the plan name', () => {
    const styles = stylesAt(1280)
    expect(styles.get('.strip')?.['display']).toBe('flex')
    expect(styles.get('.strip i')?.['height']).toBe('4px')
    expect(styles.get('.strip i.done')?.['background']).toBe('var(--fg)')
  })

  it('dims waiting cards by colour, not opacity, so their text stays readable', () => {
    const dim = stylesAt(1280).get('.flow-step.dim')
    expect(dim?.['opacity']).toBeUndefined()
    expect(stylesAt(1280).get('.flow-step.dim .flow-label')?.['color']).toBe('var(--muted)')
  })

  it('shows each run as its own card with a gap, not one box with dividers', () => {
    const styles = stylesAt(1280)
    const list = styles.get('.run-list')
    expect(list?.['border'] ?? 'none').toMatch(/^(0|none)$/)
    expect(list?.['gap']).toMatch(/^\d+px$/)
    expect(runsRules().some((r) => r.selectors.includes('.run-list li + li'))).toBe(false)
    const run = styles.get('.run')
    expect(run?.['border']).toMatch(/1px solid/)
    expect(run?.['border-radius']).toMatch(/var\(--radius-/)
    const picked = styles.get('.run[aria-current="true"]')
    expect(picked?.['background']).toBe('var(--hover)')
    expect(picked?.['border-color']).toBe('var(--border-strong)')
  })
})

describe('runs.css focus ring room', () => {
  it('leaves the run cards room for the whole focus ring inside the scrolling list', () => {
    const base = stripComments(readFileSync(join(here, '../../theme/base.css'), 'utf8'))
    const ring = decls(/:focus-visible\s*\{([^}]*)\}/.exec(base)![1]!)
    const width = Number(/(\d+(?:\.\d+)?)px/.exec(ring['outline']!)![1])
    const offset = Number(/(\d+(?:\.\d+)?)px/.exec(ring['outline-offset']!)![1])
    const runs = stylesAt(1280).get('.runs')!
    expect(runs['overflow-y']).toBe('auto')
    const pad = Number(/^(\d+(?:\.\d+)?)px$/.exec(runs['padding'] ?? '')?.[1] ?? 0)
    expect(pad, 'padding inside the scroll box').toBeGreaterThanOrEqual(width + offset)
    expect(runs['margin'], 'the padding is given back so the cards keep their place').toBe(`-${pad}px`)
  })
})

describe('runs.css run cards and Add repo', () => {
  it('spaces the run cards 12 px apart', () => {
    expect(stylesAt(1280).get('.run-list')?.['gap']).toBe('12px')
  })

  it('puts the status in the top-right corner, on the name line, with the repo and the fix tag under the name', () => {
    const run = stylesAt(1280).get('.run')
    expect(run?.['align-items']).toBe('baseline')
    expect(run?.['justify-content']).toBe('space-between')
    // The name takes a whole line; the muted repo and the tag share the line under it.
    const head = stylesAt(1280).get('.run-head')
    expect(head?.['flex-direction'] ?? 'row').toBe('row')
    expect(head?.['flex-wrap']).toBe('wrap')
    expect(stylesAt(1280).get('.run-head b')?.['flex-basis']).toBe('100%')
    expect(stylesAt(1280).get('.run-repo')?.['font-size']).toBe('var(--size-micro)')
    // One padding for every card, so one- and two-line cards line up.
    expect(runsRules().filter((r) => r.selectors.some((s) => s.startsWith('.run') && !s.startsWith('.run-') && !s.startsWith('.runs')) && 'padding' in decls(r.body))).toHaveLength(1)
  })

  it('makes Add repo as wide as the run cards, its icon and label centred', () => {
    const add = stylesAt(1280).get('.side-foot .add-repo')
    expect(add?.['width']).toBe('100%')
    expect(add?.['justify-content']).toBe('center')
    // Even sides, so the centred label isn't pushed by the lead padding.
    // Centred on its ink: the plus has about 2 px of empty space on its left, so the
    // left padding is that much smaller than the right.
    const px = (v: string | undefined) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v ?? '')?.[1] ?? NaN)
    expect(px(add?.['padding-right']) - px(add?.['padding-left'])).toBe(2)
  })
})

describe('picker.css crumbs', () => {
  const pickerRules = () => rules(stripComments(readFileSync(join(here, 'picker.css'), 'utf8')))
  const at = (sel: string, media?: RegExp) =>
    Object.assign({}, ...pickerRules().filter((r) => (media ? !!r.media && media.test(r.media) : !r.media) && r.selectors.includes(sel)).map((r) => decls(r.body)))

  it('stays on one line; a long name ends in an ellipsis rather than scrolling sideways', () => {
    const row = at('.picker-crumbs')
    expect(row['display']).toBe('flex')
    expect(row['flex-wrap']).toBe('nowrap')
    expect(row['min-width']).toBe('0')
    const crumb = at('.picker-crumb')
    expect(crumb['min-width']).toBe('0')
    expect(crumb['overflow']).toBe('hidden')
    expect(crumb['text-overflow']).toBe('ellipsis')
    expect(crumb['white-space']).toBe('nowrap')
    // The root and the fold never shrink; the folder names do.
    expect(at('.picker-fold')['flex']).toMatch(/^none$|^0 0/)
    // The parent gives way before the current folder, but keeps a few letters.
    const shrink = (d: Record<string, string>) => Number(d['flex-shrink'] ?? /^\S+\s+(\S+)/.exec(d['flex'] ?? '')?.[1] ?? 1)
    // Any shrink share at all would cut the current name by a fraction of a pixel, so it doesn't shrink;
    // a cap leaves the other crumbs their room, and only a longer name ends in an ellipsis.
    expect(shrink(at('.picker-crumb[aria-current="location"]'))).toBe(0)
    expect(at('.picker-crumb[aria-current="location"]')['max-width']).toMatch(/^calc\(100% - \d+(\.\d+)?rem\)$/)
    expect(shrink(at('button.picker-crumb'))).toBeGreaterThan(0)
    // Crumbs size to their text: no min-width box around a short name such as E:.
    expect(at('button.picker-crumb')['min-width'] ?? '0').toBe('0')
    expect(at('.picker-crumb')['padding']).toBe('2px 6px')
    expect(at('.picker-crumbs')['gap']).toBe('4px')
  })

  it('crumbs are muted 14 px Geist, the text colour on hover', () => {
    const crumb = at('.picker-crumb')
    expect(crumb['color']).toBe('var(--muted)')
    expect(crumb['font']).toMatch(/var\(--size-dense\)[\s\S]*var\(--font\)/)
    expect(at('button.picker-crumb:hover')['color']).toBe('var(--fg)')
    expect(at('.picker-crumb[aria-current="location"]')['color']).toBe('var(--fg)')
  })

  it('keeps the crumbs 44 px tall to touch on phones', () => {
    expect(at('button.picker-crumb', /max-width:\s*480px/)['min-height']).toBe('44px')
    // Taller to touch, never wider: the gaps around the arrows stay even.
    expect(at('button.picker-crumb', /max-width:\s*480px/)['min-width']).toBeUndefined()
    expect(at('button.picker-crumb', /max-width:\s*480px/)['padding']).toBeUndefined()
    expect(at('.picker-fold', /max-width:\s*480px/)['min-height']).toBe('44px')
    expect(at('.picker-fold', /max-width:\s*480px/)['min-width']).toBe('44px')
    expect(at('.picker-fold-item', /max-width:\s*480px/)['min-height']).toBe('44px')
  })
})

describe('runs.css Add repo size', () => {
  it('is the regular size, not small', () => {
    // .btn is 40 px; .btn.sm would make it 32 px.
    const add = stylesAt(1280).get('.side-foot .add-repo')
    expect(add?.['height']).toBeUndefined()
    expect(add?.['width']).toBe('100%')
  })
})

describe('tabs.css text caps', () => {
  const tabsRules = () => rules(stripComments(readFileSync(join(here, 'tabs.css'), 'utf8')))
  const tabsStyle = (sel: string) => Object.assign({}, ...tabsRules().filter((r) => !r.media && r.selectors.includes(sel)).map((r) => decls(r.body)))

  it('caps the Waiting rows and the answer entry near 72 characters', () => {
    for (const sel of ['.wait-body', '.wait-title', '.wait-detail', '.wait-answer', '.answer-entry']) expect(tabsStyle(sel)['max-width'], sel).toBe('72ch')
  })

  it('keeps the hover rule to its own colour', () => {
    const hover = tabsRules().filter((r) => r.selectors.includes('.wait-toggle:hover .wait-body'))
    expect(hover).toHaveLength(1)
    expect(hover[0]!.selectors).toEqual(['.wait-toggle:hover .wait-body'])
    expect(decls(hover[0]!.body)).not.toHaveProperty('max-width')
  })
})

describe('runs.css flow rows and lines', () => {
  it('lays the flow out in rows, so cards in a row share one height', () => {
    const styles = stylesAt(1440)
    const flow = styles.get('.flow')
    expect(flow?.['display']).toBe('grid')
    expect(flow?.['position']).toBe('relative')
    expect(flow?.['grid-template-columns']).toBe('repeat(var(--flow-cols), minmax(152px, 1fr))')
    expect(flow?.['grid-template-rows']).toBe('auto repeat(var(--flow-rows), auto)')
    expect(flow?.['min-width']).toBe('calc(var(--flow-cols) * 152px + (var(--flow-cols) - 1) * 32px)')
    // The same room between cards both ways, so every connector and its arrowhead has space.
    expect(flow?.['row-gap']).toBe('32px')
    expect(flow?.['column-gap']).toBe('32px')
    // The heading sits 16 px above its first card: it gives back half the row gap.
    expect(styles.get('.flow-cap')?.['margin-bottom']).toBe('-16px')
    // Columns and their step lists share the flow's rows.
    expect(styles.get('.flow-col')?.['grid-template-rows']).toBe('subgrid')
    expect(styles.get('.flow-steps')?.['grid-template-rows']).toBe('subgrid')
    expect(styles.get('.flow-cols')?.['display']).toBe('contents')
    // Room for the title and two detail lines; never cut: no clamp, nothing hidden.
    const step = styles.get('.flow-step')
    expect(step?.['min-height']).toMatch(/^calc\(/)
    expect(step?.['position']).toBe('relative')
    expect(step?.['align-self'] ?? 'stretch').toBe('stretch')
    for (const sel of ['.flow-step', '.flow-detail']) {
      const d = styles.get(sel) ?? {}
      expect(d['overflow'], sel).toBeUndefined()
      expect(d['-webkit-line-clamp'], sel).toBeUndefined()
      expect(d['line-clamp'], sel).toBeUndefined()
    }
    // No arrow rules left.
    expect(runsRules().some((r) => r.selectors.some((x) => x.includes('flow-arrow')))).toBe(false)
  })

  it('draws quiet lines, the walked part in --fg, the optional one dashed', () => {
    const styles = stylesAt(1440)
    const lines = styles.get('.flow-lines')
    expect(lines?.['position']).toBe('absolute')
    expect(lines?.['pointer-events']).toBe('none')
    expect(styles.get('.flow-lines path')?.['stroke']).toBe('var(--border-strong)')
    expect(styles.get('.flow-lines path')?.['fill']).toBe('none')
    expect(styles.get('.flow-lines path.walked')?.['stroke']).toBe('var(--fg)')
    expect(styles.get('.flow-lines path.dashed')?.['stroke-dasharray']).toMatch(/^\d+ \d+$/)
  })
})

describe('breathing running dot', () => {
  const runsCss = () => stripComments(readFileSync(join(here, 'runs.css'), 'utf8'))
  const baseCss = () => stripComments(readFileSync(join(here, '../../theme/base.css'), 'utf8'))
  const LIVE_MARKS = ['.flow-step.live .flow-mark svg', '.flow-fold[data-state="live"] .flow-mark svg']
  const RUN_DOTS = ['.chip.s-run::before', '.status.s-run::before']
  const REDUCE = /prefers-reduced-motion:\s*reduce/

  it('has one breathe keyframe: opacity only, easing down to 0.45 and back', () => {
    const m = /@keyframes\s+breathe\s*\{([\s\S]*?)\}\s*\}/.exec(baseCss())
    expect(m, 'the breathe keyframes in base.css').not.toBeNull()
    const props = [...m![1]!.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1])
    expect(new Set(props)).toEqual(new Set(['opacity']))
    expect(m![1]).toMatch(/opacity:\s*0\.45/)
    // The old pulses are gone.
    expect(runsCss()).not.toMatch(/flow-pulse/)
    expect(baseCss()).not.toMatch(/status-pulse/)
  })

  it('animates only the running mark in the flow and the fold line, never the card or its text', () => {
    // `animation: none` stops one (the Waiting tab's kind dot), so it doesn't count.
    const animated = runsRules().filter((r) => !r.media && 'animation' in decls(r.body) && decls(r.body)['animation'] !== 'none')
    expect(animated.flatMap((r) => r.selectors).sort()).toEqual([...LIVE_MARKS].sort())
    for (const r of animated) expect(decls(r.body)['animation']).toBe('breathe 2s ease-in-out infinite')
  })

  it('breathes the sidebar and card running dots the same way', () => {
    const animated = rules(baseCss()).filter((r) => !r.media && 'animation' in decls(r.body))
    expect(animated.flatMap((r) => r.selectors).sort()).toEqual([...RUN_DOTS].sort())
    for (const r of animated) expect(decls(r.body)['animation']).toBe('breathe 2s ease-in-out infinite')
  })

  it('stays solid when the reader asks for reduced motion', () => {
    const off = (list: Rule[]) => list.filter((r) => r.media && REDUCE.test(r.media) && decls(r.body)['animation'] === 'none').flatMap((r) => r.selectors)
    expect(off(runsRules()).sort()).toEqual([...LIVE_MARKS].sort())
    expect(off(rules(baseCss())).sort()).toEqual([...RUN_DOTS].sort())
  })
})

describe('runs.css waiting rows', () => {
  const ROW = '.waiting-tab .wait-row'
  const ACTIONS = `${ROW} > .inplace-actions`
  const HEAD = `${ROW} > .wait-toggle`

  it('puts Answer at the right end of the row, centred on the entry, on desktop', () => {
    for (const width of [1280, 821]) {
      const s = stylesAt(width)
      expect(s.get(ROW)?.['grid-template-columns'], `row at ${width} px`).toMatch(/^minmax\(0,\s*1fr\)\s+auto$/)
      expect(s.get(ACTIONS)?.['grid-column'], `actions at ${width} px`).toBe('2')
      expect(s.get(ACTIONS)?.['grid-row'], `actions at ${width} px`).toBe('1')
      expect(s.get(ACTIONS)?.['align-self'], `actions at ${width} px`).toBe('center')
      expect(s.get(HEAD)?.['grid-column'], `entry at ${width} px`).toBe('1')
      expect(s.get(HEAD)?.['grid-row'], `entry at ${width} px`).toBe('1')
      // The open form, your answer, and a reply panel take the row's full text width under it.
      expect(s.get(`${ROW} > *`)?.['grid-column']).toBe('1 / -1')
    }
  })

  it('puts Answer back under the text at 820 px and below', () => {
    for (const width of [820, 375]) {
      const s = stylesAt(width)
      expect(s.get(ACTIONS)?.['grid-column'], `actions at ${width} px`).toBe('1 / -1')
      expect(s.get(ACTIONS)?.['grid-row'], `actions at ${width} px`).toBe('auto')
      expect(s.get(HEAD)?.['grid-column'], `entry at ${width} px`).toBe('1 / -1')
      expect(s.get(HEAD)?.['grid-row'], `entry at ${width} px`).toBe('auto')
    }
  })

  it('insets the rows, the group headers and the empty line like the tab labels and the Log blocks, at every width', () => {
    for (const width of [1280, 821, 820, 480, 375]) {
      const st = stylesAt(width)
      const tab = st.get('.main > .tabs .tab')?.['padding-inline']
      expect(tab, `tab label inset at ${width} px`).toBe('16px')
      // The Log blocks' text inset: the second value of their padding.
      expect(/^\S+\s+(\S+)$/.exec(st.get('.log-group')?.['padding'] ?? '')?.[1], `Log inset at ${width} px`).toBe(tab)
      for (const sel of [ROW, '.waiting-tab .wait-group-head', '.waiting-tab > .tab-empty']) {
        expect(st.get(sel)?.['padding-inline'], `${sel} at ${width} px`).toBe(tab)
      }
    }
  })

  it("the kind's dot and word keep the base .status gap, with no gap of their own", () => {
    const base = rules(stripComments(readFileSync(join(here, '../../theme/base.css'), 'utf8'))).filter((r) => !r.media && r.selectors.includes('.status'))
    expect(Object.assign({}, ...base.map((r) => decls(r.body)))['gap']).toBe('8px')
    for (const sel of ['.next-kind .wait-kind', '.waiting-tab .wait-meta .wait-kind']) {
      for (const width of [1280, 375]) expect(stylesAt(width).get(sel)?.['gap'], `${sel} at ${width} px`).toBeUndefined()
    }
  })

  it('the kind dot never breathes: a decision is not running', () => {
    expect(stylesAt(1280).get('.waiting-tab .wait-meta .wait-kind::before')?.['animation']).toBe('none')
  })

  it('the group header is a 44 px touch target on phones', () => {
    expect(stylesAt(375).get('.wait-group-toggle')?.['min-height']).toBe('44px')
    expect(stylesAt(480).get('.wait-group-toggle')?.['min-height']).toBe('44px')
    expect(stylesAt(1280).get('.wait-group-toggle')?.['min-height']).toBeUndefined()
  })

  it('Show more is a 44 px touch target on phones, and its chevron turns for Show less', () => {
    expect(stylesAt(375).get('.wait-more')?.['min-height']).toBe('44px')
    expect(stylesAt(1280).get('.wait-more')?.['min-height']).toBeUndefined()
    expect(stylesAt(1280).get('.wait-toggle[aria-expanded="true"] .wait-more svg')?.['transform']).toBe('rotate(180deg)')
  })

  it('the Next step card shows the kind like the rows, and its dot never breathes', () => {
    expect(stylesAt(1280).get('.next-kind .wait-kind::before')?.['animation']).toBe('none')
    expect(stylesAt(1280).get('.next-kind')?.['font-size']).toBe('var(--size-micro)')
  })
})

describe('runs.css log tab', () => {
  // The slice log (and a fix run's agent log, the same table) reads calm: no line under every row.
  it('draws no divider between rows or under a wave header, at any width', () => {
    for (const width of [1280, 375]) {
      for (const r of runsRules().filter((x) => appliesAt(x.media, width) && x.selectors.some((s) => s.startsWith('.slice-log')))) {
        const d = decls(r.body)
        for (const side of ['border', 'border-top', 'border-bottom']) {
          expect(d[side] === undefined || d[side] === '0', `${r.selectors.join(', ')} ${side} at ${width} px`).toBe(true)
        }
      }
    }
  })

  it("sets each sprint on one faint block: the Action log row's fill, 8 px corners, no border, 16 px apart, 12 px by 16 px padding", () => {
    for (const width of [1280, 375]) {
      const group = stylesAt(width).get('.log-group')
      expect(group?.['background'], `fill at ${width} px`).toBe(stylesAt(width).get('.other-list li')?.['background'])
      expect(group?.['background']).toBe('var(--surface)')
      expect(group?.['border-radius']).toBe('var(--radius-md)') // 8 px
      // Wider than tall, for optical balance: the lines already carry vertical air.
      expect(group?.['padding']).toBe('12px 16px')
      expect(group?.['border']).toBeUndefined()
      // Outside space at least the inside space.
      expect(stylesAt(width).get('.log-frame')?.['gap']).toBe('16px')
      // The Action log rows and the tab labels share the blocks' 16 px text inset.
      expect(stylesAt(width).get('.other-list li')?.['padding']).toBe('8px 16px')
      expect(stylesAt(width).get('.main > .tabs .tab')?.['padding-inline']).toBe('16px')
      expect(stylesAt(width).get('.main > .tabs .tab[aria-expanded="true"]::after')?.['left']).toBe('16px')
      expect(stylesAt(width).get('.main > .tabs .tab[aria-expanded="true"]::after')?.['right']).toBe('16px')
    }
    // Tight inside a wave: 20 px lines, 2 px above and below each cell (24 px rows, a wave 4 px above its first slice).
    expect(stylesAt(1280).get('.slice-log')?.['line-height']).toBe('20px')
    expect(stylesAt(1280).get('.slice-log td')?.['padding']).toBe('2px 0')
    // 8 px of visible space between the waves of a sprint: a wave's last row keeps no bottom padding, and
    // the next wave's row has 8 px above it.
    expect(stylesAt(1280).get('.log-wave tr:last-child > *')?.['padding-bottom']).toBe('0')
    expect(stylesAt(1280).get('.log-wave + .log-wave tr.grp > *')?.['padding-top']).toBe('8px')
    expect(stylesAt(375).get('.log-wave tr:last-child')?.['padding-bottom']).toBe('0')
    expect(stylesAt(375).get('.log-wave + .log-wave tr.grp')?.['padding-top']).toBe('8px')
    expect(stylesAt(375).get('.log-wave + .log-wave')?.['margin-top']).toBeUndefined()
    // Sprint > wave > slice: the sprint semibold, the wave regular and muted.
    expect(stylesAt(1280).get('.log-sprint-name')?.['font-weight']).toBe('600')
    expect(stylesAt(1280).get('.slice-log tr.grp th')?.['font-weight']).toBe('400')
    expect(stylesAt(1280).get('.slice-log tr.grp th')?.['color']).toBe('var(--muted)')
  })

  it('puts every status on one rail: a fixed-width, left-aligned column, the same in the sprint header and the tables', () => {
    const wide = stylesAt(1280)
    expect(wide.get('.slice-log')?.['table-layout']).toBe('fixed')
    // A fixed table's column width counts the cell's padding, so the cell adds its 16 px gap to the rail.
    expect(wide.get('.slice-log td:last-child')?.['width']).toBe('calc(var(--log-rail) + 16px)')
    expect(wide.get('.slice-log td:last-child')?.['padding-left']).toBe('16px')
    expect(wide.get('.slice-log td:last-child')?.['text-align']).toBe('left')
    // The rail holds a status only (dot and word), so it never wraps.
    expect(wide.get('.slice-log td:last-child')?.['white-space']).toBe('nowrap')
    expect(wide.get('.log-sprint')?.['grid-template-columns']).toBe('minmax(0, 1fr) var(--log-rail)')
    expect(wide.get('.log-sprint')?.['column-gap']).toBe('16px')
    // Wide enough for `● merged PR #1234` and `● needs you` on one line.
    expect(wide.get('.log-frame')?.['--log-rail']).toBe('176px')
    // Phones keep the status inline after the title.
    expect(stylesAt(375).get('.slice-log td:last-child')?.['width']).toBe('auto')
    expect(stylesAt(375).get('.log-sprint')?.['display']).toBe('flex')
  })

  it('shows confidence as a quiet tag after the title, not in the status column', () => {
    expect(stylesAt(1280).get('.slice-log .chip.tag')?.['margin-left']).toBe('8px')
  })

  it('on a phone a slice is one line: its figures follow the title after a middle dot', () => {
    const phone = stylesAt(375)
    expect(phone.get('.slice-log tr:not(.grp) td')?.['display']).toBe('inline')
    expect(phone.get('.slice-log tr:not(.grp) td:last-child:not(:empty)::before')?.['content']).toBe('" · "')
  })
})

/**
 * The CLAUDE.md Spacing rules on screen 1 and the sidebar: runs.css, the tabs and the ⋯ menu, and the
 * shared controls in base.css. The Add repo dialog's picker (picker.css) and screens 2 and 3 have their own files.
 */
describe('spacing scale', () => {
  const SCREEN_ONE = ['runs.css', 'tabs.css', 'menu.css', 'urgent-banner.css', '../../theme/base.css']
  const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?$/
  /**
   * Values off the 4 px scale on purpose, each with its reason. 2 px is the tight-row allowance: the
   * cells of the Log's 20 px rows, and a tag that has to fit inside one.
   */
  const ALLOWED: Record<string, string> = {
    '.sr-only margin -1px': 'the visually hidden pattern, not spacing',
    '.side-foot .add-repo padding-left 15px': 'Buttons rule: centred on the plus’s ink (runs-css pins it)',
    '.side-foot .add-repo padding-right 17px': 'Buttons rule: centred on the plus’s ink',
    '.btn.sm gap 6px': 'Buttons rule: 6–8 px of visible gap between icon and label',
    '.btn.lead gap 6px': 'Buttons rule',
    '.btn.trail gap 6px': 'Buttons rule',
    '.btn.sm.lead padding-left 10px': 'Buttons rule: the icon side 2 px less than the 12 px text side',
    '.btn.sm.trail padding-right 10px': 'Buttons rule',
    '.switch::after margin-top -6px': 'centres the 12 px knob on the track, not spacing',
    '.slice-log th padding 2px': 'tight row: the Log’s cell padding',
    '.slice-log td padding 2px': 'tight row',
    '.slice-log tr padding 2px': 'tight row (phones)',
    '.chip.tag padding 2px': 'a tag inside a 20 px Log row',
    '.reply-word padding 2px': 'a reply word tag inside its row',
  }
  const offScale = () => {
    const out: string[] = []
    for (const file of SCREEN_ONE) {
      for (const r of rules(stripComments(readFileSync(join(here, file), 'utf8')))) {
        for (const [prop, value] of Object.entries(decls(r.body))) {
          if (!SPACING.test(prop)) continue
          for (const m of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
            const n = Number(m[1])
            if (n % 4 === 0) continue
            for (const sel of r.selectors) if (!ALLOWED[`${sel} ${prop} ${m[1]}px`]) out.push(`${file} ${sel} ${prop}: ${value}`)
          }
        }
      }
    }
    return out
  }

  it('reads the rules inside @container blocks too', () => {
    // The urgent banner's narrow layout sits in @container blocks: the check must see its gap.
    const urgent = rules(stripComments(readFileSync(join(here, 'urgent-banner.css'), 'utf8')))
    expect(urgent.filter((r) => r.media?.startsWith('@container') && decls(r.body).gap !== undefined).map((r) => decls(r.body).gap)).toContain('8px 12px')
  })

  it('puts every gap, padding and margin on the 4 px scale, but for the listed exceptions', () => {
    expect(offScale()).toEqual([])
  })

  it('pads each box wider than tall, about 12 by 16', () => {
    const boxes: [string, number][] = [
      ['.run', 1280],
      ['.flow-step', 1280],
      ['.banner', 1280],
      ['.log-group', 1280],
      ['.other-list li', 1280],
      ['.flow-fold', 375],
    ]
    const menu = rules(stripComments(readFileSync(join(here, 'menu.css'), 'utf8')))
    const pads = boxes.map(([sel, width]) => [sel, stylesAt(width).get(sel)?.['padding'] ?? ''])
    pads.push(['.mi', decls(menu.find((r) => r.selectors.includes('.mi'))?.body ?? '')['padding'] ?? ''])
    for (const [sel, pad] of pads) {
      // Two values, vertical then horizontal, the horizontal one larger.
      const m = /^(\d+)px (\d+)px$/.exec(pad!)
      expect(m !== null && Number(m[2]) > Number(m[1]), `${sel} padding ${pad}`).toBe(true)
    }
    expect(stylesAt(1280).get('.run')?.['padding']).toBe('12px 16px')
    expect(stylesAt(1280).get('.flow-step')?.['padding']).toBe('12px 16px')
  })

  it('pads the Next step card and the in-place panels wider than tall', () => {
    const base = rules(stripComments(readFileSync(join(here, '../../theme/base.css'), 'utf8')))
    const at = (sel: string) => Object.assign({}, ...base.filter((r) => !r.media && r.selectors.includes(sel)).map((r) => decls(r.body)))
    expect(at('.card')['padding']).toBe('20px 24px')
    expect(at('.inplace')['padding']).toBe('12px 16px')
    expect(stylesAt(375).get('.card.next-step')?.['padding']).toBe('16px 20px')
  })

  it('keeps inside space at or below outside space', () => {
    const px = (v: string | undefined) => Number(/^(\d+)px/.exec(v ?? '')?.[1] ?? NaN)
    const at = stylesAt(1280)
    // A run card's name and its tag sit closer than the cards do.
    expect(px(at.get('.run-head')?.['gap'])).toBeLessThan(px(at.get('.run-list')?.['gap']))
    // A step card's title and detail sit closer than the cards do.
    expect(px(at.get('.flow-step')?.['gap'])).toBeLessThan(px(at.get('.flow')?.['row-gap']))
    // The title and its meta line sit closer than the header and the flow.
    expect(px(at.get('.run-sub')?.['margin-top'])).toBeLessThan(px(at.get('.run-header')?.['margin-bottom']))
    // A reply and its result sit closer than the replies do.
    expect(px(at.get('.reply-item')?.['gap'])).toBeLessThan(px(at.get('.reply-list')?.['gap']))
  })

  it('opens the ⋯ menu 8 px under its trigger', () => {
    const menu = rules(stripComments(readFileSync(join(here, 'menu.css'), 'utf8')))
    expect(menu.find((r) => r.selectors.includes('.bar-menu-panel'))?.body).toMatch(/top:\s*calc\(100% \+ 8px\)/)
  })
})
