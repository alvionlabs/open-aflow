import { describe, expect, it } from 'vitest'
import * as model from './index.ts'
import type { AgentRun, BoardRepo, PrStatus } from './board.ts'
import { buildPipeline, haltGate, isRun, planState, type Pipeline, type Stage } from './pipeline.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 9, 18, 12)
const T0 = NOW - 5 * 60 * 60_000
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string, confidence?: string, model?: string]

function planDoc(title: string, sprints: SprintRow[]): string {
  return [
    `# Plan: ${title}`,
    '',
    '_Generated: 2026-10-18 · Status: active · Grilled-with: grilling_',
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
    ...board.map(([w, code, pr, status, conf]) => `| ${w} | ${code} | Title ${code} | ${slug}-${code} | ${pr} | ${status} | ${conf ?? 'medium'} | — |`),
    '',
    '## Per-slice detail',
    '',
    ...board.flatMap(([, code, , , , m]) => [`### ${code}: Title ${code}`, '- **Scope:** do it', ...(m ? [`- **Model:** ${m}`] : []), '']),
  ].join('\n')
}

type Docs = { sprints: SprintRow[]; docs?: Record<string, BoardRow[]>; archived?: Record<string, BoardRow[]>; queue?: string[] }

function files({ sprints, docs = {}, archived = {}, queue = [] }: Docs, slug = 'alpha'): RepoFiles {
  const out: RepoFiles = {
    'pod-docs/README.md': README,
    [`pod-docs/plans/${slug}.md`]: planDoc(slug.toUpperCase(), sprints),
    'pod-docs/handoff-queue.md': queue.join('\n'),
  }
  for (const [s, rows] of Object.entries(docs)) out[`pod-docs/sprints/${s}.md`] = sprintDoc(s, slug, rows)
  for (const [s, rows] of Object.entries(archived)) out[`pod-docs/sprints/archive/${s}.md`] = sprintDoc(s, slug, rows)
  return out
}

function repo(f: RepoFiles, extra: Partial<BoardRepo> = {}): BoardRepo {
  return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(f), agents: [], prs: [], claims: [], ...extra }
}

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', description: '', tokens: 0, ended: false, ...over }
}
const running = (over: Partial<AgentRun>) => agent({ startedAt: NOW - 10 * MIN, lastAt: NOW - MIN, ...over })
const ended = (over: Partial<AgentRun>) => agent({ startedAt: T0, lastAt: T0 + 10 * MIN, ended: true, ...over })

const queueLine = (type: string, route: string, fields: string, body: string, pending = true) =>
  `- \`[2026-10-18 · ${type} · ${route} · ${fields}]\` ${body} **Resolution:** ${pending ? 'pending' : 'fixed in #9'}`

