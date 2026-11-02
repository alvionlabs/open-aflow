import { describe, expect, it } from 'vitest'
import { buildRepoModel, type Board, type BoardRepo, type RunSummary } from '@pod-board/model'
import { agentChip, agentLogRows, banners, confidenceTag, connectionStatus, emptyMessage, groupChip, logBlocks, logRunChip, nextStatus, otherRows, rowFigures, runCard, runChip, tabPress, titleParts } from './view.ts'

const run = (over: Partial<RunSummary>): RunSummary => ({ repoId: 'r', repo: 'chess-web', where: 'x', state: 'idle', ...over })

describe('screen 1 view helpers', () => {
  it('every run state gets a chip class and a label', () => {
    expect(runChip('blocked')).toEqual({ cls: 's-bad', label: 'blocked' })
    expect(runChip('needs-you')).toEqual({ cls: 's-you', label: 'needs you' })
    expect(runChip('running')).toEqual({ cls: 's-run', label: 'running' })
    expect(runChip('idle')).toEqual({ cls: 's-idle', label: 'idle' })
    expect(runChip('unsupported')).toEqual({ cls: 's-you', label: 'update pod' })
    expect(runChip('error')).toEqual({ cls: 's-bad', label: 'error' })
  })

  it('connection status only when lost', () => {
    expect(connectionStatus('lost')).toEqual({ cls: 's-bad', label: 'lost · retrying' })
    expect(connectionStatus('live')).toBeUndefined()
    expect(connectionStatus('connecting')).toBeUndefined()
  })

  it('run card: the run header’s name, with the repo as a muted line', () => {
    const repo: BoardRepo = { id: 'c', name: 'chess-web', path: '/c', source: 'registered', model: buildRepoModel({}), agents: [], prs: [], claims: [] }
    const withPr = (title: string): BoardRepo => ({ ...repo, prs: [{ number: 58, state: 'open', checks: 'none', checkedAt: 0, branch: 'fix-scroll', title }] })
    const claimed: BoardRepo = { ...repo, claims: [{ portBase: 3100, repoPath: '/c', plan: 'fix-scroll' }] }
    // A plan: its title, as in the run header; the repo under it.
    expect(runCard(run({ repoId: 'c', plan: 'sparring-ladder', title: 'Sparring ladder to Liem' }), repo)).toEqual({ name: 'Sparring ladder to Liem', repo: 'chess-web' })
    // A plan with no title anywhere: its slug made readable.
    expect(runCard(run({ repoId: 'c', plan: 'sprint-column' }), repo)).toEqual({ name: 'Sprint column', repo: 'chess-web' })
    // A fix run: its PR title without the prefix, case kept; no `fix` in the name (the card's tag says it).
    const fix = run({ repoId: 'c', plan: 'fix-scroll', fix: 'scroll' })
    expect(runCard(fix, { ...withPr('fix(server): gh pr list times out'), claims: claimed.claims })).toEqual({ name: 'gh pr list times out', repo: 'chess-web' })
    // No PR yet: the slug made readable.
    expect(runCard(fix, claimed)).toEqual({ name: 'Scroll', repo: 'chess-web' })
    // A repo row (no plan): the repo is the name, so no second line repeats it.
    expect(runCard(run({ repoId: 'c' }), repo)).toEqual({ name: 'chess-web' })
    // A run whose repo isn't on the Board yet: the same names from the summary alone.
    expect(runCard(run({ repoId: 'x', plan: 'sprint-column', title: 'Sprint column fix' }), undefined)).toEqual({ name: 'Sprint column fix', repo: 'chess-web' })
    expect(runCard(fix, undefined)).toEqual({ name: 'Scroll', repo: 'chess-web' })
  })

  it('tab press: toggles, and leaves the engineer view', () => {
    expect(tabPress(undefined, 'waiting', 'pipeline')).toEqual({ save: 'waiting', leave: false })
    expect(tabPress('waiting', 'waiting', 'pipeline')).toEqual({ save: undefined, leave: false })
    expect(tabPress('waiting', 'log', 'board')).toEqual({ save: 'log', leave: false })
    // The engineer view shows Log: pressing Log closes it and goes back to the run; another tab opens there.
    expect(tabPress('log', 'log', 'agent')).toEqual({ save: undefined, leave: true })
    expect(tabPress('log', 'waiting', 'agent')).toEqual({ save: 'waiting', leave: true })
  })

  it('next step status: a dot class and a word', () => {
    expect(nextStatus('blocked')).toEqual({ cls: 's-bad', label: 'Blocked' })
    expect(nextStatus('needs-you')).toEqual({ cls: 's-you', label: 'Needs you' })
    expect(nextStatus('ready')).toEqual({ cls: 's-ok', label: 'Ready' })
    expect(nextStatus('running')).toEqual({ cls: 's-run', label: 'Running' })
    expect(nextStatus('idle')).toEqual({ cls: 's-idle', label: 'Idle' })
  })

  it('log group statuses map to chips', () => {
    expect(groupChip('merged PR #41').cls).toBe('s-ok')
    expect(groupChip('merged').cls).toBe('s-ok')
    expect(groupChip('PR #42 open').cls).toBe('s-you')
    expect(groupChip('running').cls).toBe('s-run')
    expect(groupChip('blocked').cls).toBe('s-bad')
    expect(groupChip('planned').cls).toBe('s-idle')
    expect(groupChip('merged PR #41').label).toBe('merged PR #41')
  })

  it('row figures join what is known and skip the rest', () => {
    // Confidence is an attribute (a tag after the title), not a figure.
    expect(rowFigures({ code: 'B1', title: 't', confidence: 'high', minutes: 22, tokens: 248_000, live: false })).toBe('22 min · 248k tok')
    expect(confidenceTag({ code: 'B1', title: 't', confidence: 'high', live: false })).toBe('high confidence')
    expect(confidenceTag({ code: 'B1', title: 't', confidence: 'Medium', live: false })).toBe('medium confidence')
    expect(confidenceTag({ code: 'B1', title: 't', live: false })).toBeUndefined()
    expect(rowFigures({ code: 'B1', title: 't', minutes: 14, live: true })).toBe('14 min')
    expect(rowFigures({ code: 'B1', title: 't', live: false })).toBe('')
    expect(rowFigures({ code: 'B1', title: 't', minutes: 0, tokens: 0, live: false })).toBe('0 min')
  })

  it('runs with no pipeline say why, and what to do', () => {
    expect(emptyMessage(run({ state: 'idle' }))).toMatch(/no active plan/i)
    expect(emptyMessage(run({ state: 'unsupported' }))).toMatch(/update pod/i)
    expect(emptyMessage(run({ state: 'error', where: 'repo folder not found' }))).toMatch(/repo folder not found/)
    expect(emptyMessage(run({ state: 'running', plan: 'p' }))).toMatch(/can.t find plan p/i)
  })

  it('title parts turn backticked spans into code and keep the rest as text', () => {
    expect(titleParts('Port the pod-flow parsers and their tests into `model`')).toEqual([
      { text: 'Port the pod-flow parsers and their tests into ', code: false },
      { text: 'model', code: true },
    ])
    expect(titleParts('Fix `currentWave` on done sprints')).toEqual([
      { text: 'Fix ', code: false },
      { text: 'currentWave', code: true },
      { text: ' on done sprints', code: false },
    ])
    expect(titleParts('`a` and `b`')).toEqual([
      { text: 'a', code: true },
      { text: ' and ', code: false },
      { text: 'b', code: true },
    ])
    expect(titleParts('plain title')).toEqual([{ text: 'plain title', code: false }])
    expect(titleParts('')).toEqual([])
  })

  it('title parts leave unmatched backticks as text', () => {
    expect(titleParts('one ` tick')).toEqual([{ text: 'one ` tick', code: false }])
    expect(titleParts('`a` then `b')).toEqual([
      { text: 'a', code: true },
      { text: ' then `b', code: false },
    ])
    // A run only closes on a run of the same length, so ``x`` holds a backtick inside.
    expect(titleParts('run ``a ` b`` now')).toEqual([
      { text: 'run ', code: false },
      { text: 'a ` b', code: true },
      { text: ' now', code: false },
    ])
    expect(titleParts('`` alone')).toEqual([{ text: '`` alone', code: false }])
  })
})

