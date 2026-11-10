import { describe, expect, it } from 'vitest'
import { autoSends, buildFlow, buildPipeline, buildRepoModel, listRuns, runReplies, ENGINEER_QUIET_MS, STALE_MS, type AgentRun, type BoardRepo, type PrStatus, type RunSummary } from '@openaflow/model'
import { buildWaveBoard } from '../board/board-view.ts'
import { elsewhere } from './elsewhere.ts'
import { nextSteps } from './next-step.ts'
import { entryKind } from './entry-kind.ts'
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

const AUTOPILOT = '<!-- autopilot-run: started=2026-11-01T09:00:00Z sprints=0 waves=1 -->'

function files(queue: string[], rows: Row[] = WAVES, sprintStatus = 'active', autopilot = false): Record<string, string> {
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
      ...(autopilot ? [AUTOPILOT] : []),
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

function repoOf(queue: string[], extra: Partial<BoardRepo> = {}, rows?: Row[], sprintStatus?: string, autopilot?: boolean): BoardRepo {
  return { id: 'r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(files(queue, rows, sprintStatus, autopilot)), agents: [], prs: [], claims: [], ...extra }
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
    logChip: groupChip(log.status).cls,
    next: nextStatus(steps.card.status).label,
    title: steps.card.title,
    board: { you: board.counts['needs-you'], running: board.counts.running, waiting: board.counts.waiting, blocked: board.counts.blocked },
    steps,
  }
}

const RUNNING = { flow: 'live', sidebar: 'running', log: 'running', logChip: 's-run', next: 'Running', board: { you: 0, running: 1, waiting: 1, blocked: 0 } }
const IDLE = { flow: 'wait', sidebar: 'idle', log: 'waiting', next: 'Idle', board: { you: 0, running: 0, waiting: 2, blocked: 0 } }
const STOPPED = { flow: 'you', sidebar: 'needs-you', log: 'needs you', logChip: 's-you', next: 'Needs you', board: { you: 1, running: 0, waiting: 1, blocked: 0 } }
const HALTED = { flow: 'blocked', sidebar: 'blocked', log: 'blocked', logChip: 's-bad', next: 'Blocked', board: { you: 0, running: 0, waiting: 1, blocked: 1 } }
const HALT = tagged('BLOCKED', 'orchestrator → human', 'gate 1 (blocked-concern): P1 is stuck.')
const PUSHED: Row[] = [
  [1, 'P1', '—', 'pushed'],
  [2, 'Q1', '—', 'pending'],
]
const ANSWERED_DECISION = `${DECISION} **Answer (human):** blue`
const ANSWERED_ASK = `${SLICE_ASK} **Answer (human):** the new one`

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

  it('an engineer quiet past ENGINEER_QUIET_MS reads idle everywhere, never you', () => {
    const v = views(repoOf([DECISION, UNTAGGED_NOW], { agents: [quiet(ENGINEER_QUIET_MS)] }))
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
    expect(views(repoOf([BLOCKED_TO_YOU]))).toMatchObject(STOPPED)
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

  const LOOSE_BLOCKED = entry('BLOCKED', 'orchestrator → human', '', 'gate 1 (blocked-concern): something is stuck.')
  const LOOSE_GATE = entry('PENDING', 'orchestrator → human', '', 'gate 5 (safety-bound): hit the limit.')

  it.each([
    ['BLOCKED', LOOSE_BLOCKED],
    ['halt gate', LOOSE_GATE],
  ])('a real %s with no plan is only listed on a plan run, and its views keep reading the run', (_n, line) => {
    const v = views(repoOf([line], { agents: [engineer()] }))
    expect(v).toMatchObject(RUNNING)
    expect(v.title).toBe('Nothing to do')
    expect(v.steps.rest.map((i) => i.entry?.line)).toEqual([line.trim()])
    expect(v.steps.rest[0]!.action.kind).toBe('answer')
  })

  const DONE: Row[] = [[1, 'P1', '#70', 'merged']]
  const repoRow = (line: string) => {
    const repo = repoOf([line], {}, DONE, 'done')
    return { repo, row: listRuns({ generatedAt: NOW, gh: 'ok', repos: [repo] }, NOW)[0]! }
  }

  it('a repo row keeps it as its card', () => {
    for (const line of [LOOSE_BLOCKED, LOOSE_GATE]) {
      const { repo, row } = repoRow(line)
      expect(row.plan).toBeUndefined()
      expect(nextSteps(row, repo, NOW)!.card.entry?.line).toBe(line.trim())
    }
  })

  it('a plan-less gate raises no banner from a repo row or a plan run', () => {
    const { repo } = repoRow(LOOSE_GATE)
    const selected: BoardRepo = { ...repoOf([]), id: 'o', name: 'o', path: '/o' }
    const board = { generatedAt: NOW, gh: 'ok' as const, repos: [selected, repo] }
    const runs = listRuns(board, NOW)
    expect(elsewhere(runs, board, runs.find((r) => r.repoId === 'o'), NOW)).toBeUndefined()
    const plan = repoOf([LOOSE_BLOCKED])
    const board2 = { generatedAt: NOW, gh: 'ok' as const, repos: [selected, plan] }
    const runs2 = listRuns(board2, NOW)
    expect(elsewhere(runs2, board2, runs2.find((r) => r.repoId === 'o'), NOW)).toBeUndefined()
  })
})

describe('a stop reads first on the wave in progress', () => {
  it.each([
    ['a quiet engineer', { agents: [quiet(STALE_MS + 15 * MIN)] }, undefined],
    ['a live engineer', { agents: [engineer()] }, undefined],
    ['a pushed slice', {}, PUSHED],
  ])('a halt with %s reads blocked in all six views', (_n, extra: Partial<BoardRepo>, rows: Row[] | undefined) => {
    expect(views(repoOf([HALT], extra, rows))).toMatchObject(HALTED)
  })

  it.each([
    ['no engineer', {}, undefined],
    ['an engineer quiet past ENGINEER_QUIET_MS', { agents: [quiet(ENGINEER_QUIET_MS)] }, undefined],
    ['an ended engineer', { agents: [engineer({ ended: true })] }, undefined],
    ['a pushed slice, its engineer ended', { agents: [engineer({ ended: true })] }, PUSHED],
  ])('a PENDING gate with %s reads needs you in all six views', (_n, extra: Partial<BoardRepo>, rows: Row[] | undefined) => {
    for (const gate of [GATE5, GATE6]) expect(views(repoOf([gate], extra, rows))).toMatchObject(STOPPED)
  })
})

describe('an engineer at work under a PENDING gate', () => {
  it.each([
    ['fresh', engineer()],
    ['quiet under ENGINEER_QUIET_MS', quiet(ENGINEER_QUIET_MS - MIN)],
  ])('%s: all six read running, and nothing says the run is stopped', (_n, agent) => {
    for (const gate of [GATE5, GATE6]) {
      const v = views(repoOf([gate], { agents: [agent] }))
      expect(v).toMatchObject(RUNNING)
      expect(v.title).not.toMatch(/autopilot|stopped/i)
      expect(v.steps.card.detail).not.toMatch(/stopped/i)
      // The gate stays listed and answerable.
      expect(v.steps.card.entry?.line).toBe(gate.trim())
      expect(v.steps.card.action.kind).toBe('answer')
    }
  })

  it('offers no reply and raises no banner', () => {
    const repo = repoOf([`${GATE5} **Answer (human):** go on`], { agents: [engineer()] })
    expect(runReplies(repo, PLAN, NOW)).toEqual([])
    const selected: BoardRepo = { ...repoOf([]), id: 'o', name: 'o', path: '/o' }
    const board = { generatedAt: NOW, gh: 'ok' as const, repos: [selected, repoOf([GATE5], { agents: [engineer()] })] }
    const runs = listRuns(board, NOW)
    expect(elsewhere(runs, board, runs.find((r) => r.repoId === 'o'), NOW)).toBeUndefined()
  })

  it('a halt still reads first, and so does an ask naming the slice', () => {
    expect(views(repoOf([GATE5, HALT], { agents: [engineer()] }))).toMatchObject(HALTED)
    expect(views(repoOf([GATE5, SLICE_ASK], { agents: [engineer()] }))).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'needs you', next: 'Needs you', board: { you: 1 } })
  })
})

