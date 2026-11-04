import { describe, expect, it } from 'vitest'
import * as model from './index.ts'
import type { AgentRun, Board, BoardRepo } from './board.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'
import { activeRuns, listRuns, type RunSummary } from './runs.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 9, 18, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string]

function planDoc(title: string, sprints: SprintRow[], opts: { status?: string; extra?: string } = {}): string {
  return [
    `# Plan: ${title}`,
    '',
    `_Generated: 2026-10-18 · Status: ${opts.status ?? 'active'} · Grilled-with: grilling_`,
    opts.extra ?? '',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([slug, status]) => `| ${slug} | goal of ${slug} | ${status} | — |`),
    '',
  ].join('\n')
}

function sprintDoc(slug: string, plan: string, board: BoardRow[]): string {
  return [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-10-18_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    ...board.map(([w, code, pr, status]) => `| ${w} | ${code} | Title ${code} | ${slug}-${code} | ${pr} | ${status} | medium | — |`),
    '',
  ].join('\n')
}

const queueLine = (type: string, route: string, fields: string, body: string, pending = true) =>
  `- \`[2026-10-18 · ${type} · ${route} · ${fields}]\` ${body} **Resolution:** ${pending ? 'pending' : 'fixed in #9'}`

const MID_BOARD: BoardRow[] = [
  [1, 'A1', '[#3](https://github.com/o/r/pull/3) merged', 'done'],
  [2, 'B1', '—', 'pending'],
  [2, 'B2', '—', 'pending'],
]

const DONE_BOARD: BoardRow[] = [[1, 'A1', '[#3](https://github.com/o/r/pull/3) merged', 'done']]

type AlphaOpts = { queue?: string[]; board?: BoardRow[]; sprints?: SprintRow[]; status?: string; extra?: string; slug?: string }

/** One plan (`alpha` by default) whose first sprint `one` has a doc. */
function planFiles(opts: AlphaOpts = {}): RepoFiles {
  const slug = opts.slug ?? 'alpha'
  const sprints = opts.sprints ?? [['one', 'active'], ['two', 'planned']]
  const files: RepoFiles = {
    'pod-docs/README.md': README,
    [`pod-docs/plans/${slug}.md`]: planDoc(slug.toUpperCase(), sprints, { status: opts.status, extra: opts.extra }),
    'pod-docs/handoff-queue.md': (opts.queue ?? []).join('\n'),
  }
  const first = sprints[0]?.[0]
  if (first) files[`pod-docs/sprints/${first}.md`] = sprintDoc(first, slug, opts.board ?? MID_BOARD)
  return files
}

function repo(name: string, files: RepoFiles, extra: Partial<BoardRepo> = {}): BoardRepo {
  return { id: `id-${name}`, name, path: `/r/${name}`, source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}

const board = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos })

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', description: '', tokens: 0, ended: false, ...over }
}

const running = (over: Partial<AgentRun>) => agent({ startedAt: NOW - 10 * MIN, lastAt: NOW - MIN, ...over })

const runsOf = (r: BoardRepo) => listRuns(board(r), NOW)
const stateOf = (r: BoardRepo) => runsOf(r).map((run) => run.state)

