import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BarMenuView } from './BarMenu.tsx'

const noop = () => {}
const store = (value?: string) => ({ getItem: () => value ?? null, setItem: noop })
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BarMenuView, { open: true, onToggle: noop, onThemePick: noop, ...props }))
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const target = { repoId: 'r1', run: 'alpha' }

describe('menu contents', () => {
  it('has an icon trigger named Menu that says whether the menu is open', () => {
    const open = render({ open: true })
    expect(open).toMatch(/<button[^>]*aria-label="Menu"/)
    expect(open).toMatch(/aria-expanded="true"/)
    expect(open).toContain('class="btn sm icon ghost"')
    expect(open).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(text(open)).not.toContain('⋯')
    expect(render({ open: false })).toMatch(/aria-expanded="false"/)
  })

  it('renders no menu while closed', () => {
    expect(render({ open: false })).not.toContain('aria-label="Theme"')
  })

  it('is a group, not role="menu"', () => {
    const html = render({})
    expect(html).not.toContain('role="menu"')
    expect(html).toMatch(/class="menu[ "][^>]*role="group"/)
  })

  it('has no Auto-continue switch: the run header holds the one control', () => {
    for (const on of [true, false]) {
      const html = render({ autoContinue: { target, on }, portBase: 3100 })
      expect(html).not.toContain('role="switch"')
      expect(text(html)).not.toContain('Auto-continue')
    }
  })

  it('has the ports only with portBase', () => {
    expect(text(render({}))).not.toContain('Ports')
    expect(text(render({ portBase: 3100 }))).toContain('Ports 3100')
  })

  it('lists the theme buttons in order System, Dark, Light', () => {
    const html = render({ storage: store('light') })
    const labels = [...html.matchAll(/<button[^>]*aria-pressed="(?:true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(labels).toEqual(['System', 'Dark', 'Light'])
  })

  it('marks the stored choice pressed, and Dark when nothing is stored', () => {
    const pressed = (html: string) => [...html.matchAll(/aria-pressed="true"[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(pressed(render({ storage: store('light') }))).toEqual(['Light'])
    expect(pressed(render({ storage: store('system') }))).toEqual(['System'])
    expect(pressed(render({ storage: store() }))).toEqual(['Dark'])
    expect(pressed(render({ storage: store('bogus') }))).toEqual(['Dark'])
  })
})

describe('Remove repo item', () => {
  it('shows only with remove, as a danger button that reads Remove repo, last in the menu', () => {
    expect(render({})).not.toContain('Remove repo')
    const html = render({ remove: { onPick: noop }, portBase: 3100 })
    expect(html).toMatch(/<button type="button" class="mi mi-action mi-danger">Remove repo<\/button>/)
    expect(html.indexOf('Ports')).toBeLessThan(html.indexOf('Remove repo'))
    expect(text(html)).not.toMatch(/[⋯+]/)
  })

  it('gives the trigger a stable id, so focus can come back to it after the confirm closes', () => {
    expect(render({ open: false })).toMatch(/<button[^>]*id="run-menu-trigger"/)
  })
})

describe('Forget item', () => {
  it('shows only with forget, as a danger item that reads Forget this run, right above Remove repo', () => {
    expect(render({ remove: { onPick: noop } })).not.toContain('Forget this run')
    const html = render({ forget: { onPick: noop }, remove: { onPick: noop }, portBase: 3400 })
    expect(html).toMatch(/<button type="button" class="mi mi-action mi-danger">Forget this run<\/button><button type="button" class="mi mi-action mi-danger">Remove repo<\/button>/)
    expect(html.indexOf('Ports')).toBeLessThan(html.indexOf('Forget this run'))
  })

  it('shows alone, after a rule, for a repo only its claim lists (no Remove repo)', () => {
    const html = render({ forget: { onPick: noop }, portBase: 3400 })
    expect(html).toMatch(/<hr\/><button type="button" class="mi mi-action mi-danger">Forget this run<\/button><\/div>/)
    expect(html).not.toContain('Remove repo')
  })
})