describe("an orchestrator's plain ask", () => {
  const SENTENCE = 'paid sample run: the new prompts have met only fake models. It needs your go.'
  const ASK = tagged('PENDING', 'orchestrator → human', SENTENCE)

  it('its colon is no kind', () => {
    expect(entryKind(SENTENCE)).toEqual({ kind: 'other', label: 'other', text: SENTENCE })
  })

  it('with no engineer: needs you in all six, its text as the title, and a true line', () => {
    const v = views(repoOf([ASK]))
    expect(v).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'needs you', logChip: 's-you', next: 'Needs you', board: { you: 1, running: 0, waiting: 1, blocked: 0 } })
    expect(v.title).toBe('paid sample run: the new prompts have met only fake models. It needs your go.')
    expect(v.steps.card.detail).toBe('The run is stopped until you answer.')
    expect(v.steps.card.action.kind).toBe('answer')
  })

  it('with an engineer at work: running in all six, listed and answerable', () => {
    const v = views(repoOf([ASK], { agents: [engineer()] }))
    expect(v).toMatchObject(RUNNING)
    expect(v.steps.card.entry?.line).toBe(ASK.trim())
    expect(v.steps.card.action.kind).toBe('answer')
    expect(v.steps.card.detail).toBe('An engineer is at work on this run. Answer when you can.')
  })

  it('from a reviewer or an engineer: stops nothing', () => {
    for (const from of ['reviewer', 'engineer']) expect(views(repoOf([tagged('PENDING', `${from} → human`, SENTENCE)]))).toMatchObject(IDLE)
  })

  it.each(['someday: ', 'now: ', 'decision: ', 'before hosting: ', 'fix next: '])('from the orchestrator with %s: stops nothing', (prefix) => {
    expect(views(repoOf([tagged('PENDING', 'orchestrator → human', `${prefix}${SENTENCE}`)]))).toMatchObject(IDLE)
  })

  it('from the orchestrator with a recorded default: stops nothing', () => {
    expect(views(repoOf([tagged('PENDING', 'orchestrator → human', `${SENTENCE} Value in use: skip it.`)]))).toMatchObject(IDLE)
  })

  it('with no plan: no effect on a plan run, and still listed', () => {
    const line = entry('PENDING', 'orchestrator → human', '', SENTENCE)
    const v = views(repoOf([line]))
    expect(v).toMatchObject(IDLE)
    expect(v.title).toBe('Nothing to do')
    expect(v.steps.rest.map((i) => i.entry?.line)).toEqual([line.trim()])
  })
})