const board = (over: Partial<Board> = {}): Board => ({ generatedAt: 0, gh: 'ok', repos: [], ...over })
// Local time, so HH:MM reads the same in every time zone.
const at = (h: number, m: number) => new Date(2026, 9, 19, h, m).getTime()

const LOST = 'Lost the connection to the server. Showing the last board; retrying.'
const CONFIG = "The board's config file can't be read, so the repo list may be out of date. The board never overwrites it."
const GH_MISSING = "gh isn't installed, so PR states aren't checked."
const GH_LOGGED_OUT = "gh isn't logged in, so PR states may be out of date. Run gh auth login."

describe('banners', () => {
  it('lists the lost stream, then the config error, then gh, each with a chip', () => {
    const all = banners(board({ configError: 'config unreadable', gh: 'logged-out', ghCheckedAt: at(9, 5) }), 'lost')
    expect(all.map((b) => b.text)).toEqual([LOST, CONFIG, `${GH_LOGGED_OUT} Last checked 09:05.`])
    for (const b of all) {
      expect(b.chip.label).not.toBe('')
      expect(['s-run', 's-ok', 's-you', 's-bad', 's-idle']).toContain(b.chip.cls)
    }
    expect(all[0]!.chip).toEqual({ cls: 's-bad', label: 'lost · retrying' })
  })

  it('shows the config error alone', () => {
    expect(banners(board({ configError: 'config unreadable' }), 'live')).toEqual([
      { chip: { cls: 's-bad', label: 'config unreadable' }, text: CONFIG },
    ])
  })

  it('shows gh missing and logged out, with the last check when known', () => {
    expect(banners(board({ gh: 'missing' }), 'live')).toEqual([{ chip: { cls: 's-you', label: 'gh missing' }, text: GH_MISSING }])
    expect(banners(board({ gh: 'missing', ghCheckedAt: at(14, 30) }), 'live')).toEqual([
      { chip: { cls: 's-you', label: 'gh missing' }, text: `${GH_MISSING} Last checked 14:30.` },
    ])
    expect(banners(board({ gh: 'logged-out' }), 'live')).toEqual([
      { chip: { cls: 's-you', label: 'gh logged out' }, text: GH_LOGGED_OUT },
    ])
    expect(banners(board({ gh: 'logged-out', ghCheckedAt: at(0, 0) }), 'live')).toEqual([
      { chip: { cls: 's-you', label: 'gh logged out' }, text: `${GH_LOGGED_OUT} Last checked 00:00.` },
    ])
  })

  it('gives none for gh ok or unknown, a live or connecting stream, and no config error', () => {
    expect(banners(board({ gh: 'ok', ghCheckedAt: at(9, 5) }), 'live')).toEqual([])
    expect(banners(board({ gh: 'unknown' }), 'connecting')).toEqual([])
  })

  it('with no board yet, shows only a lost stream', () => {
    expect(banners(undefined, 'connecting')).toEqual([])
    expect(banners(undefined, 'lost').map((b) => b.text)).toEqual([LOST])
  })
})

