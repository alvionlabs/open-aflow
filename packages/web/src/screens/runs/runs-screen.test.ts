import { describe, expect, it } from 'vitest'
import { buildRepoModel, listRuns, type Board, type BoardRepo, type Claim, type PrStatus, type RunSummary } from '@pod-board/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadFixture } from '../../../../model/test/load-fixture.ts'
import type { StreamState } from '../../board-stream.ts'
import { hashFor, type View } from '../../selection.ts'
import { RunsScreen } from './RunsScreen.tsx'
import type { TabStorage } from './tab-memory.ts'

// chess-web as in next-step.test.ts: plan sparring-ladder on wave 3 of sprint ladder, three PENDING entries for you.
const NOW = Date.UTC(2026, 9, 20, 12)
const PLAN = 'sparring-ladder'
const QUEUE = 'pod-docs/handoff-queue.md'
const LADDER = 'pod-docs/sprints/ladder.md'

type Files = Record<string, string>
type Edit = (files: Files) => void

const entry = (type: string, route: string, fields: string, body: string) => `- \`[2026-10-19 · ${type} · ${route}${fields ? ` · ${fields}` : ''}]\` ${body} **Resolution:** pending`
// An autopilot halt: the run stops, so its wave PR waits on you, and the halted plan shows no reply.
const HALT = entry('BLOCKED', 'orchestrator → human', `plan: ${PLAN}`, 'Gate 1: T1 is blocked, the rates file is missing.')

const onlyQueue = (...lines: string[]): Edit => (f) => {
  f[QUEUE] = ['# Handoff Queue', '', ...lines, ''].join('\n')
}
const manual: Edit = (f) => {
  for (const doc of ['pod-docs/plans/sparring-ladder.md', LADDER]) f[doc] = f[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
}
const t1Pushed: Edit = (f) => {
  f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', '| ladder-T1 | #78 | pushed | medium |')
}
/** Three sprints: `warmup` done (two merged waves), `ladder` current as in the fixture, `rematch` named but not drafted. */
const threeSprints: Edit = (f) => {
  const plan = 'pod-docs/plans/sparring-ladder.md'
  f[plan] = f[plan]!.replace(/^(\| ladder \|.*\| active \| )— \|$/m, (_row, head: string) =>
    ['| warmup | Warm up | done | — |', `${head}warmup |`, '| rematch | Rematch | planned | ladder |'].join('\n'),
  )
  f['pod-docs/sprints/warmup.md'] = [
    '# Sprint: Warm up',
    '',
    '_From plan: pod-docs/plans/sparring-ladder.md · Slug: warmup · Status: done · Generated: 2026-10-17_',
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    '| 1 | A1 | First | warmup-A1 | #70 | merged | high | — |',
    '| 2 | B1 | Second | warmup-B1 | #71 | merged | high | A1 |',
    '',
  ].join('\n')
}
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })

function chess(edits: Edit[] = [], extra: Partial<BoardRepo> = {}): BoardRepo {
  const files = loadFixture('chess-web')
  for (const e of edits) e(files)
  return { id: 'chess', name: 'chess-web', path: '/c', source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}
const boardOf = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos, actions: [] })

/** A tab store holding `value`; writes are kept so a test could read them. */
function storage(value: string | null = null): TabStorage {
  let v = value
  return {
    getItem: () => v,
    setItem: (_k, x) => {
      v = x
    },
    removeItem: () => {
      v = null
    },
  }
}

type Render = { repo: BoardRepo; others?: BoardRepo[]; run?: RunSummary; plan?: string; view?: View; stream?: StreamState; tab?: string | null; agent?: string }

/** The screen's markup for a Board of `repo` (then `others`), the run of `repo` picked by plan (or given). */
function render({ repo, others = [], run, plan = PLAN, view = 'pipeline', stream = 'live', tab = null, agent }: Render): { html: string; run: RunSummary } {
  const board = boardOf(repo, ...others)
  const runs = listRuns(board, NOW)
  const selected = run ?? runs.find((r) => r.repoId === repo.id && r.plan === plan)
  if (!selected) throw new Error(`no run ${plan}`)
  const html = renderToStaticMarkup(
    createElement(RunsScreen, { board, stream, runs, selected, view, slice: undefined, agent, now: NOW, storage: storage(tab) }),
  )
  return { html, run: selected }
}