describe('the ask marker', () => {
  const ASK = (from: string, body = 'ask: which title?') => tagged('PENDING', `${from} → human`, body)

  it.each(['orchestrator', 'engineer', 'reviewer'])('from %s: needs you in all six, with no engineer', (from) => {
    const v = views(repoOf([ASK(from)]))
    expect(v).toMatchObject(STOPPED)
    expect(v.title).toBe('which title?')
    expect(v.steps.card.detail).toBe('The run is stopped until you answer.')
    expect(v.steps.card.kind?.label).toBe('ask')
  })

  it('stops also with a recorded default', () => {
    expect(views(repoOf([ASK('engineer', 'ask: pick one. Value in use: short.')]))).toMatchObject(STOPPED)
  })

  it('lifts while an engineer is at work, listed and answerable', () => {
    const v = views(repoOf([ASK('reviewer')], { agents: [engineer()] }))
    expect(v).toMatchObject(RUNNING)
    expect(v.steps.card.action.kind).toBe('answer')
    expect(v.steps.card.detail).toBe('An engineer is at work on this run. Answer when you can.')
  })

  it('with no plan: no effect on a plan run, and still listed', () => {
    const line = entry('PENDING', 'orchestrator → human', '', 'ask: which title?')
    const v = views(repoOf([line]))
    expect(v).toMatchObject(IDLE)
    expect(v.steps.rest.map((i) => i.entry?.line)).toEqual([line.trim()])
  })

  it('has its own Waiting group, first among the pending groups', () => {
    const v = views(repoOf([ASK('engineer'), tagged('PENDING', 'engineer → human', 'ask: another one?'), DECISION]))
    expect(waitGroups(v.steps.rest).map((g) => g.label)).toEqual(['Asks', 'Decisions'])
  })
})