const repoWith = (readme: string | undefined): BoardRepo => ({
  id: 'r',
  name: 'chess-web',
  path: '/r',
  source: 'registered',
  model: buildRepoModel(readme === undefined ? {} : { 'pod-docs/README.md': readme }),
  agents: [],
  prs: [],
  claims: [],
})

describe('empty messages', () => {
  it('names the unsupported docs version, or its absence', () => {
    const unsupported = run({ state: 'unsupported', where: 'update pod' })
    expect(emptyMessage(unsupported, repoWith('# pod docs\n\npod docs: 3\n'))).toBe(
      "This repo's pod docs are version 3; Pod Board reads version 2. Update pod in this repo.",
    )
    expect(emptyMessage(unsupported, repoWith('# pod docs\n'))).toBe(
      'This repo has no pod docs version (an older pod). Update pod in this repo.',
    )
    expect(emptyMessage(unsupported, repoWith(undefined))).toBe(
      'This repo has no pod docs version (an older pod). Update pod in this repo.',
    )
  })

  it('without the repo, an unsupported run still says to update pod', () => {
    expect(emptyMessage(run({ state: 'unsupported' }))).toMatch(/update pod in this repo/i)
  })

  it('keeps the error, no plan, and unknown plan messages', () => {
    const r = repoWith('pod docs: 2\n')
    expect(emptyMessage(run({ state: 'error', where: 'repo folder not found' }), r)).toBe(
      "Can't read this repo: repo folder not found. Check that the folder still exists.",
    )
    expect(emptyMessage(run({ state: 'idle', where: 'no active plan' }), r)).toBe(
      'No active plan in this repo. A plan shows here once pod starts one.',
    )
    expect(emptyMessage(run({ state: 'running', plan: 'p' }), r)).toBe("Can't find plan p in this repo's pod docs.")
  })
})

