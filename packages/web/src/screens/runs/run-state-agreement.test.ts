import { describe, expect, it } from 'vitest'
import { buildFlow, buildPipeline, buildRepoModel, listRuns, QUIET_MS, STALE_MS, type AgentRun, type BoardRepo, type PrStatus, type RunSummary } from '@pod-board/model'
import { buildWaveBoard } from '../board/board-view.ts'
import { elsewhere } from './elsewhere.ts'
import { nextSteps } from './next-step.ts'
import { waitGroups } from './waiting-tab.ts'
import { groupChip, nextStatus } from './view.ts'

// One plan, one fixture, five views. The run flow, the sidebar, the Log tab, the Next step card and the wave
// board read one rule for "stopped" (`stopsRun`) and one for "running" (`isWaveRunning`), so they can't disagree.

const NOW = Date.UTC(2026, 10, 3, 12)
const MIN = 60_000
const PLAN = 'alpha'

const entry = (type: string, route: string, tags: string, body: string) => `- \`[2026-11-01 · ${type} · ${route}${tags ? ` · ${tags}` : ''}]\` ${body} **Resolution:** pending`
const tagged = (type: string, route: string, body: string) => entry(type, route, `plan: ${PLAN}`, body)

const DECISION = tagged('PENDING', 'engineer → human', 'decision: the accent colour. Value in use: white.')
const DEFAULT_ENTRY = tagged('PENDING', 'engineer → human', 'decision: the row height. Default: 40 px.')
const SOMEDAY = tagged('PENDING', 'reviewer → human', 'someday: cache the reply.')
const UNTAGGED_NOW = entry('PENDING', 'engineer → human', '', 'now: two repos share one id, an unrelated PR.')

const GATE5 = tagged('PENDING', 'orchestrator → human', 'gate 5 (safety-bound): hit the wave limit.')
const GATE6 = tagged('PENDING', 'orchestrator → human', 'gate 6 (escalation-valve): the rule says hold it.')
const GATE7 = tagged('PENDING', 'orchestrator → human', 'gate 7 (plan-complete): plan alpha is merged to staging.')
const COMPLETE = tagged('PENDING', 'orchestrator → human', 'plan alpha complete — final PR https://github.com/o/r/pull/80, review pass.')
const BLOCKED_TO_YOU = entry('BLOCKED', 'engineer → human', `plan: ${PLAN} · sprint: core · slice: P1`, 'P1 cannot reach the rates file.')
const SLICE_ASK = entry('PENDING', 'engineer → human', `plan: ${PLAN} · sprint: core · slice: P1`, 'Needs your decision: which rates file?')
const SLICE_WITH_DEFAULT = entry('PENDING', 'engineer → human', `plan: ${PLAN} · sprint: core · slice: P1`, 'decision: which rates file? Value in use: the old one.')

type Row = [wave: number, code: string, pr: string, status: string]
const WAVES: Row[] = [
  [1, 'P1', '—', 'pending'],
  [2, 'Q1', '—', 'pending'],
]

function files(queue: string[], rows: Row[] = WAVES, sprintStatus = 'active'): Record<string, string> {
  return {
    'pod-docs/README.md': '# pod docs\n\npod docs: 2\n',
    'pod-docs/decisions.md': '# Decisions\n\n## 2026-10-18 — merge target: staging\n\nMerge target: `pod-staging`.\n',
    [`pod-docs/plans/${PLAN}.md`]: [
      '# Plan: Alpha',
      '',
      '_Generated: 2026-10-18 · Status: active_',
      '',
      '## Sprint sequence',
      '',
      '| Sprint | Goal | Status | Depends on |',
      '|--------|------|--------|------------|',
      `| core | goal | ${sprintStatus} | — |`,
      '',
    ].join('\n'),
    'pod-docs/sprints/core.md': [
      '# Sprint: core',
      '',
      `_From plan: pod-docs/plans/${PLAN}.md · Slug: core · Status: active · Generated: 2026-10-18_`,
      '',
      '## Status board',
      '',
      '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
      '|------|-------|-------|--------|----|--------|------------|------------|',
      ...rows.map(([w, code, pr, status]) => `| ${w} | ${code} | Title ${code} | core-${code} | ${pr} | ${status} | medium | — |`),
      '',
    ].join('\n'),
    'pod-docs/handoff-queue.md': ['# Handoff queue', '', ...queue, ''].join('\n'),
  }
}