describe('an orchestrator note that asks nothing', () => {
  const DOOR = tagged('PENDING', 'orchestrator → human', 'one-way door in PR #12 — drops the old table, undo: restore from the dump')

  it('a one-way door stops nothing with no engineer, and stays listed and answerable', () => {
    const v = views(repoOf([DOOR]))
    expect(v).toMatchObject(IDLE)
    expect(v.steps.card.entry?.line).toBe(DOOR.trim())
    expect(v.steps.card.action.kind).toBe('answer')
  })

  it('its real stop is the wave PR, while that waits', () => {
    const rows: Row[] = [
      [1, 'P1', '#12', 'pushed'],
      [2, 'Q1', '—', 'pending'],
    ]
    const v = views(repoOf([DOOR], { prs: [gh(12, 'open')] }, rows))
    expect(v).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'PR #12 open', logChip: 's-you', next: 'Needs you', board: { you: 1, running: 0, waiting: 1, blocked: 0 } })
    expect(v.title).toBe('Merge PR #12')
  })
})

describe('under autopilot, while pod holds a pushed slice', () => {
  const ROWS: Row[] = [
    [1, 'P1', '#9', 'pushed'],
    [2, 'Q1', '—', 'pending'],
  ]
  const ASK = tagged('PENDING', 'orchestrator → human', 'Which title should we use?')
  const ANSWERED = [`${ASK} **Answer (human):** the short one`, ANSWERED_DECISION]
  const ended = (ago: number) => engineer({ ended: true, lastAt: NOW - ago, active: [[NOW - ago - 30 * MIN, NOW - ago]] })
  const repo = (ago: number) => repoOf(ANSWERED, { agents: [ended(ago)], prs: [gh(9, 'open')] }, ROWS, undefined, true)
  const sends = (r: BoardRepo) => autoSends({ generatedAt: NOW, gh: 'ok', repos: [r] }, [{ path: '/r', run: PLAN }], NOW, () => true)

  it('an answered plain ask and an answered decision offer no continue, and nothing is sent', () => {
    const r = repo(10 * MIN)
    expect(runReplies(r, PLAN, NOW)).toEqual([])
    expect(sends(r)).toEqual([])
    expect(views(r).title).not.toBe('Send continue')
  })

  it('pod dead: past the window, continue returns', () => {
    expect(runReplies(repo(ENGINEER_QUIET_MS), PLAN, NOW).map((r) => r.reply)).toEqual(['continue'])
  })

  describe('the exemption: pod really stopped', () => {
    const fresh = (queue: string[], rows: Row[], number: number) => repoOf(queue, { agents: [ended(10 * MIN)], prs: [gh(number, 'open')] }, rows, undefined, true)
    const replies = (r: BoardRepo) => runReplies(r, PLAN, NOW).map((x) => x.reply)
    const LATER: Row[] = [
      [1, 'P1', '#9', 'merged'],
      [2, 'Q1', '#12', 'pushed'],
    ]

    it('a resume past an unanswered gate 5: the stale gate names no pushed PR, so no continue and nothing sent', () => {
      const r = fresh([GATE5, ANSWERED_DECISION], LATER, 12)
      expect(replies(r)).toEqual([])
      expect(sends(r)).toEqual([])
    })

    it('an answered stale gate 5 changes nothing', () => {
      const r = fresh([`${GATE5} **Answer (human):** go on`], LATER, 12)
      expect(replies(r)).toEqual([])
      expect(sends(r)).toEqual([])
    })

    it.each(['#9', 'https://github.com/o/r/pull/9'])('a gate 6 naming %s, its PR pushed, answered: continue is offered', (pr) => {
      const gate = tagged('PENDING', 'orchestrator → human', `gate 6 (escalation-valve): wave PR ${pr} is withheld.`)
      expect(replies(fresh([`${gate} **Answer (human):** go on`], ROWS, 9))).toEqual(['continue'])
    })

    it('a gate 6 naming another PR: the guard applies', () => {
      const gate = tagged('PENDING', 'orchestrator → human', 'gate 6 (escalation-valve): wave PR #99 is withheld, and #90.')
      expect(replies(fresh([`${gate} **Answer (human):** go on`], ROWS, 9))).toEqual([])
    })

    it('a BLOCKED halt with a pushed slice, answered: continue is offered', () => {
      expect(replies(fresh([`${HALT} **Answer (human):** go on`], ROWS, 9))).toEqual(['continue'])
    })
  })
})