describe('fix runs and other activity', () => {
  const fixRun = run({ plan: 'fix-scroll', fix: 'scroll', where: 'review', state: 'running' })
  const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime()

  it('agent chips', () => {
    expect(agentChip('running')).toEqual({ cls: 's-run', label: 'running' })
    expect(agentChip('ended')).toEqual({ cls: 's-ok', label: 'ended' })
    expect(agentChip('stale')).toEqual({ cls: 's-idle', label: 'stale' })
  })

  it('agent log rows: role and round, start → end, a link to each engineer', () => {
    const rows = agentLogRows(fixRun, [
      { agentId: 'e1', role: 'engineer', startedAt: at(10, 33), endedAt: at(11, 2), state: 'ended', engineer: true },
      { agentId: 'r1', role: 'reviewer', round: 1, startedAt: at(11, 5), state: 'running', engineer: false },
      { agentId: 'e2', role: 'fix pass', state: 'stale', engineer: true },
    ])
    expect(rows).toEqual([
      { key: 'e1', agentId: 'e1', label: 'engineer', time: '10:33 → 11:02', chip: { cls: 's-ok', label: 'ended' }, href: '#/r/fix-scroll/agent/e1' },
      { key: 'r1', agentId: 'r1', label: 'reviewer · round 1', time: '11:05 → now', chip: { cls: 's-run', label: 'running' } },
      { key: 'e2', agentId: 'e2', label: 'fix pass', time: '—', chip: { cls: 's-idle', label: 'stale' }, href: '#/r/fix-scroll/agent/e2' },
    ])
  })

  it('a continued agent gives one row per turn, each with its own key and the same agent', () => {
    const rows = agentLogRows(fixRun, [
      { agentId: 'e1', role: 'engineer', turn: 0, startedAt: at(10, 25), endedAt: at(11, 8), state: 'ended', engineer: true },
      { agentId: 'r1', role: 'reviewer', round: 1, startedAt: at(11, 10), endedAt: at(11, 19), state: 'ended', engineer: false },
      { agentId: 'e1', role: 'fix pass', turn: 1, startedAt: at(11, 19), state: 'running', engineer: true },
    ])
    expect(rows.map((r) => [r.key, r.agentId, r.label, r.time, r.href])).toEqual([
      ['e1:0', 'e1', 'engineer', '10:25 → 11:08', '#/r/fix-scroll/agent/e1'],
      ['r1', 'r1', 'reviewer · round 1', '11:10 → 11:19', undefined],
      ['e1:1', 'e1', 'fix pass', '11:19 → now', '#/r/fix-scroll/agent/e1'],
    ])
  })

  it('other activity rows: role, the field, and the time', () => {
    expect(
      otherRows([
        { id: 'x1', role: 'researcher', startedAt: at(9, 0), lastAt: at(9, 40), state: 'ended' },
        { id: 'x2', role: 'engineer', detail: 'fix-old', lastAt: at(11, 58), state: 'running' },
      ]),
    ).toEqual([
      { key: 'x1', text: 'researcher', time: '09:40', chip: { cls: 's-ok', label: 'ended' } },
      { key: 'x2', text: 'engineer · fix-old', time: '11:58', chip: { cls: 's-run', label: 'running' } },
    ])
  })
})