describe('listRuns', () => {
  it('run state precedence', () => {
    const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Gate 2 stopped the run')
    const ask = queueLine('PENDING', 'engineer → human', 'plan: alpha · slice: B1', 'Pick a name')

    // Nothing going on → idle.
    expect(stateOf(repo('r', planFiles()))).toEqual(['idle'])
    // A running agent of the plan, by its sprint or by its plan slug → running.
    expect(stateOf(repo('r', planFiles(), { agents: [running({ sprint: 'one', slice: 'B1' })] }))).toEqual(['running'])
    expect(stateOf(repo('r', planFiles(), { agents: [running({ type: 'pod:sprint-planner', plan: 'alpha' })] }))).toEqual(['running'])
    // A stale or ended agent isn't running, and neither is another plan's agent.
    expect(stateOf(repo('r', planFiles(), { agents: [agent({ sprint: 'one', lastAt: NOW - 30 * MIN })] }))).toEqual(['idle'])
    expect(stateOf(repo('r', planFiles(), { agents: [running({ sprint: 'one', ended: true })] }))).toEqual(['idle'])
    expect(stateOf(repo('r', planFiles(), { agents: [running({ sprint: 'other-sprint' })] }))).toEqual(['idle'])
    // A pushed slice in the current wave → running.
    const pushed = planFiles({ board: [[1, 'A1', '—', 'done'], [2, 'B1', '[#7](https://github.com/o/r/pull/7)', 'pushed'], [2, 'B2', '—', 'pending']] })
    expect(stateOf(repo('r', pushed))).toEqual(['running'])

    // needs-you wins over running.
    expect(stateOf(repo('r', planFiles({ queue: [ask] }), { agents: [running({ sprint: 'one' })] }))).toEqual(['needs-you'])
    // A BLOCKED between agents is pod's to resolve: it neither halts the plan nor stops the run.
    const engineerBlocked = queueLine('BLOCKED', 'engineer → orchestrator', 'plan: alpha', 'stuck')
    expect(stateOf(repo('r', planFiles({ queue: [engineerBlocked] })))).toEqual(['idle'])
    // A BLOCKED from an engineer to you stops the run, but doesn't halt the plan.
    expect(stateOf(repo('r', planFiles({ queue: [queueLine('BLOCKED', 'engineer → human', 'plan: alpha', 'stuck')] })))).toEqual(['needs-you'])
    // A resolved halt is nothing.
    expect(stateOf(repo('r', planFiles({ queue: [queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'old halt', false)] })))).toEqual(['idle'])

    // blocked wins over needs-you and running: a halt, a blocked slice, or a skipped PR in the current sprint.
    expect(stateOf(repo('r', planFiles({ queue: [halt, ask] }), { agents: [running({ sprint: 'one' })] }))).toEqual(['blocked'])
    const blockedSlice = planFiles({ queue: [ask], board: [[1, 'A1', '—', 'blocked'], [2, 'B1', '—', 'pending']] })
    expect(stateOf(repo('r', blockedSlice))).toEqual(['blocked'])
    const skipped = planFiles({ board: [[1, 'A1', 'skipped', 'done'], [2, 'B1', '—', 'pending']] })
    expect(stateOf(repo('r', skipped))).toEqual(['blocked'])
    // A blocked slice in a finished sprint isn't the current sprint's.
    const oldBlock = planFiles({ sprints: [['one', 'done'], ['two', 'active']], board: [[1, 'A1', '—', 'blocked']] })
    expect(stateOf(repo('r', oldBlock))).toEqual(['idle'])
  })

  it('waiting wave PR needs you', () => {
    const link = '[#7](https://github.com/o/r/pull/7)'
    const handedBack = planFiles({ board: [[1, 'A1', '—', 'done'], [2, 'B1', link, 'pushed'], [2, 'B2', link, 'pushed']] })
    // Every unfinished slice pushed with its PR, nothing running → needs you.
    expect(stateOf(repo('r', handedBack))).toEqual(['needs-you'])
    // It counts as active.
    expect(activeRuns(runsOf(repo('r', handedBack)))).toBe(1)
    // A running engineer of the wave: running, as today.
    expect(stateOf(repo('r', handedBack, { agents: [running({ sprint: 'one', slice: 'B1' })] }))).toEqual(['running'])
    // gh says the PR merged: no waiting PR, so running from the pushed slices, as today.
    const merged = { number: 7, state: 'merged' as const, checks: 'pass' as const, checkedAt: NOW }
    expect(stateOf(repo('r', handedBack, { prs: [merged] }))).toEqual(['running'])
    // blocked still wins: a halt, or a blocked slice in the current sprint.
    const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Gate 2 stopped the run')
    const halted = planFiles({ queue: [halt], board: [[1, 'A1', '—', 'done'], [2, 'B1', link, 'pushed'], [2, 'B2', link, 'pushed']] })
    expect(stateOf(repo('r', halted))).toEqual(['blocked'])
    const blocked = planFiles({ board: [[1, 'A1', '—', 'blocked'], [2, 'B1', link, 'pushed']] })
    expect(stateOf(repo('r', blocked))).toEqual(['blocked'])
  })

  it('where text', () => {
    const whereOf = (r: BoardRepo) => runsOf(r).map((run) => run.where)
    // Mid-wave: the current wave of the current sprint's waves.
    expect(whereOf(repo('r', planFiles()))).toEqual(['one · wave 2/2'])
    // Every slice done but the sprint not closed yet: the last wave.
    const allMerged = planFiles({ board: [[1, 'A1', 'merged', 'done'], [2, 'B1', 'merged', 'done']] })
    expect(whereOf(repo('r', allMerged))).toEqual(['one · wave 2/2'])

    // The current sprint has no doc yet.
    const noDoc = planFiles({ sprints: [['one', 'done'], ['two', 'planned']], board: DONE_BOARD })
    const planner = (over: Partial<AgentRun> = {}) => running({ type: 'pod:sprint-planner', plan: 'alpha', ...over })
    expect(whereOf(repo('r', noDoc, { agents: [planner()] }))).toEqual(['two · drafting'])
    expect(whereOf(repo('r', noDoc))).toEqual(['two · not drafted'])
    expect(whereOf(repo('r', noDoc, { agents: [planner({ lastAt: NOW - 31 * MIN })] }))).toEqual(['two · not drafted'])
    expect(whereOf(repo('r', noDoc, { agents: [planner({ plan: 'beta' })] }))).toEqual(['two · not drafted'])

    // No current sprint: final review while a reviewer runs, final PR with a hand-back, else all sprints done.
    const done = { sprints: [['one', 'done']] as SprintRow[], board: DONE_BOARD }
    const handBack = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'Plan complete: merge https://github.com/o/r/pull/12')
    const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Gate 3: final review still failing')
    const reviewer = running({ type: 'pod:reviewer', plan: 'alpha', round: 1 })
    expect(whereOf(repo('r', planFiles(done), { agents: [reviewer] }))).toEqual(['final review'])
    expect(whereOf(repo('r', planFiles({ ...done, queue: [handBack] }), { agents: [reviewer] }))).toEqual(['final review'])
    expect(whereOf(repo('r', planFiles({ ...done, queue: [handBack] })))).toEqual(['final PR'])
    expect(whereOf(repo('r', planFiles({ ...done, queue: [halt] })))).toEqual(['all sprints done'])
  })

  it('which plans are runs', () => {
    const done = { sprints: [['one', 'done']] as SprintRow[], board: DONE_BOARD }
    const handBack = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'Final PR ready: https://github.com/o/r/pull/12')

    // Archived plans drop out, even with a sprint not done.
    const archived = repo('r', planFiles({ status: 'archived' }))
    expect(runsOf(archived)).toEqual([{ repoId: 'id-r', repo: 'r', where: 'no active plan', state: 'idle' }])
    // A finished plan (every sprint done, no hand-back, nothing running) drops out.
    expect(runsOf(repo('r', planFiles(done)))).toEqual([{ repoId: 'id-r', repo: 'r', where: 'no active plan', state: 'idle' }])
    // A pending hand-back keeps it, until its PR is known to be merged.
    expect(runsOf(repo('r', planFiles({ ...done, queue: [handBack] }))).map((r) => r.plan)).toEqual(['alpha'])
    const merged = { number: 12, state: 'merged' as const, checks: 'pass' as const, checkedAt: NOW }
    expect(runsOf(repo('r', planFiles({ ...done, queue: [handBack] }), { prs: [merged] })).map((r) => r.where)).toEqual(['no active plan'])
    // A halt or a running final reviewer keeps a plan whose sprints are all done.
    const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Gate 3 halted')
    expect(runsOf(repo('r', planFiles({ ...done, queue: [halt] }))).map((r) => r.state)).toEqual(['blocked'])
    expect(runsOf(repo('r', planFiles(done), { agents: [running({ type: 'pod:reviewer', plan: 'alpha' })] })).map((r) => r.state)).toEqual(['running'])

    // A repo with no plans at all.
    expect(runsOf(repo('empty', { 'pod-docs/README.md': README }))).toEqual([{ repoId: 'id-empty', repo: 'empty', where: 'no active plan', state: 'idle' }])
    // Unsupported docs → one run; an error → one run, even with an unsupported model.
    expect(runsOf(repo('old', { 'pod-docs/README.md': 'pod docs: 1\n' }))).toEqual([{ repoId: 'id-old', repo: 'old', where: 'update pod', state: 'unsupported' }])
    expect(runsOf(repo('gone', {}, { error: 'folder not found' }))).toEqual([{ repoId: 'id-gone', repo: 'gone', where: 'folder not found', state: 'error' }])

    // An active plan: its slug, title, and port base (a claim's wins over the plan's).
    const withPort = planFiles({ extra: 'Port base: 3100' })
    expect(runsOf(repo('r', withPort))).toEqual([{ repoId: 'id-r', repo: 'r', plan: 'alpha', title: 'ALPHA', where: 'one · wave 2/2', state: 'idle', portBase: 3100 }])
    const claims = [{ portBase: 3200, repoPath: '/r/r', plan: 'alpha' }, { portBase: 3300, repoPath: '/r/r', plan: 'beta' }]
    expect(runsOf(repo('r', withPort, { claims }))[0]?.portBase).toBe(3200)
    expect(runsOf(repo('r', planFiles(), { claims: [claims[1]!] }))[0]).not.toHaveProperty('portBase')
  })

  it('a live claim keeps its plan listed through the close-out', () => {
    const closed = { status: 'archived', sprints: [['one', 'done']] as SprintRow[], board: DONE_BOARD }
    const claim = { portBase: 3200, repoPath: '/r/r', plan: 'alpha' }
    const reporter = running({ type: 'pod:reporter', plan: 'alpha' })
    const handBack = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'plan alpha complete — final PR https://github.com/o/r/pull/12, review pass')
    const merged = { number: 12, state: 'merged' as const, checks: 'pass' as const, checkedAt: NOW }
    const view = (r: BoardRepo) => runsOf(r).map((x) => [x.plan, x.where, x.state])

    // Archived, every sprint done, the reporter writing, no hand-back yet → closing out, running.
    expect(view(repo('r', planFiles(closed), { claims: [claim], agents: [reporter] }))).toEqual([['alpha', 'closing out', 'running']])
    expect(runsOf(repo('r', planFiles(closed), { claims: [claim], agents: [reporter] }))[0]).toMatchObject({ portBase: 3200 })
    // Once the hand-back exists → final PR, and the hand-back asks for you, with nothing running.
    expect(view(repo('r', planFiles({ ...closed, queue: [handBack] }), { claims: [claim] }))).toEqual([['alpha', 'final PR', 'needs-you']])
    // A reviewer still running wins: final review.
    const reviewer = running({ type: 'pod:reviewer', plan: 'alpha' })
    expect(view(repo('r', planFiles(closed), { claims: [claim], agents: [reviewer] }))).toEqual([['alpha', 'final review', 'running']])
    // An archived plan with a sprint left over still reads closing out, not that sprint.
    const leftOver = { ...closed, sprints: [['one', 'done'], ['two', 'planned']] as SprintRow[] }
    expect(view(repo('r', planFiles(leftOver), { claims: [claim], agents: [reporter] }))).toEqual([['alpha', 'closing out', 'running']])
    // A running plan fix engineer keeps it closing out too.
    const fixer = running({ type: 'pod:engineer', sprint: 'one', slice: 'plan-fix', branch: 'alpha-fix' })
    expect(view(repo('r', planFiles(closed), { claims: [claim], agents: [fixer] }))).toEqual([['alpha', 'closing out', 'running']])
    // A halt keeps it listed, blocked.
    const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Gate 2 halted')
    expect(view(repo('r', planFiles({ ...closed, queue: [halt] }), { claims: [claim] }))).toEqual([['alpha', 'closing out', 'blocked']])

    // No claim, or a claim for another plan: an archived plan stays off the list, even with its reporter running.
    const none = [{ repoId: 'id-r', repo: 'r', where: 'no active plan', state: 'idle' }]
    expect(runsOf(repo('r', planFiles(closed), { agents: [reporter] }))).toEqual(none)
    expect(runsOf(repo('r', planFiles(closed), { claims: [{ ...claim, plan: 'beta' }], agents: [reporter] }))).toEqual(none)
    expect(runsOf(repo('r', planFiles(closed), { claims: [{ ...claim, plan: 'Alpha' }] }))).toEqual(none)

    // A claimed plan that isn't archived yet, every sprint done and nothing running, stays listed too.
    const done = { sprints: [['one', 'done']] as SprintRow[], board: DONE_BOARD }
    expect(view(repo('r', planFiles(done), { claims: [claim] }))).toEqual([['alpha', 'all sprints done', 'idle']])
    // A claim on a plan mid-sprint changes nothing.
    expect(view(repo('r', planFiles(), { claims: [claim] }))).toEqual([['alpha', 'one · wave 2/2', 'idle']])
  })

  it('a leftover claim on a finished plan does not keep it listed', () => {
    const closed = { status: 'archived', sprints: [['one', 'done']] as SprintRow[], board: DONE_BOARD }
    const claim = { portBase: 3200, repoPath: '/r/r', plan: 'alpha' }
    const body = 'plan alpha complete — final PR https://github.com/o/r/pull/12, review pass'
    const resolved = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', body, false)
    const pending = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', body)
    const merged = { number: 12, state: 'merged' as const, checks: 'pass' as const, checkedAt: NOW }
    const none = [{ repoId: 'id-r', repo: 'r', where: 'no active plan', state: 'idle' }]
    const view = (r: BoardRepo) => runsOf(r).map((x) => [x.plan, x.where, x.state])
    const ended = (minutesAgo: number, type = 'pod:reporter') => agent({ type, plan: 'alpha', startedAt: NOW - 60 * MIN, lastAt: NOW - minutesAgo * MIN, ended: true })

    // The claim is still there, nothing of the plan has run for over 30 minutes: finished, off the list.
    expect(runsOf(repo('r', planFiles({ ...closed, queue: [resolved] }), { claims: [claim] }))).toEqual(none)
    expect(runsOf(repo('r', planFiles(closed), { claims: [claim] }))).toEqual(none)
    expect(runsOf(repo('r', planFiles({ ...closed, queue: [resolved] }), { claims: [claim], agents: [ended(31)] }))).toEqual(none)
    // A hand-back still pending in the queue but its PR known merged: pod waits for continue to clean up, so listed.
    expect(view(repo('r', planFiles({ ...closed, queue: [pending] }), { claims: [claim], prs: [merged] }))).toEqual([['alpha', 'closing out', 'needs-you']])
    expect(view(repo('r', planFiles({ ...closed, queue: [pending] }), { claims: [claim], prs: [merged], agents: [ended(120)] }))).toEqual([['alpha', 'closing out', 'needs-you']])
    // Resolved after the merge: off the list.
    expect(runsOf(repo('r', planFiles({ ...closed, queue: [resolved] }), { claims: [claim], prs: [merged] }))).toEqual(none)
    // An agent of the plan left running long ago (stale, never ended) doesn't keep it either.
    const stale = agent({ type: 'pod:reporter', plan: 'alpha', lastAt: NOW - 31 * MIN })
    expect(runsOf(repo('r', planFiles(closed), { claims: [claim], agents: [stale] }))).toEqual(none)

    // A resolved hand-back with one of its agents running: still closing out.
    const reporter = running({ type: 'pod:reporter', plan: 'alpha' })
    expect(view(repo('r', planFiles({ ...closed, queue: [resolved] }), { claims: [claim], agents: [reporter] }))).toEqual([['alpha', 'closing out', 'running']])

    // The gap between steps: the final review ended, the reporter not started yet. An agent of the plan
    // active within the last 30 minutes keeps it closing out, idle.
    expect(view(repo('r', planFiles(closed), { claims: [claim], agents: [ended(5, 'pod:reviewer')] }))).toEqual([['alpha', 'closing out', 'idle']])
    // The reporter just handed back, before pod writes the hand-back entry.
    expect(view(repo('r', planFiles(closed), { claims: [claim], agents: [ended(1)] }))).toEqual([['alpha', 'closing out', 'idle']])
    // Another plan's recent agent doesn't count.
    expect(runsOf(repo('r', planFiles(closed), { claims: [claim], agents: [{ ...ended(1), plan: 'beta' }] }))).toEqual(none)
  })

  it('order and count', () => {
    const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Gate 2 halted')
    const ask = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'gate 5 (safety-bound): hit the limit')
    // Two plans in one repo, in different states.
    const twoPlans: RepoFiles = {
      ...planFiles({ slug: 'zed' }),
      ...Object.fromEntries(Object.entries(planFiles({ slug: 'alpha', sprints: [['first', 'active']] })).filter(([k]) => k.includes('/plans/') || k.includes('/sprints/'))),
    }
    const repos = [
      repo('Bravo', twoPlans),
      repo('gone', {}, { error: 'folder not found' }),
      repo('old', { 'pod-docs/README.md': 'pod docs: 1\n' }),
      repo('charlie', planFiles({ queue: [ask] })),
      repo('alpha', planFiles(), { agents: [running({ sprint: 'one' })] }),
      repo('delta', planFiles({ queue: [halt] })),
      repo('echo', planFiles(), { agents: [running({ sprint: 'one' })] }),
    ]
    const runs = listRuns(board(...repos), NOW)
    expect(runs.map((r) => [r.state, r.repo, r.plan])).toEqual([
      ['blocked', 'delta', 'alpha'],
      ['needs-you', 'charlie', 'alpha'],
      ['running', 'alpha', 'alpha'],
      ['running', 'echo', 'alpha'],
      ['idle', 'Bravo', 'alpha'],
      ['idle', 'Bravo', 'zed'],
      ['unsupported', 'old', undefined],
      ['error', 'gone', undefined],
    ])
    expect(activeRuns(runs)).toBe(4)
    expect(activeRuns([])).toBe(0)
    const only = (state: RunSummary['state']): RunSummary[] => [{ repoId: 'x', repo: 'x', where: '', state }]
    expect(['blocked', 'needs-you', 'running', 'idle', 'unsupported', 'error'].map((s) => activeRuns(only(s as RunSummary['state'])))).toEqual([1, 1, 1, 0, 0, 0])
  })

  it('is exported from the package entry', () => {
    expect(model.listRuns).toBe(listRuns)
    expect(model.activeRuns).toBe(activeRuns)
  })
})