describe('a gate from anyone but the orchestrator', () => {
  it('stops nothing, and its title stays its own words', () => {
    const note = entry('PENDING', 'reviewer → human', `plan: ${PLAN}`, 'Gate 4 was slow in CI.')
    const v = views(repoOf([note]))
    expect(v).toMatchObject(IDLE)
    expect(v.title).toBe('Gate 4 was slow in CI.')
  })
})

describe('a pushed slice', () => {
  const OPEN_PR: Row[] = [
    [1, 'P1', '#9', 'pushed'],
    [2, 'Q1', '—', 'pending'],
  ]
  const ended = (ago: number) => engineer({ ended: true, lastAt: NOW - ago, active: [[NOW - ago - 30 * MIN, NOW - ago]] })
  const toggles = [{ path: '/r', run: PLAN }]
  const sends = (repo: BoardRepo) => autoSends({ generatedAt: NOW, gh: 'ok', repos: [repo] }, toggles, NOW, () => true)
  const autopilot = (agents: AgentRun[], state: PrStatus['state'] = 'open', queue = [ANSWERED_DECISION]) => repoOf(queue, { agents, prs: [gh(9, state)] }, OPEN_PR, undefined, true)

  it('under autopilot, while pod holds it: all six read running, with no continue and nothing sent', () => {
    const repo = autopilot([ended(10 * MIN)])
    expect(views(repo)).toMatchObject(RUNNING)
    expect(runReplies(repo, PLAN, NOW)).toEqual([])
    expect(sends(repo)).toEqual([])
  })

  it('under autopilot with its PR merged: still running while pod is alive, it records the merge itself', () => {
    const repo = autopilot([ended(10 * MIN)], 'merged')
    expect(views(repo)).toMatchObject(RUNNING)
    expect(runReplies(repo, PLAN, NOW)).toEqual([])
  })

  it.each(['open', 'merged'] as const)('under autopilot, pod dead (PR %s): idle once no agent of the plan wrote for ENGINEER_QUIET_MS, and continue is the way out', (state) => {
    const repo = autopilot([ended(ENGINEER_QUIET_MS)], state)
    expect(views(repo)).toMatchObject({ flow: 'wait', sidebar: 'idle', log: 'waiting', board: { you: 0, running: 0, waiting: 2, blocked: 0 } })
    expect(runReplies(repo, PLAN, NOW).map((r) => r.reply)).toEqual(['continue'])
  })

  it('under autopilot with no agent read at all: idle, not running for ever', () => {
    expect(views(autopilot([], 'open', [DECISION]))).toMatchObject(IDLE)
  })

  it('on a manual run with its PR merged: not running, and continue is on the card', () => {
    const repo = repoOf([DECISION], { agents: [ended(10 * MIN)], prs: [gh(9, 'merged')] }, OPEN_PR)
    const v = views(repo)
    expect(v).toMatchObject({ flow: 'wait', sidebar: 'idle', log: 'waiting', board: { you: 0, running: 0, waiting: 2, blocked: 0 } })
    expect(v.title).toBe('Send continue')
  })

  it('on a manual run with no PR to wait on: running while an agent wrote lately, then idle', () => {
    expect(views(repoOf([DECISION], { agents: [ended(10 * MIN)] }, PUSHED))).toMatchObject(RUNNING)
    expect(views(repoOf([DECISION], { agents: [ended(ENGINEER_QUIET_MS)] }, PUSHED))).toMatchObject(IDLE)
  })
})

