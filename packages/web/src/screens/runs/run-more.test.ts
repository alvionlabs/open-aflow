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
    expect(closed).toMatch(/<button[^>]*class="btn icon run-more"/)
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
    expect(items[0]).toMatch(/<a class="run"[^>]*>(?:(?!<button)[\s\S])*<\/a><div class="run-more-wrap">\s*<button/)
    expect(items[0]).toContain(`id="${moreButtonId(runs[0]!)}"`)
    expect(items[0]).toContain('aria-label="More for x (alpha-repo)"')
  })

  it('has no ⋯ for a run whose repo cannot be removed (claim-only or an ambiguous id)', () => {
    const items = render().match(/<li class="run-item">[\s\S]*?<\/li>/g)!
    expect(items[1]).not.toContain('run-more')
  })

  it('shows the confirm panel under the card it was opened from', () => {
    const items = render((r) => (r.plan === 'x' ? createElement('section', { className: 'inplace remove-confirm' }) : null)).match(/<li class="run-item">[\s\S]*?<\/li>/g)!
    expect(items[0]).toMatch(/<\/div><section class="inplace remove-confirm"><\/section><\/li>$/)
    expect(items[1]).not.toContain('remove-confirm')
  })
})