const pr = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`

const build = (r: BoardRepo, plan = 'alpha'): Pipeline => {
  const p = buildPipeline(r, plan, NOW)
  if (!p) throw new Error(`no pipeline for ${plan}`)
  return p
}
const stage = (p: Pipeline, key: string): Stage => {
  const s = p.stages.find((x) => x.key === key)
  if (!s) throw new Error(`no stage ${key}`)
  return s
}
const steps = (p: Pipeline, key: string) => stage(p, key).steps.map((s) => [s.label, s.state, s.detail])
const stepStates = (p: Pipeline, key: string) => stage(p, key).steps.map((s) => s.state)

describe('buildPipeline', () => {
  it('stages of a mid-run plan', () => {
    const r = repo(
      files({
        sprints: [['s1', 'done'], ['s2', 'active'], ['s3', 'planned']],
        archived: { s1: [[1, 'A1', `${pr(41)} merged`, 'done'], [2, 'A2', `${pr(42)} merged`, 'done']] },
        docs: { s2: [[1, 'B1', `${pr(50)} merged`, 'done'], [2, 'B2', '—', 'pending'], [3, 'B3', '—', 'pending'], [3, 'B4', '—', 'pending']] },
      }),
    )
    const p = build(r)
    expect(p.stages.map((s) => [s.key, s.caption])).toEqual([
      ['plan', 'Plan'],
      ['sprint:s1', 'Sprint 1 of 3'],
      ['sprint:s2', 'Sprint 2 of 3'],
      ['sprint:s3', 'Sprint 3 of 3'],
      ['check', 'Check'],
      ['ship', 'Ship'],
    ])
    expect(steps(p, 'plan')).toEqual([
      ['Plan', 'done', '3 sprints'],
      ['Go', 'unknown', 'not recorded yet'],
    ])
    expect(steps(p, 'sprint:s1')).toEqual([['s1', 'done', '2 waves']])
    expect(stage(p, 'sprint:s2').steps.map((s) => [s.label, s.state])).toEqual([
      ['Wave 1', 'done'],
      // The wave in progress, with no engineer of its own at work: it waits (only its engineer makes it run).
      ['Wave 2', 'wait'],
      ['Wave 3', 'wait'],
    ])
    expect(stage(p, 'sprint:s2').steps[1]?.detail).not.toMatch(/planned/)
    expect(stage(p, 'sprint:s2').steps[2]?.detail).toBe('2 slices planned')
    expect(steps(p, 'sprint:s3')).toEqual([['s3', 'wait', 'not drafted']])
    expect(steps(p, 'check')).toEqual([
      ['Final review', 'wait', 'not started'],
      ['Fix pass', 'wait', 'only if review fails'],
    ])
    expect(steps(p, 'ship')).toEqual([['Final PR', 'wait', 'not open yet']])
    // Step keys are unique across the pipeline, so the screen can key on them.
    const keys = p.stages.flatMap((s) => s.steps.map((x) => x.key))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('wave step state', () => {
    const ask = (slice: string, sprint = 'one') => queueLine('PENDING', 'engineer → human', `sprint: ${sprint} · slice: ${slice}`, 'Pick one')
    const r = repo(
      files({
        sprints: [['one', 'active']],
        docs: {
          one: [
            [1, 'W1', '—', 'blocked'],
            [2, 'W2', 'merged', 'done'],
            [3, 'W3', 'merged', 'done'],
            [4, 'W4', pr(4), 'pushed'],
            [5, 'W5', '—', 'pending'],
            [6, 'W6', '—', 'pending'],
            [7, 'W7', 'skipped', 'done'],
            [8, 'W8', '—', 'pending'],
            [9, 'W9a', 'merged', 'done'],
            [9, 'W9b', '—', 'pending'],
            [10, 'W10a', 'merged', 'done'],
            [10, 'W10b', '—', 'pending'],
          ],
        },
        queue: [
          ask('W1'), // blocked wins over you
          ask('W2'), // done wins over you: a finished wave reads done
          queueLine('PENDING', 'engineer → human', 'sprint: one · slice: W3', 'old', false), // resolved: no you
          ask('W6', 'other'), // another sprint's slice: no you
          ask('W8'), // an unfinished wave: you
          ask('W9a'), // only a done slice asks: the wave isn't you
          ask('W10b'), // an unfinished slice of a part-done wave asks: you
        ],
      }),
      { agents: [running({ sprint: 'one', slice: 'W5' })] },
    )
    // W4: pushed with its PR open and nothing running is handed back to you to merge.
    expect(stepStates(build(r), 'sprint:one')).toEqual(['blocked', 'done', 'done', 'you', 'live', 'wait', 'blocked', 'you', 'wait', 'you'])

    // The current wave with nothing pushed and no engineer is not running: it waits, as the idle run does.
    const fresh = repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'X1', '—', 'pending'], [2, 'X2', '—', 'pending']] } }))
    expect(stepStates(build(fresh), 'sprint:one')).toEqual(['wait', 'wait'])
    // A stale engineer doesn't make a later wave live.
    const stale = repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'X1', '—', 'pending'], [2, 'X2', '—', 'pending']] } }), {
      agents: [agent({ sprint: 'one', slice: 'X2', startedAt: T0, lastAt: T0 })],
    })
    expect(stepStates(build(stale), 'sprint:one')).toEqual(['wait', 'wait'])
  })

  it('wave time and tokens', () => {
    const r = repo(
      files({
        sprints: [['one', 'active']],
        docs: { one: [[1, 'W1', 'merged', 'done'], [1, 'W2', 'merged', 'done'], [2, 'X1', '—', 'pending'], [3, 'Y1', '—', 'pending']] },
      }),
      {
        agents: [
          ended({ sprint: 'one', slice: 'W1', startedAt: T0, lastAt: T0 + 20 * MIN, tokens: 300_000 }),
          ended({ sprint: 'one', slice: 'W2', startedAt: T0 + 5 * MIN, lastAt: T0 + 41 * MIN, tokens: 312_000 }),
          // A wave fix counts toward its wave, not a slice.
          ended({ sprint: 'one', branch: 'one-w1-fix', startedAt: T0 + 42 * MIN, lastAt: T0 + 50 * MIN + 20_000, tokens: 10_000 }),
          // Live: the span runs to now, not to the last record.
          running({ sprint: 'one', slice: 'X1', startedAt: NOW - 14 * MIN, lastAt: NOW - 5 * MIN, tokens: 900 }),
        ],
      },
    )
    const p = build(r)
    expect(steps(p, 'sprint:one')).toEqual([
      ['Wave 1', 'done', '3 engineers · 50 min · 622k tok'],
      ['Wave 2', 'live', '1 engineer · 14 min so far'],
      ['Wave 3', 'wait', '1 slice planned'],
    ])
    // The wave fix's tokens stay off the slice rows.
    expect(p.log[0]?.rows.map((row) => [row.code, row.minutes, row.tokens])).toEqual([
      ['W1', 20, 300_000],
      ['W2', 36, 312_000],
    ])

    // No agents: time and tokens are left out, never shown as 0.
    const quiet = repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'W1', 'merged', 'done'], [2, 'X1', '—', 'pending']] } }))
    const details = stage(build(quiet), 'sprint:one').steps.map((s) => s.detail)
    expect(details).toEqual(['1 slice', '1 slice'])
    expect(build(quiet).log[0]?.rows[0]).not.toHaveProperty('minutes')
    expect(build(quiet).log[0]?.rows[0]).not.toHaveProperty('tokens')
    // Agents with no times: no minutes, but their tokens count.
    const untimed = repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'W1', 'merged', 'done'], [2, 'X1', '—', 'pending']] } }), {
      agents: [agent({ sprint: 'one', slice: 'W1', ended: true, tokens: 5_000 })],
    })
    expect(stage(build(untimed), 'sprint:one').steps[0]?.detail).toBe('1 engineer · 5.0k tok')
  })

  it('agents join slices', () => {
    const r = repo(
      files({
        sprints: [['s1', 'done'], ['s2', 'active']],
        archived: { s1: [[1, 'A1', 'merged', 'done']] },
        docs: { s2: [[1, 'A1', '—', 'pending'], [1, 'A2', '—', 'pending']] },
      }),
      {
        agents: [
          ended({ sprint: 's2', slice: 'A1', tokens: 100 }),
          // A slice with no sprint joins the first sprint, in plan order, whose board has the code.
          ended({ slice: 'A1', tokens: 20 }),
          ended({ slice: 'A2', tokens: 3 }),
          // Another plan's sprint, or a code its sprint doesn't have: no slice.
          ended({ sprint: 's9', slice: 'A1', tokens: 5 }),
          ended({ sprint: 's2', slice: 'ZZ', tokens: 7 }),
        ],
      },
    )
    const rows = build(r).log.flatMap((g) => g.rows.map((row) => [g.sprint, row.code, row.tokens]))
    expect(rows).toEqual([
      ['s1', 'A1', 20],
      ['s2', 'A1', 100],
      ['s2', 'A2', 3],
    ])
  })

  it('check and ship stages', () => {
    const done = { sprints: [['one', 'done']] as SprintRow[], docs: { one: [[1, 'A1', 'merged', 'done']] as BoardRow[] } }
    const check = (agents: AgentRun[]) => steps(build(repo(files(done), { agents })), 'check')
    const reviewer = (over: Partial<AgentRun>) => ({ type: 'pod:reviewer', plan: 'alpha', ...over })

    expect(check([ended(reviewer({ round: 1 })), running(reviewer({ round: 2 }))])[0]).toEqual(['Final review', 'live', 'round 2'])
    expect(check([ended(reviewer({ round: 1 })), ended(reviewer({ round: 2 }))])[0]).toEqual(['Final review', 'done', '2 rounds'])
    expect(check([ended(reviewer({ round: 1 }))])[0]).toEqual(['Final review', 'done', '1 round'])
    // A round with no number is counted.
    expect(check([ended(reviewer({})), running(reviewer({}))])[0]).toEqual(['Final review', 'live', 'round 2'])
    // Another plan's reviewer isn't this plan's review.
    expect(check([running(reviewer({ plan: 'beta' }))])[0]).toEqual(['Final review', 'wait', 'not started'])

    expect(check([running({ branch: 'alpha-fix' })])[1]).toEqual(['Fix pass', 'live', 'pass 1'])
    expect(check([ended({ branch: 'alpha-fix' })])[1]).toEqual(['Fix pass', 'done', '1 pass'])
    expect(check([ended({ branch: 'beta-fix' })])[1]).toEqual(['Fix pass', 'wait', 'only if review fails'])

    const handBack = (n: number, pending = true, route = 'orchestrator → human') =>
      queueLine('PENDING', route, 'plan: alpha', `Plan complete: merge https://github.com/o/r/pull/${n}`, pending)
    const status = (n: number, state: PrStatus['state']): PrStatus => ({ number: n, state, checks: 'pass', checkedAt: NOW })
    const ship = (queue: string[], prs: PrStatus[] = []) => steps(build(repo(files({ ...done, queue }), { prs })), 'ship')

    expect(ship([handBack(12)])).toEqual([['Final PR', 'you', 'PR #12 · you merge']])
    expect(ship([handBack(12)], [status(12, 'open')])).toEqual([['Final PR', 'you', 'PR #12 · you merge']])
    expect(ship([handBack(12)], [status(12, 'merged')])).toEqual([['Final PR', 'done', 'merged PR #12']])
    // The last pending hand-back wins.
    expect(ship([handBack(12), handBack(13)], [status(12, 'merged')])).toEqual([['Final PR', 'you', 'PR #13 · you merge']])
    // Resolved, not from the orchestrator, or with no PR link: no hand-back.
    expect(ship([handBack(12, false)])).toEqual([['Final PR', 'wait', 'not open yet']])
    expect(ship([handBack(12, true, 'engineer → human')])).toEqual([['Final PR', 'wait', 'not open yet']])
    expect(ship([queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'Plan complete, awaiting you')])).toEqual([['Final PR', 'wait', 'not open yet']])
  })

  it('ship: the final PR found by its head branch, before the hand-back exists', () => {
    const done = { sprints: [['one', 'done']] as SprintRow[], docs: { one: [[1, 'A1', 'merged', 'done']] as BoardRow[] } }
    const byBranch = (n: number, state: PrStatus['state'], branch = 'alpha'): PrStatus => ({ number: n, state, checks: 'pass', checkedAt: NOW, branch })
    const handBack = (n: number, pending = true) =>
      queueLine('PENDING', 'orchestrator → human', 'plan: alpha', `Plan complete: merge https://github.com/o/r/pull/${n}`, pending)
    const ship = (prs: PrStatus[], queue: string[] = []) => steps(build(repo(files({ ...done, queue }), { prs })), 'ship')

    // Open: pod hands it back only after the final review, so it isn't yours to merge yet.
    expect(ship([byBranch(12, 'open')])).toEqual([['Final PR', 'wait', 'PR #12 · after review']])
    expect(ship([byBranch(12, 'merged')])).toEqual([['Final PR', 'done', 'merged PR #12']])
    expect(ship([byBranch(12, 'closed')])).toEqual([['Final PR', 'blocked', 'PR #12 · closed']])
    // Another branch's PR, or one found by number only, isn't this plan's final PR.
    expect(ship([byBranch(12, 'open', 'beta')])).toEqual([['Final PR', 'wait', 'not open yet']])
    expect(ship([byBranch(12, 'open', 'fix-alpha')])).toEqual([['Final PR', 'wait', 'not open yet']])
    expect(ship([{ number: 12, state: 'open', checks: 'pass', checkedAt: NOW }])).toEqual([['Final PR', 'wait', 'not open yet']])
    // Once the hand-back exists, its PR wins over the branch's.
    expect(ship([byBranch(12, 'merged')], [handBack(13)])).toEqual([['Final PR', 'you', 'PR #13 · you merge']])
    expect(ship([byBranch(13, 'open')], [handBack(13)])).toEqual([['Final PR', 'you', 'PR #13 · you merge']])
    // A resolved hand-back is no hand-back: the branch's PR shows again.
    expect(ship([byBranch(13, 'merged')], [handBack(13, false)])).toEqual([['Final PR', 'done', 'merged PR #13']])
  })

  it('slice log', () => {
    const r = repo(
      files({
        sprints: [['s1', 'done'], ['s2', 'active'], ['s3', 'planned']],
        archived: { s1: [[1, 'A1', `${pr(41)} merged`, 'done', 'high', 'opus'], [2, 'A2', '—', 'done', '—', 'Sonnet 4.5']] },
        docs: {
          s2: [
            [1, 'B1', pr(50), 'pushed'],
            [2, 'B2', '—', 'pending', '—', 'opus'],
            [3, 'B3', '—', 'pending'],
            [4, 'B4', '—', 'blocked'],
          ],
        },
      }),
      {
        agents: [
          ended({ sprint: 's1', slice: 'A1', startedAt: T0, lastAt: T0 + 30 * MIN, tokens: 1000 }),
          running({ sprint: 's2', slice: 'B2', startedAt: NOW - 14 * MIN, lastAt: NOW - MIN, tokens: 500 }),
        ],
      },
    )
    const log = build(r).log
    expect(log.map((g) => [g.sprint, g.wave, g.label, g.status])).toEqual([
      ['s1', 1, 'Sprint 1 · wave 1', 'merged PR #41'],
      ['s1', 2, 'Sprint 1 · wave 2', 'merged'],
      ['s2', 1, 'Sprint 2 · wave 1', 'PR #50 open'],
      // B4 blocks the run, but B2's engineer is at work: its wave still reads running.
      ['s2', 2, 'Sprint 2 · wave 2', 'running'],
      ['s2', 3, 'Sprint 2 · wave 3', 'planned'],
      ['s2', 4, 'Sprint 2 · wave 4', 'blocked'],
    ])
    expect(log[0]?.rows).toEqual([{ code: 'A1', title: 'Title A1', model: 'opus', confidence: 'high', minutes: 30, tokens: 1000, live: false }])
    expect(log[1]?.rows).toEqual([{ code: 'A2', title: 'Title A2', model: 'sonnet', live: false }])
    expect(log[1]?.rows[0]).not.toHaveProperty('confidence')
    expect(log[3]?.rows).toEqual([{ code: 'B2', title: 'Title B2', model: 'opus', minutes: 14, tokens: 500, live: true }])
    expect(log[4]?.rows).toEqual([{ code: 'B3', title: 'Title B3', confidence: 'medium', live: false }])
    expect(log[4]?.rows[0]).not.toHaveProperty('model')
  })

  it("the in-progress wave's log status follows the run's state, as the runs list shows it", () => {
    const docs = { one: [[1, 'A1', `${pr(40)} merged`, 'done'], [2, 'B1', '—', 'pending'], [3, 'C1', '—', 'pending']] as BoardRow[] }
    const at = (q: string[], agents: AgentRun[] = []) => {
      const r = repo(files({ sprints: [['one', 'active']], docs, queue: q }), { agents })
      const run = model.listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).find((x) => x.plan === 'alpha')!
      return [run.state, build(r).log.map((g) => g.status)]
    }
    // Halted: an autopilot gate BLOCKED to you.
    expect(at([queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'gate 1: B1 is blocked')])).toEqual(['blocked', ['merged PR #40', 'blocked', 'planned']])
    // An ask for you.
    expect(at([queueLine('PENDING', 'engineer → human', 'sprint: one · slice: B1', 'Pick one')])).toEqual(['needs-you', ['merged PR #40', 'needs you', 'planned']])
    // Nothing runs and nothing asks: waiting, not running.
    expect(at([])).toEqual(['idle', ['merged PR #40', 'waiting', 'planned']])
    // An engineer at work on the wave: running.
    expect(at([], [running({ sprint: 'one', slice: 'B1' })])).toEqual(['running', ['merged PR #40', 'running', 'planned']])
    // An engineer at work on the wave reads running even when the run is blocked by another wave's slice
    // (the sprint's chip, the run's own, says blocked).
    const blockedElsewhere = { one: [[1, 'A1', `${pr(40)} merged`, 'done'], [2, 'B1', '—', 'pending'], [3, 'C1', '—', 'blocked']] as BoardRow[] }
    const r = repo(files({ sprints: [['one', 'active']], docs: blockedElsewhere }), { agents: [running({ sprint: 'one', slice: 'B1' })] })
    expect(model.listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).find((x) => x.plan === 'alpha')?.state).toBe('blocked')
    expect(build(r).log.map((g) => g.status)).toEqual(['merged PR #40', 'running', 'blocked'])
  })

  it("the flow's wave in progress is running only while its own engineer runs; otherwise it takes the run's state", () => {
    const docs = (b1: string) => ({ one: [[1, 'A1', `${pr(40)} merged`, 'done'], [2, 'B1', '—', b1], [3, 'C1', '—', 'pending']] as BoardRow[] })
    const at = (q: string[], agents: AgentRun[] = [], b1 = 'pending') => {
      const r = repo(files({ sprints: [['one', 'active']], docs: docs(b1), queue: q }), { agents })
      const run = model.listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).find((x) => x.plan === 'alpha')!
      const p = build(r)
      return { run: run.state, flow: steps(p, 'sprint:one').map(([label, state, detail]) => `${label} ${state} ${detail}`), log: p.log.map((g) => g.status) }
    }
    // Halted: red blocked.
    expect(at([queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'gate 1: B1 is blocked')])).toMatchObject({ run: 'blocked', flow: ['Wave 1 done 1 slice', 'Wave 2 blocked 1 slice', 'Wave 3 wait 1 slice planned'] })
    // A plan-level ask for you: amber needs you.
    expect(at([queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'Pick a look')])).toMatchObject({ run: 'needs-you', flow: ['Wave 1 done 1 slice', 'Wave 2 you 1 slice', 'Wave 3 wait 1 slice planned'] })
    // Idle: dim waiting, and not called planned, since it is the wave in progress.
    expect(at([])).toMatchObject({ run: 'idle', flow: ['Wave 1 done 1 slice', 'Wave 2 wait 1 slice', 'Wave 3 wait 1 slice planned'], log: ['merged PR #40', 'waiting', 'planned'] })
    // Its own engineer at work: blue running.
    expect(at([], [running({ sprint: 'one', slice: 'B1' })]).flow[1]).toMatch(/^Wave 2 live 1 engineer/)
    // The run runs (a pushed slice) though no engineer of this wave does: running, in the flow and the log,
    // as the runs list says.
    expect(at([], [], 'pushed')).toMatchObject({ run: 'running', flow: ['Wave 1 done 1 slice', 'Wave 2 live 1 slice', 'Wave 3 wait 1 slice planned'], log: ['merged PR #40', 'running', 'planned'] })
  })

  it('unknown plan and empty repo', () => {
    const r = repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'A1', '—', 'pending']] } }))
    expect(buildPipeline(r, 'nope', NOW)).toBeUndefined()
    // Unsupported docs, an error with an empty model, and docs with no plans.
    expect(buildPipeline(repo({ 'pod-docs/README.md': 'pod docs: 1\n' }), 'alpha', NOW)).toBeUndefined()
    expect(buildPipeline(repo({}, { error: 'folder not found' }), 'alpha', NOW)).toBeUndefined()
    expect(buildPipeline(repo({ 'pod-docs/README.md': README }), 'alpha', NOW)).toBeUndefined()

    // A plan with no sprints: just its own, check, and ship stages, and no log.
    const bare = build(repo(files({ sprints: [] })))
    expect(bare.stages.map((s) => s.key)).toEqual(['plan', 'check', 'ship'])
    expect(bare.log).toEqual([])
    // A current sprint whose doc has no board yet reads as not drafted.
    const empty = repo({ ...files({ sprints: [['one', 'active']] }), 'pod-docs/sprints/one.md': '# Sprint: one\n\n_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active_\n' })
    expect(steps(build(empty), 'sprint:one')).toEqual([['one', 'wait', 'not drafted']])
    // Odd agents never throw.
    const odd = repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'A1', '—', 'pending']] } }), {
      agents: [agent({ type: '', slice: '', sprint: '', branch: '-w-fix' }), agent({ type: 'pod:reviewer' }), agent({ startedAt: NaN, lastAt: NaN })],
    })
    expect(() => build(odd)).not.toThrow()
  })

  it('drafting: a running planner for the plan makes the undrafted current sprint live', () => {
    const f = files({ sprints: [['one', 'done'], ['two', 'planned']], docs: { one: [[1, 'A1', 'merged', 'done']] } })
    const planner = (over: Partial<AgentRun> = {}) => running({ type: 'pod:sprint-planner', plan: 'alpha', ...over })
    expect(steps(build(repo(f, { agents: [planner()] })), 'sprint:two')).toEqual([['two', 'live', 'drafting']])
    expect(steps(build(repo(f, { agents: [planner({ plan: 'beta' })] })), 'sprint:two')).toEqual([['two', 'wait', 'not drafted']])
  })

  it('wave step shows a waiting PR', () => {
    const pushed = (rows: BoardRow[], extra: Partial<BoardRepo> = {}, queue: string[] = []) =>
      build(repo(files({ sprints: [['one', 'active']], docs: { one: rows }, queue }), extra))
    const wave = (p: Pipeline, n: number) => stage(p, 'sprint:one').steps.find((s) => s.label === `Wave ${n}`)
    const rows: BoardRow[] = [
      [1, 'A1', 'merged', 'done'],
      [2, 'B1', pr(7), 'pushed'],
      [2, 'B2', pr(7), 'pushed'],
    ]
    // Every unfinished slice pushed, nothing running: you merge, with the PR's number.
    expect(wave(pushed(rows), 2)).toEqual({ key: 'one/wave-2', label: 'Wave 2', state: 'you', detail: 'PR #7 · you merge', merge: { number: 7 } })
    // An ask on the same wave: still the PR's words and merge.
    const ask = queueLine('PENDING', 'engineer → human', 'sprint: one · slice: B1', 'Pick one')
    expect(wave(pushed(rows, {}, [ask]), 2)).toMatchObject({ state: 'you', detail: 'PR #7 · you merge', merge: { number: 7 } })
    // A running engineer of the wave: live as today, no merge.
    const live = wave(pushed(rows, { agents: [running({ sprint: 'one', slice: 'B1' })] }), 2)
    expect(live?.state).toBe('live')
    expect(live).not.toHaveProperty('merge')
    // gh says merged or closed: the pushed slice keeps the run running, so the wave reads running; no merge.
    const status = (state: PrStatus['state']): PrStatus => ({ number: 7, state, checks: 'pass', checkedAt: NOW })
    for (const s of ['merged', 'closed'] as const) {
      expect(wave(pushed(rows, { prs: [status(s)] }), 2)).toEqual({ key: 'one/wave-2', label: 'Wave 2', state: 'live', detail: '2 slices' })
    }
    // Done still beats you: a done wave reads done, with no merge.
    expect(wave(pushed(rows), 1)).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: 'done', detail: '1 slice' })
    // Blocked still beats you.
    const blocked = wave(pushed([[1, 'A1', pr(7), 'pushed'], [1, 'A2', '—', 'blocked']]), 1)
    expect(blocked?.state).toBe('blocked')
    expect(blocked).not.toHaveProperty('merge')
  })

  it('only waiting steps carry merge', () => {
    const merges = (p: Pipeline) => p.stages.flatMap((st) => st.steps.filter((s) => 'merge' in s).map((s) => [s.key, s.merge]))
    const handBack = (n: number) => queueLine('PENDING', 'orchestrator → human', 'plan: alpha', `Plan complete: merge https://github.com/o/r/pull/${n}`)
    const done = { sprints: [['one', 'done']] as SprintRow[], docs: { one: [[1, 'A1', 'merged', 'done']] as BoardRow[] } }
    const status = (n: number, state: PrStatus['state'], branch?: string): PrStatus => ({ number: n, state, checks: 'pass', checkedAt: NOW, ...(branch ? { branch } : {}) })

    // A pending hand-back: only the Ship step carries merge.
    expect(merges(build(repo(files({ ...done, queue: [handBack(12)] }))))).toEqual([['final-pr', { number: 12 }]])
    // Merged, before the hand-back, or a PR on the plan's branch: no step carries merge.
    expect(merges(build(repo(files({ ...done, queue: [handBack(12)] }), { prs: [status(12, 'merged')] })))).toEqual([])
    expect(merges(build(repo(files(done), { prs: [status(12, 'open', 'alpha')] })))).toEqual([])
    // A mid-run plan with nothing handed back: none.
    expect(merges(build(repo(files({ sprints: [['one', 'active']], docs: { one: [[1, 'A1', '—', 'pending'], [1, 'A2', pr(7), 'pushed']] } }))))).toEqual([])
    // An archived plan off the runs list: its Ship reads you merge but carries no merge.
    const offList = build(repo({ ...files({ ...done, queue: [handBack(12)] }), 'pod-docs/plans/alpha.md': planDoc('ALPHA', [['one', 'done']]).replace('Status: active', 'Status: archived') }))
    expect(steps(offList, 'ship')).toEqual([['Final PR', 'you', 'PR #12 · you merge']])
    expect(merges(offList)).toEqual([])
    // Claimed, it's closing out: Ship carries merge until gh says merged, then none, though the run stays listed.
    const archivedFiles = { ...files({ ...done, queue: [handBack(12)] }), 'pod-docs/plans/alpha.md': planDoc('ALPHA', [['one', 'done']]).replace('Status: active', 'Status: archived') }
    const claims = [{ portBase: 3100, repoPath: '/r', plan: 'alpha' }]
    expect(merges(build(repo(archivedFiles, { claims, prs: [status(12, 'open')] })))).toEqual([['final-pr', { number: 12 }]])
    const mergedOut = repo(archivedFiles, { claims, prs: [status(12, 'merged')] })
    expect(isRun(mergedOut, mergedOut.model.plans[0]!, NOW)).toBe(true)
    expect(merges(build(mergedOut))).toEqual([])
  })

  it('is exported from the package entry', () => {
    expect(model.buildPipeline).toBe(buildPipeline)
  })
})