const engineer = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'e1',
  session: 'sess-1',
  type: 'pod:engineer',
  tokens: 510_000,
  ended: false,
  plan: PLAN,
  sprint: 'core',
  slice: 'P1',
  startedAt: NOW - 60 * MIN,
  active: [[NOW - 60 * MIN, NOW - 26 * MIN]],
  lastAt: NOW - 1 * MIN,
  ...over,
})
const quiet = (ms: number) => engineer({ lastAt: NOW - ms, active: [[NOW - ms - 34 * MIN, NOW - ms]] })
const CLAIM = { portBase: 3000, repoPath: '/r', plan: PLAN }
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })

function repoOf(queue: string[], extra: Partial<BoardRepo> = {}, rows?: Row[], sprintStatus?: string): BoardRepo {
  return { id: 'r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(files(queue, rows, sprintStatus)), agents: [], prs: [], claims: [], ...extra }
}
const runOf = (repo: BoardRepo): RunSummary => listRuns({ generatedAt: NOW, gh: 'ok', repos: [repo] }, NOW).find((r) => r.plan === PLAN)!

/** The five views' readings of one Board. */
function views(repo: BoardRepo) {
  const run = runOf(repo)
  const flow = buildFlow(repo, PLAN, NOW)!.flatMap((c) => c.steps)
  const log = buildPipeline(repo, PLAN, NOW)!.log.find((g) => g.wave === 1)!
  const board = buildWaveBoard(repo, PLAN, NOW)!
  const steps = nextSteps(run, repo, NOW)!
  return {
    flow: flow.find((s) => s.label === 'Wave 1')?.state,
    detail: flow.find((s) => s.label === 'Wave 1')?.detail,
    sidebar: run.state,
    log: log.status,
    next: nextStatus(steps.card.status).label,
    title: steps.card.title,
    board: { you: board.counts['needs-you'], running: board.counts.running, waiting: board.counts.waiting, blocked: board.counts.blocked },
    steps,
  }
}

const RUNNING = { flow: 'live', sidebar: 'running', log: 'running', next: 'Running', board: { you: 0, running: 1, waiting: 1, blocked: 0 } }
const IDLE = { flow: 'wait', sidebar: 'idle', log: 'waiting', next: 'Idle', board: { you: 0, running: 0, waiting: 2, blocked: 0 } }
const STOPPED = { flow: 'you', sidebar: 'needs-you', log: 'needs you', next: 'Needs you', board: { you: 1, running: 0, waiting: 1, blocked: 0 } }

describe('the views agree on what stops a run', () => {
  it('the bug: value-in-use decisions and an untagged now entry, engineer live, read running everywhere', () => {
    const v = views(repoOf([DECISION, UNTAGGED_NOW], { agents: [engineer()] }))
    expect(v).toMatchObject(RUNNING)
    expect(v.detail).toMatch(/min so far$/)
  })

  it('an engineer quiet past the live window, on a long step, still reads running everywhere', () => {
    const v = views(repoOf([DECISION, UNTAGGED_NOW], { agents: [quiet(STALE_MS + 15 * MIN)] }))
    expect(v).toMatchObject(RUNNING)
  })

  it('an engineer quiet past QUIET_MS reads idle everywhere, never you', () => {
    const v = views(repoOf([DECISION, UNTAGGED_NOW], { agents: [quiet(QUIET_MS)] }))
    expect(v).toMatchObject(IDLE)
  })

  it.each([
    ['gate 5', GATE5],
    ['gate 6', GATE6],
  ])('a %s halt reads needs-you everywhere, beside a decision', (_n, halt) => {
    expect(views(repoOf([DECISION, halt]))).toMatchObject(STOPPED)
    // The same plan without the halt doesn't stop: only the halt made it.
    expect(views(repoOf([DECISION]))).toMatchObject(IDLE)
  })

  it('a slice-naming ask with no default stops the run; the same ask with a default does not', () => {
    expect(views(repoOf([SLICE_ASK]))).toMatchObject(STOPPED)
    expect(views(repoOf([SLICE_WITH_DEFAULT]))).toMatchObject(IDLE)
  })

  it('a slice-naming ask with an engineer at work reads needs you in the flow, Log and board', () => {
    expect(views(repoOf([SLICE_ASK], { agents: [engineer()] }))).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'needs you', next: 'Needs you', board: { you: 1 } })
  })

  it('a BLOCKED to you reads needs-you, a BLOCKED between agents changes nothing', () => {
    expect(views(repoOf([BLOCKED_TO_YOU]))).toMatchObject({ ...STOPPED, next: 'Blocked' })
    const between = entry('BLOCKED', 'engineer → orchestrator', `plan: ${PLAN}`, 'the tool is missing.')
    expect(views(repoOf([between]))).toMatchObject(IDLE)
  })

  it("the orchestrator's BLOCKED halt reads blocked everywhere", () => {
    const halt = tagged('BLOCKED', 'orchestrator → human', 'gate 1 (blocked-concern): P1 is stuck.')
    expect(views(repoOf([DECISION, halt]))).toMatchObject({ flow: 'blocked', sidebar: 'blocked', log: 'blocked', next: 'Blocked', board: { you: 0, running: 0, waiting: 1, blocked: 1 } })
  })

  it('a waiting wave PR reads needs-you, beside a decision', () => {
    const repo = repoOf([DECISION], { prs: [gh(78, 'open')] }, [
      [1, 'P1', '#78', 'pushed'],
      [2, 'Q1', '—', 'pending'],
    ])
    const v = views(repo)
    expect(v).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'PR #78 open', next: 'Needs you', board: { you: 1, running: 0 } })
    expect(groupChip(v.log).cls).toBe('s-you')
    expect(v.title).toBe('Merge PR #78')
  })

  it('a staging PR reads needs-you once the final PR merged', () => {
    const repo = repoOf([], { claims: [CLAIM], prs: [gh(13, 'open', { branch: 'pod-staging', base: 'main' }), gh(80, 'merged', { branch: PLAN, base: 'pod-staging' })] }, [[1, 'P1', '#70', 'merged']], 'done')
    const run = runOf(repo)
    expect(run.state).toBe('needs-you')
    expect(buildFlow(repo, PLAN, NOW)!.flatMap((c) => c.steps).find((s) => s.key === 'staging')?.state).toBe('you')
    expect(nextStatus(nextSteps(run, repo, NOW)!.card.status).label).toBe('Needs you')
  })

  it.each([
    ['gate 7', GATE7],
    ['a plan-complete hand-back', COMPLETE],
  ])('%s reads needs-you with every slice done', (_n, handBack) => {
    const repo = repoOf([handBack], { claims: [CLAIM] }, [[1, 'P1', '#70', 'merged']], 'done')
    const run = runOf(repo)
    expect(run.state).toBe('needs-you')
    expect(nextStatus(nextSteps(run, repo, NOW)!.card.status).label).toBe('Needs you')
    // A value-in-use decision on the same finished plan doesn't hold the state.
    expect(runOf(repoOf([DECISION], { claims: [CLAIM] , agents: [engineer({ slice: 'P1' })] }, [[1, 'P1', '#70', 'merged']], 'done')).state).toBe('running')
  })

  it('an idle plan with only someday or default entries reads idle, and each stays listed and counted', () => {
    const repo = repoOf([SOMEDAY, DEFAULT_ENTRY, DECISION])
    const v = views(repo)
    expect(v).toMatchObject(IDLE)
    const items = [v.steps.card, ...v.steps.rest]
    expect(items.map((i) => i.entry?.line)).toEqual(expect.arrayContaining([SOMEDAY, DEFAULT_ENTRY, DECISION].map((l) => l.trim())))
    expect(items.every((i) => i.action.kind === 'answer')).toBe(true)
    // The card holds one; the Waiting tab lists and counts the rest, each in its kind's group.
    expect(v.steps.rest).toHaveLength(2)
    expect(waitGroups(v.steps.rest).flatMap((g) => g.items)).toHaveLength(2)
  })

  it('a non-stopping entry on the card keeps its value line and reads the run state, not Needs you', () => {
    const v = views(repoOf([DECISION], { agents: [engineer()] }))
    expect(v.next).toBe('Running')
    expect(v.title).toBe('the accent colour. Value in use: white.')
    expect(v.steps.card.detail).toBe('pod goes on with the value in use until you answer.')
  })

  it('a stopping PENDING on the card says the run is stopped, never that pod goes on', () => {
    expect(views(repoOf([SLICE_ASK])).steps.card.detail).toBe('The run is stopped until you answer.')
  })
})