describe('the reply follows the running rule', () => {
  const toggles = [{ path: '/r', run: PLAN }]

  it('an answered decision and an engineer quiet 45 min: no reply, no auto send, all six read running', () => {
    const repo = repoOf([ANSWERED_DECISION], { agents: [quiet(STALE_MS + 15 * MIN)] })
    expect(views(repo)).toMatchObject(RUNNING)
    expect(runReplies(repo, PLAN, NOW)).toEqual([])
    expect(autoSends({ generatedAt: NOW, gh: 'ok', repos: [repo] }, toggles, NOW, () => true)).toEqual([])
  })

  it('a dead engineer: continue is offered once it has been quiet ENGINEER_QUIET_MS', () => {
    const repo = repoOf([ANSWERED_DECISION], { agents: [quiet(ENGINEER_QUIET_MS)] })
    expect(runReplies(repo, PLAN, NOW).map((r) => r.reply)).toEqual(['continue'])
    expect(ENGINEER_QUIET_MS).toBe(60 * MIN)
  })

  it('a stopped run does not wait for the window: past the live window, continue is offered', () => {
    for (const line of [`${HALT} **Answer (human):** go on`, ANSWERED_ASK]) {
      const repo = repoOf([line], { agents: [quiet(STALE_MS + 15 * MIN)] })
      expect(views(repo).sidebar).not.toBe('running')
      expect(runReplies(repo, PLAN, NOW).map((r) => r.reply)).toEqual(['continue'])
    }
  })
})

describe('the Log on a wave pod is merging', () => {
  const rows: Row[] = [
    [1, 'P1', '#9', 'pushed'],
    [2, 'Q1', '—', 'pending'],
  ]

  it('reads running while no PR waits on you, and PR #N open once one does', () => {
    const merging = views(repoOf([DECISION], { agents: [engineer({ ended: true })], prs: [gh(9, 'open')] }, rows, undefined, true))
    expect(merging).toMatchObject({ flow: 'live', sidebar: 'running', log: 'running', logChip: 's-run', next: 'Running', board: { you: 0, running: 1, waiting: 1, blocked: 0 } })
    expect(merging.detail).toBe('PR #9 · autopilot merges')
    const stopped = views(repoOf([GATE6], { prs: [gh(9, 'open')] }, rows, undefined, true))
    expect(stopped).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'PR #9 open', logChip: 's-you', next: 'Needs you', board: { you: 1, running: 0, waiting: 1, blocked: 0 } })
  })
})

describe('the card says the run state', () => {
  it('an answered slice ask, an open decision and a live engineer read needs you, never Idle', () => {
    const v = views(repoOf([ANSWERED_ASK, DECISION], { agents: [engineer()] }))
    expect(v).toMatchObject({ flow: 'you', sidebar: 'needs-you', log: 'needs you', next: 'Needs you', board: { you: 1 } })
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