/** The Next step card's own markup. */
function cardOf(html: string): string {
  const m = /<section class="card[^"]*next-step[^"]*"[\s\S]*?<\/section>/.exec(html)
  expect(m, 'the Next step card').not.toBeNull()
  return m![0]
}
const text = (html: string) => html.replace(/<[^>]*>/g, ' ')
const count = (html: string, re: RegExp) => [...html.matchAll(new RegExp(re.source, 'g'))].length
/** Each tab button's label and its aria-expanded. */
function tabsOf(html: string): { label: string; expanded: string }[] {
  return [...html.matchAll(/<button[^>]*class="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({
    label: text(m[1]!).replace(/\s+/g, ' ').trim(),
    expanded: /aria-expanded="(true|false)"/.exec(m[0])?.[1] ?? '',
  }))
}

describe('runs screen', () => {
  it('card then closed tabs', () => {
    const { html } = render({ repo: chess([onlyQueue(), manual, t1Pushed], { prs: [gh(78, 'open')] }) })
    const card = cardOf(html)
    // The card: Merge as its one primary button, the only primary button on the page.
    expect(count(html, /class="btn primary[^"]*"/)).toBe(1)
    expect(card).toMatch(/<button[^>]*class="btn primary"[^>]*>Merge<\/button>/)
    expect(card).toMatch(/id="merge-pr-78"/)
    expect(text(card)).toMatch(/Merge PR #78/)
    expect(text(card)).toMatch(/Needs you/)
    // The header (with its progress strip and wave), then the flow, then the card.
    expect(html.indexOf('run-header')).toBeGreaterThan(-1)
    expect(html.indexOf('run-header')).toBeLessThan(html.indexOf('aria-label="Run flow"'))
    expect(html.indexOf('aria-label="Run flow"')).toBeLessThan(html.indexOf('next-step'))
    expect(headerOf(html)).toMatch(/class="strip" role="img" aria-label="\d+ of \d+ steps done"/)
    expect(text(headerOf(html))).toMatch(/Wave 3 of 3/)
    // Tabs follow the card, all closed, with no panel. The flow replaced the Plan tab.
    expect(html.indexOf('class="tabs"')).toBeGreaterThan(html.indexOf('next-step'))
    const tabs = tabsOf(html)
    expect(tabs.map((t) => t.label.replace(/ \d+$/, ''))).toEqual(['Waiting', 'Log'])
    expect(tabs.every((t) => t.expanded === 'false')).toBe(true)
    expect(html).not.toMatch(/tab-panel/)
    // No `live` chip anywhere, and no top bar.
    expect(text(html)).not.toMatch(/\blive\b/i)
    expect(html).not.toMatch(/class="bar"/)
    // The old views are gone.
    // (The header's short wave board link says "Wave board"; the old Wave board tab is gone from the tabs.)
    expect(text(html)).not.toMatch(/Waiting on you|Add a repo/)
    expect(tabsOf(html).some((t) => /Wave board/.test(t.label))).toBe(false)
  })

  it('shows the connection status only while lost', () => {
    const repo = chess([onlyQueue()])
    expect(text(render({ repo, stream: 'lost' }).html)).toMatch(/lost · retrying/)
    expect(text(render({ repo, stream: 'connecting' }).html)).not.toMatch(/connecting|retrying/)
  })

  it('blocked first, rest counted', () => {
    const { html } = render({ repo: chess([onlyQueue(HALT), t1Pushed], { prs: [gh(78, 'open')] }) })
    const card = cardOf(html)
    expect(card).toMatch(/<button[^>]*class="btn primary"[^>]*>Answer<\/button>/)
    expect(card).not.toMatch(/>Merge</)
    expect(text(card)).toMatch(/Blocked/)
    // The PR is the one other item.
    expect(tabsOf(html)[0]!.label).toBe('Waiting 1')
  })

  it('nothing to do', () => {
    const { html } = render({ repo: chess([onlyQueue()]) })
    const card = cardOf(html)
    expect(card).toMatch(/^<section class="card calm next-step"/)
    expect(text(card)).toMatch(/Nothing to do/)
    expect(card).not.toMatch(/<button/)
    expect(tabsOf(html)[0]!.label).toBe('Waiting 0')
  })

  it('remembered tab', () => {
    // A `plan` stored before the Plan tab went away opens nothing.
    const plan = render({ repo: chess([onlyQueue()]), tab: 'plan' })
    expect(tabsOf(plan.html).map((t) => t.label.replace(/ \d+$/, ''))).toEqual(['Waiting', 'Log'])
    expect(tabsOf(plan.html).every((t) => t.expanded === 'false')).toBe(true)
    expect(plan.html).not.toMatch(/tab-slot|tab-panel/)
    // A stored waiting tab opens the Waiting panel.
    expect(render({ repo: chess([onlyQueue()]), tab: 'waiting' }).html).toMatch(/waiting-tab/)

    // A plan-less row: the same two tabs, no flow, and the stored plan shows nothing.
    const row: RunSummary = { repoId: 'chess', repo: 'chess-web', where: 'no active plan', state: 'idle' }
    const bare = render({ repo: chess(), run: row, tab: 'plan' })
    expect(tabsOf(bare.html).map((t) => t.label.replace(/ \d+$/, ''))).toEqual(['Waiting', 'Log'])
    expect(bare.html).not.toMatch(/tab-panel/)
    expect(bare.html).not.toMatch(/aria-label="Run flow"/)

    // The agent view shows Log, whatever is stored.
    const name = 'fix-scroll'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const fix = render({ repo: chess([], { claims: [claim] }), plan: name, view: 'agent', agent: 'f1', tab: 'plan' })
    expect(tabsOf(fix.html).find((t) => t.label === 'Log')?.expanded).toBe('true')
    expect(fix.html).toMatch(/log-tab/)
    expect(tabsOf(fix.html).map((t) => t.label.replace(/ \d+$/, ''))).toEqual(['Waiting', 'Log'])
  })

  it('wave board view', () => {
    const { html, run } = render({ repo: chess(), view: 'board', tab: 'log' })
    expect(html).toMatch(/class="wave-board"/)
    expect(html).toMatch(new RegExp(`<a[^>]*href="${hashFor(run).replace(/[/#]/g, (c) => `\\${c}`)}"[^>]*>Back to the run</a>`))
    expect(html).toMatch(/run-header/)
    expect(html).not.toMatch(/next-step/)
    expect(html).not.toMatch(/class="tabs"/)
    expect(html).not.toMatch(/tab-panel/)
  })
})

/** The flow's own markup: its columns' captions, and each step card's class and text. */
function flowOf(html: string): { markup: string; captions: string[]; cards: { cls: string; markup: string; text: string }[] } {
  const m = /<section[^>]*aria-label="Run flow"[\s\S]*?<\/section>/.exec(html)
  expect(m, 'the flow').not.toBeNull()
  const markup = m![0]
  const captions = [...markup.matchAll(/<h2 class="flow-cap">([\s\S]*?)<\/h2>/g)].map((x) => text(x[1]!).trim())
  const cards = [...markup.matchAll(/<li class="(flow-step[^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].map((x) => ({
    cls: x[1]!,
    markup: x[2]!,
    text: text(x[2]!).replace(/\s+/g, ' ').trim(),
  }))
  return { markup, captions, cards }
}

describe('run flow', () => {
  it('shows the plan as columns of step cards with arrows between them', () => {
    // /pod:code run, T1 pushed and PR #78 open: wave 3 is handed back to you.
    const { html, run } = render({ repo: chess([onlyQueue(), manual, t1Pushed], { prs: [gh(78, 'open')] }) })
    const flow = flowOf(html)
    expect(flow.captions).toEqual(['Think', 'You', 'Sprint 1 of 1', 'Check', 'Ship'])
    // No arrow icons: an SVG layer draws the path between the cards (filled in from the page's layout).
    expect(flow.markup).not.toMatch(/flow-arrow/)
    expect(flow.markup).toMatch(/<svg class="flow-lines" aria-hidden="true"/)
    // A grid: one row of headings, then row i holds every column's i-th card (3 at most here: the sprint's waves).
    expect(flow.markup).toMatch(/<div class="flow" style="--flow-cols:5;--flow-rows:3">/)
    const labels = ['Research', 'Plan interview', 'Look picked', 'Replied go', 'Wave 1', 'Wave 2', 'Wave 3', 'Final review', 'Fix pass', 'Final PR']
    expect(flow.cards).toHaveLength(labels.length)
    flow.cards.forEach((c, i) => expect(c.text.startsWith(labels[i]!), c.text).toBe(true))
    // Each card: its label, its muted detail line, an SVG mark, and its state word for screen readers.
    expect(flow.cards[6]!.markup).toMatch(/<span class="flow-detail">PR #78 · you merge<\/span>/)
    for (const c of flow.cards) {
      expect(c.markup, c.text).toMatch(/<span class="flow-mark"[^>]*><svg/)
      expect(c.markup, c.text).toMatch(/<span class="sr-only">/)
    }
    expect(text(flow.markup)).not.toMatch(/[✓●○→•]/)
    // The step that needs you has the highlighted border; waiting ones are dim; done ones neither.
    const wave3 = flow.cards[6]!
    expect(wave3.cls).toMatch(/\byou\b/)
    expect(wave3.cls).toMatch(/\bhi\b/)
    expect(wave3.text).toMatch(/needs you/)
    const review = flow.cards[7]!
    expect(review.cls).toMatch(/\bdim\b/)
    expect(review.cls).not.toMatch(/\bhi\b/)
    // Plan interview is done: neither. Research (no report in the fixture) is skipped: dim.
    expect(flow.cards[1]!.cls).not.toMatch(/\b(hi|dim)\b/)
    expect(flow.cards[0]!.cls).toMatch(/\bskipped\b.*\bdim\b/)
    // No Merge in the flow: the Next step card holds the one Merge for this PR.
    expect(flow.markup).not.toMatch(/>Merge<|merge-pr-/)
    expect(count(flow.markup, /<button/)).toBe(1)
    expect(count(html, /id="merge-pr-78"/)).toBe(1)
    // The fold line for phones: the current step, with its mark, closed at start.
    expect(flow.markup).toMatch(/<button[^>]*class="flow-fold"[^>]*aria-expanded="false"[^>]*>[\s\S]*?<svg[\s\S]*?Wave 3 · PR #78 · you merge[\s\S]*?<\/button>/)
    expect(flow.markup).not.toMatch(/class="flow-frame open"/)
    // The wave board link sits in the run header, before the ⋯ menu; not in the flow.
    expect(flow.markup).not.toMatch(/Open the wave board/)
    const header = headerOf(html)
    const link = new RegExp(`<a[^>]*class="btn sm quiet board-link"[^>]*href="${hashFor(run, 'board').replace(/[/#]/g, (c) => `\\${c}`)}"[^>]*>([\\s\\S]*?)</a>`).exec(header)
    expect(link, 'the board link').not.toBeNull()
    // The full label on desktop; a short one on phones, so the plan name keeps one line beside the menu.
    expect(link![0]).toMatch(/aria-label="Open the wave board"/)
    expect(link![1]).toBe('<span class="board-link-long">Open the wave board</span><span class="board-link-short">Wave board</span>')
    expect(header.indexOf('board-link')).toBeLessThan(header.indexOf('aria-label="Menu"'))
  })

  it('several sprints stack in one Sprint column: five columns whatever the sprint count', () => {
    const flow = flowOf(render({ repo: chess([onlyQueue(), threeSprints]) }).html)
    expect(flow.captions).toEqual(['Think', 'You', 'Sprint 2 of 3', 'Check', 'Ship'])
    // The Sprint column is the tallest: warmup, three waves, rematch.
    expect(flow.markup).toMatch(/<div class="flow" style="--flow-cols:5;--flow-rows:5">/)
    const labels = ['Research', 'Plan interview', 'Look picked', 'warmup', 'Wave 1', 'Wave 2', 'Wave 3', 'rematch', 'Final review', 'Fix pass', 'Final PR']
    expect(flow.cards).toHaveLength(labels.length)
    flow.cards.forEach((c, i) => expect(c.text.startsWith(labels[i]!), c.text).toBe(true))
    // The finished sprint folds to one done card; the future one is one dim waiting card.
    expect(flow.cards[3]!.cls).toMatch(/\bdone\b/)
    expect(flow.cards[3]!.text).toMatch(/2 waves/)
    expect(flow.cards[7]!.cls).toMatch(/\bwait\b.*\bdim\b/)
  })

  it('an autopilot run has no Go card; its wave runs (highlighted) only while its own engineer works', () => {
    const flow = flowOf(render({ repo: chess([onlyQueue()]) }).html)
    expect(flow.captions).toEqual(['Think', 'You', 'Sprint 1 of 1', 'Check', 'Ship'])
    expect(flow.cards.some((c) => c.text.startsWith('Replied go'))).toBe(false)
    // Nothing runs and nothing asks: the wave in progress waits, dim.
    const idle = flow.cards.find((c) => c.text.startsWith('Wave 3'))!
    expect(idle.cls).toMatch(/\bwait\b.*\bdim\b/)
    expect(idle.text).toMatch(/waiting/)
    // Autopilot merging T1's pushed PR #78: the run is running, so is the wave (highlighted), with no engineer.
    const merging = flowOf(render({ repo: chess([onlyQueue(), t1Pushed]) }).html).cards.find((c) => c.text.startsWith('Wave 3'))!
    expect(merging.cls).toMatch(/\blive\b/)
    expect(merging.cls).toMatch(/\bhi\b/)
    expect(merging.text).toMatch(/running/)
    // T1's engineer at work: running, highlighted.
    const engineer = { id: 'e1', session: 's', type: 'pod:engineer', tokens: 0, ended: false, sprint: 'ladder', slice: 'T1', startedAt: NOW - 10 * 60_000, lastAt: NOW - 60_000 }
    const busy = flowOf(render({ repo: chess([onlyQueue()], { agents: [engineer] }) }).html).cards.find((c) => c.text.startsWith('Wave 3'))!
    expect(busy.cls).toMatch(/\blive\b/)
    expect(busy.cls).toMatch(/\bhi\b/)
    expect(busy.text).toMatch(/running/)
  })

  it('a fix run shows Build, Review and Ship, with no wave board link', () => {
    const name = 'fix-scroll'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const { html } = render({ repo: chess([], { claims: [claim] }), plan: name })
    const flow = flowOf(html)
    expect(flow.captions).toEqual(['Build', 'Review', 'Ship'])
    expect(flow.markup).not.toMatch(/flow-arrow/)
    expect(flow.markup).toMatch(/<div class="flow" style="--flow-cols:3;--flow-rows:2">/)
    expect(flow.markup).not.toMatch(/Open the wave board/)
    expect(headerOf(html)).not.toMatch(/Open the wave board/)
    // A fix run folds too: its first waiting step.
    expect(flow.markup).toMatch(/class="flow-fold"[\s\S]*?Engineer · not started/)
    expect(html.indexOf('aria-label="Run flow"')).toBeLessThan(html.indexOf('next-step'))
  })

  it('stays off the wave board view', () => {
    const { html } = render({ repo: chess(), view: 'board' })
    expect(html).not.toMatch(/aria-label="Run flow"/)
    // The board view has Back to the run, not a link to itself.
    expect(headerOf(html)).not.toMatch(/Open the wave board/)
  })

  it('an autopilot gate halt reads as a plain sentence with its PR as a link', () => {
    const url = 'https://github.com/iamphduc/pod-trial/pull/9'
    const halt = entry('BLOCKED', 'orchestrator → human', `plan: ${PLAN}`, `gate 3 auto-merge-fail: wave PR ${url} has no passing CI`)
    const { html } = render({ repo: chess([onlyQueue(halt)]) })
    const card = cardOf(html)
    expect(card).toMatch(new RegExp(`<h2[^>]*class="next-title"[^>]*>Autopilot stopped: wave <a href="${url.replace(/[/.]/g, (c) => `\\${c}`)}">PR #9</a> couldn&#x27;t merge</h2>`))
    expect(text(card)).not.toMatch(/auto-merge-fail/)
  })
})

/** The sidebar's own markup. */
function sideOf(html: string): string {
  const m = /<aside class="side"[\s\S]*?<\/aside>/.exec(html)
  expect(m, 'the sidebar').not.toBeNull()
  return m![0]
}
const headerOf = (html: string) => /<header class="run-header"[\s\S]*?<\/header>/.exec(html)?.[0] ?? ''

describe('sidebar', () => {
  const ADD = /<button[^>]*class="btn lead add-repo"[^>]*>[\s\S]*?<svg[\s\S]*?<\/svg>Add repo<\/button>/

  it('runs top to bottom: title, runs head, runs list, Add repo', () => {
    const { html } = render({ repo: chess([onlyQueue()]) })
    const side = sideOf(html)
    const at = (needle: string) => side.indexOf(needle)
    expect(at('Pod Board')).toBeGreaterThan(-1)
    // Just "Runs": the cards already show each run's state, so no `· N active` count.
    expect(side).toMatch(/<span class="eyebrow runs-head">Runs<\/span>/)
    expect(text(side)).not.toMatch(/active/)
    expect(at('runs-head')).toBeGreaterThan(at('Pod Board'))
    expect(at('class="run-list"')).toBeGreaterThan(at('runs-head'))
    expect(side).toMatch(ADD)
    expect(side.search(ADD)).toBeGreaterThan(at('class="run-list"'))
    // The button opens a dialog, and nothing is open at start.
    expect(side).toMatch(/aria-haspopup="dialog"/)
    expect(html).not.toMatch(/<dialog/)
  })

  it('names each card as its run header does, with the repo as a muted line; no sprint or wave', () => {
    const side = sideOf(render({ repo: chess([onlyQueue()]) }).html)
    expect(side).toMatch(/<span class="run-head"><b>Sparring ladder to Liem<\/b><span class="run-repo muted">chess-web<\/span><\/span>/)
    expect(side).toMatch(/class="status /)
    expect(text(side)).not.toMatch(/sparring-ladder|wave/i)
  })

  it('names a fix card by its PR title, with one fix tag', () => {
    const name = 'fix-sprint-column'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const pr = gh(58, 'open', { branch: name, title: 'fix(server): gh pr list times out' })
    const { html } = render({ repo: chess([onlyQueue()], { claims: [claim], prs: [pr] }), plan: name })
    const side = sideOf(html)
    const card = /<a class="run" href="#\/chess\/fix-sprint-column"[\s\S]*?<\/a>/.exec(side)?.[0] ?? ''
    expect(card).toMatch(/<b>gh pr list times out<\/b>/)
    expect(card).toMatch(/<span class="run-repo muted">chess-web<\/span><span class="chip tag">fix<\/span>/)
    // `fix` once: the tag, never also in the name.
    expect(count(text(card), /\bfix\b/)).toBe(1)
    // The same name as the run header.
    expect(headerOf(html)).toMatch(/<h1 class="run-name" tabindex="-1">gh pr list times out<\/h1>/)
  })

  it('shows lost · retrying beside the title only while lost', () => {
    const repo = chess([onlyQueue()])
    const lost = sideOf(render({ repo, stream: 'lost' }).html)
    expect(lost).toMatch(/class="side-head"[\s\S]*Pod Board[\s\S]*lost · retrying/)
    expect(sideOf(render({ repo, stream: 'live' }).html)).not.toMatch(/retrying/)
  })

  it('puts the menu at the right end of the run header', () => {
    const { html } = render({ repo: chess([onlyQueue()]) })
    expect(sideOf(html)).not.toMatch(/aria-label="Menu"/)
    const header = headerOf(html)
    expect(header).toMatch(/aria-label="Menu"/)
    expect(header.indexOf('aria-label="Menu"')).toBeGreaterThan(header.indexOf('class="run-name"'))
    expect(count(html, /aria-label="Menu"/)).toBe(1)
  })

  it('heads the run with a plain title and one muted meta line, no crumb', () => {
    const header = headerOf(render({ repo: chess([onlyQueue()]) }).html)
    expect(header).toMatch(/<h1 class="run-name" tabindex="-1">Sparring ladder to Liem<\/h1><p class="run-sub muted">chess-web · Plan · started 2 days ago<\/p>/)
    // No slash crumb and no eyebrow above the title.
    expect(header).not.toMatch(/run-crumb|eyebrow/)
    expect(text(header)).not.toMatch(/\//)
    // The wave board link and the menu stay at the right end.
    expect(header.indexOf('Open the wave board')).toBeGreaterThan(header.indexOf('run-sub'))
  })

  it('heads a fix run with its readable slug while it has no PR', () => {
    const name = 'fix-sprint-column'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const header = headerOf(render({ repo: chess([], { claims: [claim] }), plan: name }).html)
    expect(header).toMatch(/<h1 class="run-name" tabindex="-1">Sprint column<\/h1><p class="run-sub muted">chess-web · Fix<\/p>/)
    expect(header).not.toMatch(/fix · /)
  })

  it('keeps the menu on the wave board header', () => {
    expect(headerOf(render({ repo: chess(), view: 'board' }).html)).toMatch(/aria-label="Menu"/)
  })

  it('keeps the menu reachable with no repos', () => {
    // No run, so no header: the theme must still be reachable.
    const board: Board = { generatedAt: NOW, gh: 'ok', repos: [], actions: [] }
    const html = renderToStaticMarkup(
      createElement(RunsScreen, { board, stream: 'live', runs: [], selected: undefined, view: 'pipeline', slice: undefined, now: NOW, storage: storage() }),
    )
    expect(html).toMatch(/<main[\s\S]*aria-label="Menu"/)
    expect(text(html)).toMatch(/No repos yet/)
    expect(text(html)).toMatch(/Add repo/)
    expect(text(html)).not.toMatch(/in the bar/)
    expect(sideOf(html)).toMatch(ADD)
  })

  it("reads the started time against the Board's transcript window", () => {
    const D = 24 * 3_600_000
    const repo = chess([onlyQueue()], { agents: [{ id: 'a', session: 's', type: 'pod:engineer', tokens: 0, ended: true, startedAt: NOW - 10 * D, plan: PLAN }] })
    const headerWith = (transcriptDays: number | undefined) => {
      const board: Board = { ...boardOf(repo), ...(transcriptDays === undefined ? {} : { transcriptDays }) }
      const runs = listRuns(board, NOW)
      const html = renderToStaticMarkup(
        createElement(RunsScreen, { board, stream: 'live', runs, selected: runs.find((r) => r.plan === PLAN), view: 'pipeline', slice: undefined, now: NOW, storage: storage() }),
      )
      return text(headerOf(html))
    }
    // No window on the Board: 30 days, so the agent 10 days back counts.
    expect(headerWith(undefined)).toMatch(/started 10 days ago/)
    // A 10-day window: that start is at the edge, so it reads as a date.
    const day = new Date(NOW - 10 * D)
    expect(headerWith(10)).toContain(`started ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][day.getMonth()]} ${day.getDate()}`)
  })
})

describe('sidebar resize handle', () => {
  /** A store keyed like localStorage. */
  const keyed = (init: Record<string, string> = {}): TabStorage => {
    const m = new Map(Object.entries(init))
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
  }
  const renderWith = (store: TabStorage) => {
    const repo = chess([onlyQueue()])
    const board = boardOf(repo)
    const runs = listRuns(board, NOW)
    return renderToStaticMarkup(
      createElement(RunsScreen, { board, stream: 'live', runs, selected: runs.find((r) => r.plan === PLAN), view: 'pipeline', slice: undefined, now: NOW, storage: store }),
    )
  }
  const handleOf = (html: string) => /<div[^>]*class="side-handle"[^>]*><\/div>/.exec(html)?.[0] ?? ''

  it('is a focusable vertical separator with its value, min, and max', () => {
    const handle = handleOf(renderWith(keyed()))
    expect(handle).toMatch(/role="separator"/)
    expect(handle).toMatch(/aria-orientation="vertical"/)
    expect(handle).toMatch(/aria-valuenow="260"/)
    expect(handle).toMatch(/aria-valuemin="200"/)
    expect(handle).toMatch(/aria-valuemax="400"/)
    expect(handle).toMatch(/tabindex="0"/)
    expect(handle).toMatch(/aria-label="Resize the sidebar"/)
    expect(handle).toMatch(/aria-controls="side"/)
  })

  it('sizes the sidebar column from the stored width, clamped', () => {
    const at = (stored: Record<string, string>) => {
      const html = renderWith(keyed(stored))
      return { value: /aria-valuenow="(\d+)"/.exec(handleOf(html))?.[1], style: /<div class="screen-body" style="([^"]*)"/.exec(html)?.[1] }
    }
    expect(at({})).toEqual({ value: '260', style: '--side-width:260px' })
    expect(at({ 'pod-board-sidebar-width': '320' })).toEqual({ value: '320', style: '--side-width:320px' })
    expect(at({ 'pod-board-sidebar-width': '9000' })).toEqual({ value: '400', style: '--side-width:400px' })
    expect(at({ 'pod-board-sidebar-width': 'wide' })).toEqual({ value: '260', style: '--side-width:260px' })
  })

  it('sits between the sidebar and the main column', () => {
    const html = renderWith(keyed())
    expect(html).toMatch(/<aside class="side" id="side">/)
    expect(html.indexOf('class="side-handle"')).toBeGreaterThan(html.indexOf('</aside>'))
    expect(html.indexOf('class="side-handle"')).toBeLessThan(html.indexOf('<main'))
  })
})

describe('sibling keys', () => {
  // React keeps a stale child when two siblings share a key: switching runs left the last run's flow on screen.
  it('the flow and the Next step card never share a key', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./RunsScreen.tsx', import.meta.url), 'utf8')
    const keyOf = (tag: string) => new RegExp(`<${tag} key=\{([^}]+\}?)\}`).exec(src)?.[1]
    expect(keyOf('Flow')).toBeDefined()
    expect(keyOf('NextStepCard')).toBeDefined()
    expect(keyOf('Flow')).not.toBe(keyOf('NextStepCard'))
  })
})

describe('urgent banner', () => {
  // X (selected) waits on a decision; another repo's run waits on a halt or on less.
  const decision = entry('PENDING', 'engineer → human', `plan: ${PLAN}`, 'decision: pick the port.')
  const someday = entry('PENDING', 'engineer → human', `plan: ${PLAN}`, 'someday: trim the cache.')
  const x = () => chess([onlyQueue(decision), manual])
  /** A second repo from the same fixture, with its own id, name and queue. */
  function other(...lines: string[]): BoardRepo {
    return { ...chess([onlyQueue(...lines), manual]), id: 'other', name: 'other-web', path: '/o' }
  }
  const mainOf = (html: string) => /<main class="main[^"]*">([\s\S]*)<\/main>/.exec(html)?.[1] ?? ''
  const slotOf = (html: string) => /<div class="urgent-slot" role="status">([\s\S]*?)<\/div><\/div>|<div class="urgent-slot" role="status"><\/div>/.exec(html)

  it('urgent banner shows another run\'s halt above the header', () => {
    const { html } = render({ repo: x(), others: [other(HALT)], stream: 'lost' })
    const main = mainOf(html)
    // The live region is the first child of main; the banner sits in it, before the error notices and the header.
    expect(main).toMatch(/^<div class="urgent-slot" role="status"><div class="urgent">/)
    expect(main.indexOf('class="urgent"')).toBeLessThan(main.indexOf('class="banners"'))
    expect(main.indexOf('class="banners"')).toBeLessThan(main.indexOf('class="run-header"'))
    const slot = slotOf(main)?.[0] ?? ''
    expect(text(slot).replace(/\s+/g, ' ').trim()).toBe('Blocked Autopilot stopped: a slice is blocked · other-web · Sparring ladder to Liem Open run')
    expect(slot).toMatch(/href="#\/other\/sparring-ladder"/)
    expect(slot).toMatch(/aria-label="Open run Sparring ladder to Liem"/)
    // X's own card is still the decision, with the page's one primary button.
    expect(text(cardOf(html))).toMatch(/pick the port/)
    expect(count(html, /class="btn primary[^"]*"/)).toBe(1)
  })

  it('no banner when nothing outranks', () => {
    const { html } = render({ repo: x(), others: [other(someday)], stream: 'lost' })
    const main = mainOf(html)
    // The region stays, empty, so a later item is announced; then today's order.
    expect(main).toMatch(/^<div class="urgent-slot" role="status"><\/div><div class="banners">/)
    expect(main).not.toMatch(/class="urgent"/)
    expect(main.indexOf('class="banners"')).toBeLessThan(main.indexOf('class="run-header"'))
    // With no error notice, the header follows the empty region.
    expect(mainOf(render({ repo: x(), others: [other(someday)] }).html)).toMatch(/^<div class="urgent-slot" role="status"><\/div><header class="run-header"/)
  })

  it('banner only on screen 1 views', () => {
    const board = render({ repo: x(), others: [other(HALT)], view: 'board' }).html
    expect(board).toMatch(/class="wave-board"/)
    expect(board).not.toMatch(/urgent/)
    // A fix run's Log on screen 1 (the agent view) has it.
    const name = 'fix-scroll'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const agent = render({ repo: chess([onlyQueue(), manual], { claims: [claim] }), others: [other(HALT)], plan: name, view: 'agent', agent: 'f1' }).html
    expect(mainOf(agent)).toMatch(/^<div class="urgent-slot" role="status"><div class="urgent">/)
    expect(text(slotOf(agent)?.[0] ?? '')).toMatch(/other-web/)
  })
})
