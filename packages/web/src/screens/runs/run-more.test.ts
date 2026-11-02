import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BoardRepo, RunSummary } from '@pod-board/model'
import { RunMoreMenuView } from './RunMoreMenu.tsx'
import { RunsList } from './RunsList.tsx'
import { moreButtonId } from './remove-flow.ts'

const noop = () => {}
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

describe('sidebar run ⋯ menu', () => {
  const view = (open: boolean) =>
    renderToStaticMarkup(createElement(RunMoreMenuView, { open, onToggle: noop, onRemove: noop, runName: 'Sparring ladder', triggerId: 'run-more-#/ra/x' }))

  it('is an icon button named for the run, with its own id, that says whether it is open', () => {
    const closed = view(false)
    expect(closed).toMatch(/<button[^>]*id="run-more-#\/ra\/x"/)
    expect(closed).toMatch(/<button[^>]*aria-label="More for Sparring ladder"/)
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"/)
    expect(closed).toMatch(/<button[^>]*class="btn icon ghost run-more"/)
    expect(closed).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(text(closed)).not.toContain('⋯')
    expect(closed).not.toContain('Remove repo')
  })

  it('opens a group with the same danger Remove repo item as the header menu', () => {
    const open = view(true)
    expect(open).toMatch(/aria-expanded="true"/)
    expect(open).toMatch(/class="menu run-more-panel"[^>]*role="group"/)
    expect(open).toMatch(/<button type="button" class="mi mi-action mi-danger">Remove repo<\/button>/)
  })
})

const repo = (over: Partial<BoardRepo>): BoardRepo =>
  ({ id: 'ra', name: 'alpha-repo', path: 'C:/code/alpha-repo', source: 'registered', claims: [], model: { plans: [], queue: [] }, agents: [], prs: [], ...over }) as BoardRepo
const run = (repoId: string, name: string, plan: string): RunSummary => ({ repoId, repo: name, plan, title: plan, where: '', state: 'idle' }) as RunSummary

describe('runs list with the ⋯ button', () => {
  const runs = [run('ra', 'alpha-repo', 'x'), run('rc', 'claimed', 'y')]
  const repos = [repo({}), repo({ id: 'rc', name: 'claimed', path: 'C:/code/claimed', source: 'claim' })]
  const render = (panelFor?: (r: RunSummary) => unknown) =>
    renderToStaticMarkup(
      createElement(RunsList, {
        runs,
        selected: runs[0],
        repos,
        removable: (r: RunSummary) => r.repoId === 'ra',
        onRemove: noop,
        ...(panelFor ? { panelFor: panelFor as never } : {}),
      }),
    )

  it('puts the ⋯ beside the card link, never inside it', () => {
    const html = render()
    const items = html.match(/<li class="run-item">[\s\S]*?<\/li>/g)!
    expect(items).toHaveLength(2)
    // The link closes before the button opens: no button nested in the link.
    expect(items[0]).toMatch(/<div class="run-wrap"><a class="run"[^>]*>(?:(?!<button)[\s\S])*<\/a><div class="run-more-wrap">\s*<button/)
    expect(items[0]).toContain(`id="${moreButtonId(runs[0]!)}"`)
    expect(items[0]).toContain('aria-label="More for x (alpha-repo)"')
  })

  it('has no ⋯ for a run whose repo cannot be removed (claim-only or an ambiguous id)', () => {
    const items = render().match(/<li class="run-item">[\s\S]*?<\/li>/g)!
    expect(items[1]).not.toContain('run-more')
  })

  it('shows the confirm panel under the card it was opened from', () => {
    const items = render((r) => (r.plan === 'x' ? createElement('section', { className: 'inplace remove-confirm' }) : null)).match(/<li class="run-item">[\s\S]*?<\/li>/g)!
    expect(items[0]).toMatch(/<\/div><\/div><section class="inplace remove-confirm"><\/section><\/li>$/)
    expect(items[1]).not.toContain('remove-confirm')
  })
})

describe('run name in the list', () => {
  const nameOf = (title: string) => {
    const r = { ...run('ra', 'alpha-repo', 'x'), title }
    const html = renderToStaticMarkup(createElement(RunsList, { runs: [r], selected: r, repos: [repo({})] }))
    return /<b>([\s\S]*?)<\/b>/.exec(html)![1]
  }

  it('keeps a hyphenated word whole, since a hyphen is a line break opportunity', () => {
    expect(nameOf('claim-only run')).toBe('<span class="run-word">claim-only</span> run')
    expect(nameOf('a fix-sprint-column b-c')).toBe('a <span class="run-word">fix-sprint-column</span> <span class="run-word">b-c</span>')
  })

  it('leaves a name with no hyphen as plain text', () => {
    expect(nameOf('Three sprints in flight')).toBe('Three sprints in flight')
  })
})

describe('sidebar card wording', () => {
  it('the list comment says dot then word, as the card shows it', () => {
    expect(readFileSync(new URL('./RunsList.tsx', import.meta.url), 'utf8')).toMatch(/its state as a dot and a word/)
  })

  it('leaves a long word with no separator as plain text, for the card to fit whole', () => {
    for (const title of ['authentication', 'skyscraperviewpanel']) {
      const r = { ...run('ra', 'alpha-repo', 'x'), title }
      const html = renderToStaticMarkup(createElement(RunsList, { runs: [r], selected: r, repos: [repo({})] }))
      expect(html).toContain(`<b>${title}</b>`)
    }
  })
})

describe('underscores in the sidebar card', () => {
  const listed = (over: Partial<RunSummary>) => {
    const r = { ...run('ra', 'alpha-repo', 'x'), ...over }
    return renderToStaticMarkup(createElement(RunsList, { runs: [r], selected: r, repos: [repo({})] }))
  }

  it('gives a name word a line break opportunity after each underscore, and keeps it in its own box', () => {
    const html = listed({ title: 'internationalization_settings run' })
    expect(/<b>([\s\S]*?)<\/b>/.exec(html)![1]).toBe('<span class="run-word">internationalization_<wbr/>settings</span> run')
  })

  it('does the same on the repo line, whose text stays the same', () => {
    expect(listed({ repo: 'pod_board' })).toContain('<span class="run-repo muted">pod_<wbr/>board</span>')
    expect(listed({ repo: 'chess-web' })).toContain('<span class="run-repo muted">chess-web</span>')
  })
})

describe('a card with no repo line', () => {
  it('renders an empty second line, for the card to hide or keep by its layout', () => {
    const r = { repoId: 'ra', repo: 'alpha-repo', where: '', state: 'idle' } as RunSummary
    const html = renderToStaticMarkup(createElement(RunsList, { runs: [r], selected: r, repos: [repo({})] }))
    expect(html).toContain('<span class="run-line"></span>')
  })
})
