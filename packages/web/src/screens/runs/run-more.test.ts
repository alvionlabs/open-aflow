import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Board, BoardRepo, RunSummary } from '@openaflow/model'
import { RunMoreMenuView } from './RunMoreMenu.tsx'
import { RunsList } from './RunsList.tsx'
import { moreButtonId } from './remove-flow.ts'
import { switchView } from './resume-flow.ts'

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
  const render = () =>
    renderToStaticMarkup(
      createElement(RunsList, {
        runs,
        selected: runs[0],
        repos,
        removable: (r: RunSummary) => r.repoId === 'ra',
        onRemove: noop,
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

  it('ends each card with its link and ⋯: the confirm is the screen modal, never a panel under the card', () => {
    for (const item of render().match(/<li class="run-item">[\s\S]*?<\/li>/g)!) expect(item).toMatch(/<\/div><\/li>$/)
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
    expect(listed({ repo: 'open_aflow' })).toContain('<span class="run-repo muted">open_<wbr/>aflow</span>')
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

describe("the card link's accessible name", () => {
  const link = (over: Partial<RunSummary>) => {
    const r = { ...run('ra', 'alpha-repo', 'x'), ...over }
    return /<a class="run"[^>]*>/.exec(renderToStaticMarkup(createElement(RunsList, { runs: [r], selected: r, repos: [repo({})] })))![0]
  }

  it('holds name, status, then repo as plain text, with no space after an underscore', () => {
    expect(link({ title: 'Three sprints in flight', repo: 'pod_trial_mock', state: 'blocked' })).toContain('aria-label="Three sprints in flight blocked pod_trial_mock"')
  })

  it('keeps an underscored name whole, and leaves out a repo line the card does not have', () => {
    const r = { repoId: 'ra', repo: 'internationalization_settings', where: '', state: 'unsupported' } as RunSummary
    const html = renderToStaticMarkup(createElement(RunsList, { runs: [r], selected: r, repos: [repo({ name: 'internationalization_settings' })] }))
    expect(html).toContain('aria-label="internationalization_settings update pod"')
    // The visual break stays.
    expect(html).toContain('internationalization_<wbr/>settings')
  })

  it('ends with the fix tag on a fix run, where the card shows it', () => {
    // With no PR on the Board, a fix run is named from its slug, as on the card.
    expect(link({ repo: 'chess-web', state: 'running', fix: 'list-timeouts' })).toContain('aria-label="List timeouts running chess-web fix"')
  })
})

describe('Auto-continue sign on a card', () => {
  const runs = [run('ra', 'alpha-repo', 'x'), run('ra', 'alpha-repo', 'y'), { repoId: 'ra', repo: 'alpha-repo', where: '', state: 'idle' } as RunSummary]
  const fix = { ...run('ra', 'alpha-repo', 'task-scroll'), fix: 'scroll', state: 'needs-you' } as RunSummary
  const board = { generatedAt: 0, gh: 'ok', repos: [repo({})], autoContinue: [{ repoId: 'ra', run: 'x' }, { repoId: 'ra', run: 'task-scroll' }] } as Board
  const items = (list: RunSummary[]) =>
    renderToStaticMarkup(createElement(RunsList, { runs: list, selected: list[0], repos: [repo({})], auto: (r: RunSummary) => switchView(r, board)?.on === true })).match(
      /<li class="run-item">[\s\S]*?<\/li>/g,
    )!
  const FF = '<path d="M2 3.5l5.5 4.5L2 12.5zM8.5 3.5L14 8l-5.5 4.5z"></path>'
  const SIGN = `<span class="run-auto" role="img" aria-label="Auto-continue on" title="Auto-continue on"><svg[^>]*>${FF.replace(/[.()]/g, (c) => `\\${c}`)}</svg></span>`

  it('an auto-continue run shows the fast-forward icon on the title row, named Auto-continue on, and no chip', () => {
    const [on] = items(runs)
    // Right after the name, before the status: the title row.
    expect(on).toMatch(new RegExp(`<b>x</b>${SIGN}<span class="status [^"]*">idle</span><span class="run-line">`))
    expect(on).not.toContain('chip tag">auto')
    expect(on).toContain('aria-label="x idle auto-continue on alpha-repo"')
    // The status line holds only the dot and the word: nothing follows the status before the repo line.
    expect(/<span class="status [^"]*">([\s\S]*?)<\/span>/.exec(on!)![1]).toBe('idle')
  })

  it('an off run and a repo row show no icon, and their names have no auto-continue', () => {
    const [, off, row] = items(runs)
    for (const item of [off!, row!]) {
      expect(item).not.toContain('run-auto')
      expect(item).not.toContain('>auto<')
      expect(/aria-label="([^"]*)"/.exec(item)![1]).not.toMatch(/\bauto/)
    }
  })

  it('a one-off run keeps its kind tag on the repo line, and the icon on the title row', () => {
    const [card] = items([fix])
    expect(card).toMatch(new RegExp(`</b>${SIGN}<span class="status [^"]*">needs you</span>`))
    expect(card).toMatch(/<span class="run-repo muted">alpha-repo<\/span><span class="chip tag">task<\/span>/)
    expect(card).toMatch(/aria-label="Scroll needs you auto-continue on alpha-repo task"/)
  })

  it('with no auto rule, no card has the icon', () => {
    const html = renderToStaticMarkup(createElement(RunsList, { runs, selected: runs[0], repos: [repo({})] }))
    expect(html).not.toContain('run-auto')
    expect(html).not.toContain('>auto<')
  })
})