describe('planState with a staging PR', () => {
  // Plan alpha is done and claimed; its final PR #80 merged into pod-staging an hour ago.
  const doneFiles = files({ sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] } })
  const claims = [{ portBase: 3100, repoPath: '/r', plan: 'alpha' }]
  const gh = (number: number, state: PrStatus['state'], branch: string, base: string, mergedAt?: number): PrStatus => ({
    number,
    state,
    checks: 'pass',
    checkedAt: NOW,
    branch,
    base,
    ...(mergedAt === undefined ? {} : { mergedAt }),
  })
  const final = gh(80, 'merged', 'alpha', 'pod-staging', NOW - 60 * MIN)
  const stateOf = (prs: PrStatus[]) => {
    const r = repo(doneFiles, { claims, prs })
    return planState(r, r.model.plans[0]!, NOW)
  }

  it('needs you while the staging → main PR is open', () => {
    expect(stateOf([final, gh(91, 'open', 'pod-staging', 'main')])).toBe('needs-you')
  })

  it('stays idle when the staging PR is closed, merged, not open yet, or the final PR has not merged', () => {
    expect(stateOf([final])).toBe('idle')
    expect(stateOf([final, gh(91, 'closed', 'pod-staging', 'main')])).toBe('idle')
    expect(stateOf([final, gh(91, 'merged', 'pod-staging', 'main', NOW - 5 * MIN)])).toBe('idle')
    expect(stateOf([gh(80, 'open', 'alpha', 'pod-staging'), gh(91, 'open', 'pod-staging', 'main')])).toBe('idle')
  })
})

describe('haltGate', () => {
  it('reads the gate an autopilot halt starts with, by number or by name', () => {
    expect(haltGate('gate 3 auto-merge-fail: wave PR https://github.com/o/r/pull/9 has no passing CI')).toBe(3)
    expect(haltGate('**Gate 6** escalation-valve: PR #12 held')).toBe(6)
    expect(haltGate('Autopilot gate 2: the review still fails')).toBe(2)
    const names: [string, number][] = [
      ['blocked-concern', 1],
      ['plan-review-fail', 2],
      ['auto-merge-fail', 3],
      ['inter-wave-verify', 4],
      ['safety-bound', 5],
      ['escalation-valve', 6],
      ['plan-complete', 7],
    ]
    for (const [name, n] of names) expect(haltGate(`${name}: details`), name).toBe(n)
    // Not a halt: a gate named mid-sentence, a longer word, or nothing.
    expect(haltGate('now: see gate 3 later')).toBeUndefined()
    expect(haltGate('safety-bounded run')).toBeUndefined()
    expect(haltGate('Pick the step size.')).toBeUndefined()
  })
})