describe('log blocks', () => {
  const row = (code: string) => ({ code, title: `Title ${code}`, live: false })
  const group = (sprint: string, i: number, wave: number, status: string, codes: string[]) => ({ sprint, wave, label: `Sprint ${i} · wave ${wave}`, status, rows: codes.map(row) })
  const sprints = [
    { slug: 'warmup', status: 'done' as const },
    { slug: 'ladder', status: 'active' as const },
    { slug: 'rematch', status: 'planned' as const },
  ]

  it('one block per sprint, holding its waves in order, each wave with its slices', () => {
    const log = [
      group('warmup', 1, 1, 'merged PR #70', ['A1']),
      group('warmup', 1, 2, 'merged PR #71', ['B1', 'B2']),
      group('ladder', 2, 1, 'merged PR #76', ['L1']),
      group('ladder', 2, 2, 'running', ['U1']),
    ]
    const blocks = logBlocks(log, sprints, { slug: 'ladder', chip: runChip('running') })
    expect(blocks.map((b) => [b.key, b.title, b.chip])).toEqual([
      ['warmup', 'Sprint 1 · warmup', { cls: 's-ok', label: 'done' }],
      ['ladder', 'Sprint 2 · ladder', { cls: 's-run', label: 'running' }],
    ])
    expect(blocks[0]!.waves.map((w) => [w.key, w.label, w.chip.label, w.rows.map((r) => r.code)])).toEqual([
      ['warmup/1', 'Wave 1', 'merged PR #70', ['A1']],
      ['warmup/2', 'Wave 2', 'merged PR #71', ['B1', 'B2']],
    ])
    expect(blocks[1]!.waves.map((w) => [w.label, w.chip])).toEqual([
      ['Wave 1', { cls: 's-ok', label: 'merged PR #76' }],
      ['Wave 2', { cls: 's-run', label: 'running' }],
    ])
  })

  it("a sprint's number comes from the plan; a later sprint waits; an unknown one has no state", () => {
    // The first sprint has no log (no doc): the second keeps its number.
    expect(logBlocks([group('ladder', 2, 1, 'planned', ['L1'])], sprints, undefined)[0]).toMatchObject({ title: 'Sprint 2 · ladder', chip: { cls: 's-idle', label: 'waiting' } })
    const cur = { slug: 'ladder', chip: runChip('running') }
    expect(logBlocks([group('gone', 4, 1, 'planned', ['X1'])], sprints, cur)[0]).toMatchObject({ title: 'gone' })
    expect(logBlocks([group('gone', 4, 1, 'planned', ['X1'])], sprints, cur)[0]).not.toHaveProperty('chip')
    expect(logBlocks([], sprints, cur)).toEqual([])
  })

  it("the current sprint's chip is the run's own chip, as the runs list shows it; the in-progress wave matches", () => {
    const log = [group('ladder', 2, 3, 'blocked', ['T1'])]
    expect(logBlocks(log, sprints, { slug: 'ladder', chip: runChip('blocked') })[0]).toMatchObject({ chip: { cls: 's-bad', label: 'blocked' } })
    const asks = logBlocks([group('ladder', 2, 3, 'needs you', ['T1'])], sprints, { slug: 'ladder', chip: runChip('needs-you') })[0]!
    expect(asks.chip).toEqual({ cls: 's-you', label: 'needs you' })
    expect(asks.waves[0]!.chip).toEqual({ cls: 's-you', label: 'needs you' })
    expect(groupChip('waiting')).toEqual({ cls: 's-idle', label: 'waiting' })
    // An idle run's sprint reads waiting in the Log (the runs list keeps idle); every other state is the run's chip.
    expect(logRunChip('idle')).toEqual({ cls: 's-idle', label: 'waiting' })
    expect(logRunChip('blocked')).toEqual(runChip('blocked'))
    expect(logRunChip('needs-you')).toEqual(runChip('needs-you'))
    expect(logRunChip('running')).toEqual(runChip('running'))
  })
})