describe('an untagged entry', () => {
  it('changes no state and no headline, and stays listed', () => {
    const v = views(repoOf([UNTAGGED_NOW]))
    expect(v).toMatchObject(IDLE)
    expect(v.title).toBe('Nothing to do')
    expect(v.steps.rest.map((i) => i.entry?.line)).toEqual([UNTAGGED_NOW.trim()])
    expect(v.steps.rest[0]!.action.kind).toBe('answer')
  })

  it('never takes the card from a tagged decision', () => {
    const v = views(repoOf([UNTAGGED_NOW, DECISION]))
    expect(v.title).toBe('the accent colour. Value in use: white.')
    expect(v.steps.rest.map((i) => i.entry?.line)).toEqual([UNTAGGED_NOW.trim()])
  })

  it('raises no urgent banner', () => {
    const repo = repoOf([UNTAGGED_NOW])
    const other: BoardRepo = { ...repoOf([]), id: 'o', name: 'o', path: '/o' }
    const board = { generatedAt: NOW, gh: 'ok' as const, repos: [repo, other] }
    const runs = listRuns(board, NOW)
    expect(elsewhere(runs, board, runs.find((r) => r.repoId === 'o'), NOW)).toBeUndefined()
    expect(elsewhere(runs, board, runs.find((r) => r.repoId === 'r'), NOW)).toBeUndefined()
  })

  it('a real halt or BLOCKED to you with no plan stays on the card as today, and leaves the run state alone', () => {
    const blocked = entry('BLOCKED', 'orchestrator → human', '', 'gate 1 (blocked-concern): something is stuck.')
    const v = views(repoOf([blocked], { agents: [engineer()] }))
    expect(v.sidebar).toBe('running')
    expect(v.next).toBe('Blocked')
  })
})

describe('the urgent banner follows the predicate', () => {
  const selected = () => ({ ...repoOf([]), id: 'o', name: 'o', path: '/o' })
  const banner = (queue: string[]) => {
    const board = { generatedAt: NOW, gh: 'ok' as const, repos: [selected(), repoOf(queue)] }
    const runs = listRuns(board, NOW)
    return elsewhere(runs, board, runs.find((r) => r.repoId === 'o'), NOW)
  }

  it('another run\'s non-stopping decision raises none', () => {
    expect(banner([DECISION])).toBeUndefined()
  })

  it('another run\'s stop raises one, also over a selected card that only holds a decision', () => {
    expect(banner([SLICE_ASK])?.item.key).toBe(`entry:${SLICE_ASK.trim()}`)
    const a = repoOf([GATE5])
    const b: BoardRepo = { ...repoOf([DECISION]), id: 'o', name: 'o', path: '/o' }
    const board = { generatedAt: NOW, gh: 'ok' as const, repos: [a, b] }
    const runs = listRuns(board, NOW)
    expect(elsewhere(runs, board, runs.find((r) => r.repoId === 'o'), NOW)?.run.repoId).toBe('r')
  })
})
