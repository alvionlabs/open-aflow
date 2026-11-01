import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunSummary } from '@pod-board/model'
import type { Elsewhere } from './elsewhere.ts'
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

describe('urgent banner', () => {
  it('renders the item, its run and the count', () => {
    const h = html(at({ more: 2 }))
    expect(h).toMatch(/^<div class="urgent">/)
    expect(h).toMatch(/<span class="status s-bad">Blocked<\/span>/)
    expect(text(h)).toBe('Blocked Autopilot stopped: a slice is blocked · chess-web · Sparring ladder +2 more Open run')
    expect(h).toMatch(/class="urgent-title">Autopilot stopped: a slice is blocked</)
    expect(h).toMatch(/class="urgent-where muted">· chess-web · Sparring ladder</)
    expect(h).toMatch(/class="urgent-more muted">\+2 more</)
    // No count at 0.
    const none = html(at())
    expect(none).not.toMatch(/urgent-more|more</)
    expect(text(none)).toBe('Blocked Autopilot stopped: a slice is blocked · chess-web · Sparring ladder Open run')
    // A repo row: its name only.
    const row = html(at({ name: 'chess-web', repo: undefined }))
    expect(row).toMatch(/class="urgent-where muted">· chess-web</)
    // Other statuses take their own class.
    expect(html(at({ item: { ...item, tier: 'merge', status: 'needs-you', title: 'Merge PR #78' } }))).toMatch(/<span class="status s-you">Needs you<\/span>/)
    expect(html(at({ item: { ...item, tier: 'reply', status: 'ready', title: 'Send continue' } }))).toMatch(/<span class="status s-ok">Ready<\/span>/)
    // A title link reads as text only: the one link is Open run.
    const linked = html(at({ item: { ...item, title: 'Autopilot held PR #80 for you to merge', titleLink: { text: 'PR #80', href: 'https://github.com/o/r/pull/80' } } }))
    expect(linked.match(/<a /g)).toHaveLength(1)
    expect(linked).not.toMatch(/github\.com/)
    expect(text(linked)).toMatch(/Autopilot held PR #80 for you to merge/)
  })

  it('open run is a named secondary link', () => {
    const a = openOf(html(at()))
    expect(a).toMatch(/href="#\/chess\/sparring-ladder"/)
    expect(a).toMatch(/aria-label="Open run Sparring ladder"/)
    expect(a).toMatch(/class="btn sm trail urgent-open"/)
    expect(a).not.toMatch(/primary/)
    // The shared arrow-right icon, after the label.
    expect(a).toMatch(/>Open run<svg[^>]*aria-hidden="true"[^>]*><path d="M3 8h9.5M8 3.5L12.5 8 8 12.5"/)
    expect(text(a)).toBe('Open run')
    expect(a).not.toMatch(/[→›»↗+]|&gt;/)
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
const CSS = readFileSync(join(here, 'urgent-banner.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const all = rules(CSS)
const styleOf = (sel: string, match: (media?: string) => boolean) =>
  Object.assign({}, ...all.filter((r) => match(r.media) && r.selectors.includes(sel)).map((r) => decls(r.body))) as Record<string, string>
const desktop = (m?: string) => m === undefined
const phone = (m?: string) => m !== undefined && /^\(\s*max-width:\s*480px\s*\)$/.test(m)

describe('urgent banner css', () => {
  it('css tokens, radius and phone button', () => {
    // Only the Look's tokens (and the type and radius scale), no raw colours.
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|color-mix)\(|\b(red|orange|green|white|black)\b/i)
    const used = new Set([...CSS.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]))
    const allowed = new Set(['--border-strong', '--bg', '--fg', '--muted', '--font', '--mono', '--size-dense', '--size-small', '--size-micro', '--radius-md'])
    expect([...used].filter((t) => !allowed.has(t!))).toEqual([])
    // No status colour anywhere: the dot takes it from .status.
    expect(CSS).not.toMatch(/--(blocked|needs-you|ready|running|idle|focus)\b/)
    const box = styleOf('.urgent', desktop)
    expect(box.border).toBe('1px solid var(--border-strong)')
    expect(box.background).toBe('var(--bg)')
    expect(['8px', 'var(--radius-md)']).toContain(box['border-radius'])
    // Every background and border in the file is the box's own.
    for (const r of all) {
      const d = decls(r.body)
      for (const [p, v] of Object.entries(d)) {
        if (/^background/.test(p)) expect(v, `${r.selectors.join(',')} ${p}`).toBe('var(--bg)')
        if (/^border(-(top|right|bottom|left))?(-color)?$/.test(p)) expect(v, `${r.selectors.join(',')} ${p}`).toMatch(/var\(--border-strong\)/)
      }
    }
    // An empty slot takes no space.
    const slot = Object.assign({}, ...all.filter((r) => r.selectors.includes('.urgent-slot')).map((r) => decls(r.body))) as Record<string, string>
    for (const p of Object.keys(slot)) expect(p, `.urgent-slot ${p}`).not.toMatch(/^(padding|margin|border|gap|row-gap|column-gap|min-height|height)/)
    // Desktop: one line, the title ends in an ellipsis.
    const title = styleOf('.urgent-title', desktop)
    expect(title['text-overflow']).toBe('ellipsis')
    expect(title['white-space']).toBe('nowrap')
    // Phone: the text wraps, the button is full width and at least 44 px tall.
    expect(styleOf('.urgent', phone)['flex-wrap']).toBe('wrap')
    expect(styleOf('.urgent-title', phone)['white-space']).toBe('normal')
    const btn = styleOf('.urgent-open', phone)
    expect(btn.width).toBe('100%')
    expect(Number(/^(\d+)px$/.exec(btn['min-height'] ?? '')?.[1] ?? 0)).toBeGreaterThanOrEqual(44)
  })
})
