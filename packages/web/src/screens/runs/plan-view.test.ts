import { describe, expect, it } from 'vitest'
import { buildFlow, buildPipeline, buildRepoModel, listRuns, type AgentRun, type BoardRepo, type Claim, type PrStatus, type RunSummary, type Stage, type Step } from '@pod-board/model'
import { loadFixture } from '../../../../model/test/load-fixture.ts'
import { flowColumns, flowEdges, foldLine, runHeader, startedAgo } from './plan-view.ts'

const NOW = Date.UTC(2026, 9, 20, 12)
const PLAN = 'pod-docs/plans/sparring-ladder.md'
const LADDER = 'pod-docs/sprints/ladder.md'

/** chess-web as the fixture has it: plan sparring-ladder, an autopilot run on wave 3 of 3 of sprint ladder. */
function chess(edit: (files: Record<string, string>) => void = () => {}, extra: Partial<BoardRepo> = {}): BoardRepo {
  const files = loadFixture('chess-web')
  edit(files)
  return { id: 'chess', name: 'chess-web', path: '/c', source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}
/** The same run started with /pod:code: no autopilot line, so the pipeline has a Go step. */
const manual = (files: Record<string, string>) => {
  // The plan doc and the sprint doc both carry pod's autopilot line.
  for (const doc of [PLAN, LADDER]) files[doc] = files[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
}
/** Three sprints: `warmup` done (two merged waves), `ladder` current as in the fixture, `rematch` named but not drafted. */
const threeSprints = (files: Record<string, string>, first = 'warmup', last = 'rematch') => {
  files[PLAN] = files[PLAN]!.replace(/^(\| ladder \|.*\| active \| )— \|$/m, (_row, head: string) =>
    [`| ${first} | Warm up | done | — |`, `${head}${first} |`, `| ${last} | Rematch | planned | ladder |`].join('\n'),
  )
  files[`pod-docs/sprints/${first}.md`] = [
    '# Sprint: Warm up',
    '',
    `_From plan: pod-docs/plans/sparring-ladder.md · Slug: ${first} · Status: done · Generated: 2026-10-17_`,
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

const runOf = (repo: BoardRepo, plan?: string) => listRuns({ generatedAt: NOW, gh: 'ok', repos: [repo] }, NOW).find((r) => r.plan === plan)
const ladderRun = { repoId: 'chess', repo: 'chess-web', plan: 'sparring-ladder', where: 'x', state: 'idle' } satisfies RunSummary

const step = (key: string, state: Step['state'], label = key): Step => ({ key, label, state, detail: `${key} detail` })
const stage = (key: string, caption: string, steps: Step[]): Stage => ({ key, caption, steps })

describe('plan view', () => {
  it('flow columns', () => {
    const stages = [
      stage('plan', 'Plan', [step('plan', 'done', 'Plan'), step('go', 'unknown', 'Go')]),
      stage('sprint:one', 'Sprint 1 of 2', [step('one/wave-1', 'done', 'Wave 1'), step('one/wave-2', 'live', 'Wave 2'), step('one/wave-3', 'wait', 'Wave 3')]),
      stage('empty', 'Empty', []),
      stage('check', 'Check', [step('review', 'blocked', 'Final review')]),
      stage('ship', 'Ship', [step('final-pr', 'you', 'Final PR')]),
    ]
    const cols = flowColumns(stages)
    // One column per stage with steps, in order; a stage with no steps leaves no empty column.
    expect(cols.map((c) => [c.key, c.caption])).toEqual([
      ['plan', 'Plan'],
      ['sprint:one', 'Sprint 1 of 2'],
      ['check', 'Check'],
      ['ship', 'Ship'],
    ])
    const steps = cols.flatMap((c) => c.steps)
    expect(steps.map((s) => [s.label, s.detail])).toEqual([
      ['Plan', 'plan detail'],
      ['Go', 'go detail'],
      ['Wave 1', 'one/wave-1 detail'],
      ['Wave 2', 'one/wave-2 detail'],
      ['Wave 3', 'one/wave-3 detail'],
      ['Final review', 'review detail'],
      ['Final PR', 'final-pr detail'],
    ])
    // Each state has its mark (an icon name) and word, so a state never rests on colour alone.
    expect(steps.map((s) => [s.state, s.mark, s.word])).toEqual([
      ['done', 'check', 'done'],
      ['unknown', 'circle', 'unknown'],
      ['done', 'check', 'done'],
      ['live', 'dot', 'running'],
      ['wait', 'circle', 'waiting'],
      ['blocked', 'blocked', 'blocked'],
      ['you', 'alert', 'needs you'],
    ])
    // Running, needs you and blocked steps get the highlighted border; waiting and unknown ones are dim.
    expect(steps.filter((s) => s.highlight).map((s) => s.label)).toEqual(['Wave 2', 'Final review', 'Final PR'])
    expect(steps.filter((s) => s.dim).map((s) => s.label)).toEqual(['Go', 'Wave 3'])
    // Keys stay unique across columns, so React keeps each card.
    expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length)
    expect(flowColumns([])).toEqual([])
  })

  it('flow columns from a real pipeline', () => {
    // /pod:code: the Plan column has Plan and Go.
    const code = flowColumns(buildPipeline(chess(manual), 'sparring-ladder', NOW)!.stages)
    expect(code.map((c) => [c.caption, c.steps.map((s) => `${s.label} ${s.word}`)])).toEqual([
      ['Plan', ['Plan done', 'Go unknown']],
      // The fixture's queue asks for you and no engineer runs: the wave in progress needs you.
      ['Sprint 1 of 1', ['Wave 1 done', 'Wave 2 done', 'Wave 3 needs you']],
      ['Check', ['Final review waiting', 'Fix pass waiting']],
      ['Ship', ['Final PR waiting']],
    ])
    expect(code[1]?.steps[2]).toMatchObject({ detail: '1 slice', highlight: true })
    // Autopilot records no Go, so its Plan column has one card.
    const auto = flowColumns(buildPipeline(chess(), 'sparring-ladder', NOW)!.stages)
    expect(auto[0]?.steps.map((s) => s.label)).toEqual(['Plan'])
    expect(auto.map((c) => c.caption)).toEqual(['Plan', 'Sprint 1 of 1', 'Check', 'Ship'])
  })

  it('flow columns: a skipped step is dim with a ring', () => {
    const cols = flowColumns([stage('think', 'Think', [step('research', 'skipped', 'Research')])])
    expect(cols[0]?.steps[0]).toMatchObject({ state: 'skipped', mark: 'circle', word: 'skipped', dim: true, highlight: false })
  })

  it('flow columns from the full flow', () => {
    const cols = flowColumns(buildFlow(chess(manual), 'sparring-ladder', NOW) ?? [])
    expect(cols.map((c) => c.caption)).toEqual(['Think', 'You', 'Sprint 1 of 1', 'Check', 'Ship'])
    expect(cols.map((c) => c.steps.map((s) => `${s.label} ${s.word}`))).toEqual([
      // The fixture has no research report, and its Look section is empty (scrubbed).
      ['Research skipped', 'Plan interview done'],
      ['Look picked unknown', 'Replied go unknown'],
      ['Wave 1 done', 'Wave 2 done', 'Wave 3 needs you'],
      ['Final review waiting', 'Fix pass waiting'],
      ['Final PR waiting'],
    ])
  })

  it('fold line: the current step with its mark', () => {
    const cols = (states: Step['state'][]) => flowColumns([stage('s', 'S', states.map((st, i) => step(`s${i}`, st, `Step ${i}`)))])
    // The first blocked, needs-you or running step wins, even after a waiting one.
    expect(foldLine(cols(['done', 'wait', 'you', 'blocked']))).toEqual({ label: 'Step 2', detail: 's2 detail', mark: 'alert', word: 'needs you', state: 'you' })
    expect(foldLine(cols(['done', 'live']))).toMatchObject({ label: 'Step 1', mark: 'dot', state: 'live' })
    // Else the first waiting step; skipped and unknown ones are passed over.
    expect(foldLine(cols(['done', 'skipped', 'unknown', 'wait', 'wait']))).toMatchObject({ label: 'Step 3', state: 'wait' })
    // Everything done: the last step.
    expect(foldLine(cols(['done', 'done']))).toMatchObject({ label: 'Step 1', mark: 'check', state: 'done' })
    expect(foldLine([])).toBeUndefined()
    // The real run: wave 3, which needs you (the queue asks, no engineer runs).
    expect(foldLine(flowColumns(buildFlow(chess(), 'sparring-ladder', NOW) ?? []))).toMatchObject({ label: 'Wave 3', detail: '1 slice', state: 'you', mark: 'alert' })
  })

  it('run header', () => {
    // Autopilot: Research skipped and Look unknown count as done once a later step started; the live wave is current.
    // The title is the plan's own title (the doc's `# Plan:` line), not its slug; the meta line names the repo and the kind.
    const auto = chess()
    expect(runHeader(runOf(auto, 'sparring-ladder'), auto, NOW)).toEqual({
      title: 'Sparring ladder to Liem',
      // No agents on the Board: the plan's autopilot stamp (2026-10-18T10:31Z) says when it started.
      meta: 'chess-web · Plan · started 2 days ago',
      segments: ['done', 'done', 'done', 'done', 'done', 'current', 'rest', 'rest', 'rest'],
      wave: 'Wave 3 of 3',
    })
    // /pod:code: one more step, Go, unknown, done once a later step started.
    const code = chess(manual)
    expect(runHeader(runOf(code, 'sparring-ladder'), code, NOW)?.segments).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'current', 'rest', 'rest', 'rest'])
    // A fresh plan: the sprint has no doc, so it is the first waiting step; nothing after Look started, so Look and Go aren't done.
    const fresh = chess((f) => {
      manual(f)
      f[PLAN] = f[PLAN]!.replace(/^(\| ladder \|.*\|) active (\| — \|)$/m, '$1 planned $2')
      delete f[LADDER]
    })
    const header = runHeader(ladderRun, fresh, NOW)
    expect(header?.segments).toEqual(['done', 'done', 'rest', 'rest', 'current', 'rest', 'rest', 'rest'])
    expect(header).not.toHaveProperty('wave')
    // A run summary without a title still reads the plan's title from the repo.
    expect(header?.title).toBe('Sparring ladder to Liem')
  })

  it("run header: started is the earliest start among the run's own agents", () => {
    const agent = (id: string, startedAt: number | undefined, fields: Partial<AgentRun> = {}): AgentRun => ({
      id,
      session: 's',
      type: 'pod:engineer',
      tokens: 0,
      ended: true,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...fields,
    })
    const H = 3_600_000
    const repo = chess(() => {}, {
      agents: [
        agent('late', NOW - 2 * H, { plan: 'sparring-ladder' }),
        agent('early', NOW - 50 * H, { sprint: 'ladder' }),
        // No start time: passed over.
        agent('untimed', undefined, { plan: 'sparring-ladder' }),
        // Another plan's agent never counts.
        agent('other', NOW - 900 * H, { plan: 'board-feel' }),
      ],
    })
    expect(runHeader(runOf(repo, 'sparring-ladder'), repo, NOW)?.meta).toBe('chess-web · Plan · started 2 days ago')
  })

  describe('run header: started falls back from the agents to the stamp to the Generated date', () => {
    const D = 24 * 3_600_000
    const agent = (id: string, startedAt: number): AgentRun => ({ id, session: 's', type: 'pod:engineer', tokens: 0, ended: true, startedAt, plan: 'sparring-ladder' })
    const meta = (repo: BoardRepo, days?: number) => runHeader(runOf(repo, 'sparring-ladder'), repo, NOW, days)?.meta
    /** No autopilot stamp; `generated` replaces the doc's `Generated:` date (none: the field goes). */
    const noStamp = (generated?: string) => (f: Record<string, string>) => {
      manual(f)
      f[PLAN] = f[PLAN]!.replace(/Generated: 2026-10-17 · /, generated === undefined ? '' : `Generated: ${generated} · `)
    }

    /** The plan's autopilot stamp set to `at`. */
    const stampAt = (at: number) => (f: Record<string, string>) => {
      f[PLAN] = f[PLAN]!.replace(/started=\S+/, `started=${new Date(at).toISOString().replace('.000', '')}`)
    }
    /**
     * A time shown as a date is its local day, which depends on the time zone (noon UTC is the next day
     * in Auckland), so the expected text comes from the same local getters.
     */
    const dayOf = (at: number) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date(at).getMonth()]} ${new Date(at).getDate()}`

    it('with a stamp: the earliest of the stamp and every read agent start', () => {
      // The stamp says 2 days ago; the agent, 5 hours ago: the run started at the stamp.
      expect(meta(chess(() => {}, { agents: [agent('a', NOW - 5 * 3_600_000)] }))).toBe('chess-web · Plan · started 2 days ago')
      // An agent before the stamp (a resumed autopilot rewrote it): the agent's time.
      expect(meta(chess(() => {}, { agents: [agent('a', NOW - 5 * D)] }))).toBe('chess-web · Plan · started 5 days ago')
      // A day short of the 30-day window still reads as N days ago.
      expect(meta(chess(() => {}, { agents: [agent('a', NOW - 29 * D + 60_000)] }))).toBe('chess-web · Plan · started 28 days ago')
    })

    it('with a stamp: a read agent near or past the window edge still counts, shown as a date', () => {
      // The reviewer's case: stamp 13 days back, agents 30 and 20 days back: the 30-day agent started the run.
      const repro = chess(stampAt(NOW - 13 * D), { agents: [agent('old', NOW - 30 * D), agent('mid', NOW - 20 * D)] })
      expect(meta(repro)).toBe(`chess-web · Plan · started ${dayOf(NOW - 30 * D)}`)
      // A read agent 40 days back with a 13-day stamp: its start is true, so it counts, as a date.
      expect(meta(chess(stampAt(NOW - 13 * D), { agents: [agent('a', NOW - 40 * D)] }))).toBe(`chess-web · Plan · started ${dayOf(NOW - 40 * D)}`)
      // Exactly at the edge (window less a day) is a date too.
      expect(meta(chess(() => {}, { agents: [agent('a', NOW - 29 * D)] }))).toBe(`chess-web · Plan · started ${dayOf(NOW - 29 * D)}`)
      // A stamp itself past the edge reads as a date.
      expect(meta(chess(stampAt(NOW - 45 * D)))).toBe(`chess-web · Plan · started ${dayOf(NOW - 45 * D)}`)
    })

    it('no stamp: an agent clearly inside the window reads as N ago; near the edge, the Generated date, else the agent as a date', () => {
      const inside = chess(noStamp(), { agents: [agent('a', NOW - 6 * D)] })
      expect(meta(inside, 30)).toBe('chess-web · Plan · started 6 days ago')
      // With a 7-day window, 6 days back is at the edge: older agents may be unread. No Generated date: the agent's day.
      expect(meta(inside, 7)).toBe(`chess-web · Plan · started ${dayOf(NOW - 6 * D)}`)
      // At the edge with a Generated date: the date.
      expect(meta(chess(noStamp('2026-10-01'), { agents: [agent('a', NOW - 6 * D)] }), 7)).toBe('chess-web · Plan · started Oct 1')
      expect(meta(chess(noStamp('2026-08-01'), { agents: [agent('a', NOW - 40 * D)] }))).toBe('chess-web · Plan · started Aug 1')
      // The earliest wins: an edge agent (29.5 days back, Sep 20 or 21 by zone) before the Generated day (Oct 5) reads as its own day.
      expect(meta(chess(noStamp('2026-10-05'), { agents: [agent('a', NOW - 29.5 * D)] }))).toBe(`chess-web · Plan · started ${dayOf(NOW - 29.5 * D)}`)
    })

    it('no stamp and no agent: the Generated date, as a date, never as N days ago', () => {
      expect(meta(chess(noStamp('2026-10-12')))).toBe('chess-web · Plan · started Oct 12')
      expect(meta(chess(noStamp('2026-01-05')))).toBe('chess-web · Plan · started Jan 5')
      // Another year names it.
      expect(meta(chess(noStamp('2025-12-01')))).toBe('chess-web · Plan · started Dec 1, 2025')
    })

    it('no agent, no stamp, and no Generated date: no started part', () => {
      expect(meta(chess(noStamp()))).toBe('chess-web · Plan')
    })

    it('the Board passes its window through runHeader; missing means 30 days', () => {
      const repo = chess(() => {}, { agents: [agent('a', NOW - 10 * D)] })
      expect(meta(repo)).toBe('chess-web · Plan · started 10 days ago')
      // A 10-day window puts that start at the edge: the same start, as a date.
      expect(meta(repo, 10)).toBe(`chess-web · Plan · started ${dayOf(NOW - 10 * D)}`)
    })
  })

  it('run header for a fix run: the PR title without its prefix, else the slug made readable', () => {
    const name = 'fix-sprint-column'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const fix = { repoId: 'chess', repo: 'chess-web', plan: name, fix: 'sprint-column', where: 'working', state: 'running' } satisfies RunSummary
    const pr = (title: string | undefined): PrStatus => ({ number: 58, state: 'open', checks: 'none', checkedAt: NOW, branch: name, ...(title === undefined ? {} : { title }) })
    const titleWith = (title: string | undefined) => runHeader(fix, chess(() => {}, { claims: [claim], prs: [pr(title)] }), NOW)?.title

    // No PR yet: the slug, dashes to spaces, first letter capital.
    expect(runHeader(fix, chess(() => {}, { claims: [claim] }), NOW)).toEqual({ title: 'Sprint column', meta: 'chess-web · Fix', segments: [] })
    // A PR whose title gh didn't give: the slug too.
    expect(titleWith(undefined)).toBe('Sprint column')
    // The conventional-commit prefix goes, with any scope and breaking mark; the rest keeps its case as written.
    expect(titleWith("fix(runs): the log's rail holds only a status")).toBe("the log's rail holds only a status")
    expect(titleWith('fix(server): gh pr list times out')).toBe('gh pr list times out')
    expect(titleWith('fix: iOS drag sticks')).toBe('iOS drag sticks')
    expect(titleWith('feat!: drop the strip')).toBe('drop the strip')
    expect(titleWith('refactor(model, web)!:   tidy the flow')).toBe('tidy the flow')
    expect(titleWith('FEAT(runs): Calm header')).toBe('Calm header')
    // A title with no prefix stays as it is; a word that isn't a commit type isn't a prefix.
    expect(titleWith('Calm the run header')).toBe('Calm the run header')
    expect(titleWith('Note: keep this')).toBe('Note: keep this')
    // Nothing left after the prefix, or a blank title: the slug.
    expect(titleWith('fix(runs): ')).toBe('Sprint column')
    expect(titleWith('   ')).toBe('Sprint column')
    // The slug's own dashes and underscores all become spaces.
    expect(runHeader({ ...fix, fix: 'run_header-spacing' }, chess(() => {}, { claims: [claim] }), NOW)?.title).toBe('Run header spacing')

    // Started: the earliest of the fix run's engineers and reviewers.
    const engineer: AgentRun = { id: 'e1', session: 's', type: 'pod:engineer', branch: name, startedAt: NOW - 5 * 60_000, tokens: 0, ended: false }
    const started = chess(() => {}, { claims: [claim], agents: [engineer] })
    expect(runHeader(fix, started, NOW)?.meta).toBe('chess-web · Fix · started 5 min ago')
    // A fix run has no plan doc to fall back on, so its earliest agent counts whatever the window.
    const old = chess(() => {}, { claims: [claim], agents: [{ ...engineer, startedAt: NOW - 40 * 24 * 3_600_000 }] })
    expect(runHeader(fix, old, NOW, 30)?.meta).toBe('chess-web · Fix · started 40 days ago')
  })

  it('run header for a repo row, a plan the repo lacks, and no run', () => {
    const repo = chess()
    // A repo with no plan: the repo is the title, so the meta line has nothing more to say.
    const row = { repoId: 'chess', repo: 'chess-web', where: 'no active plan', state: 'idle' } satisfies RunSummary
    expect(runHeader(row, repo, NOW)).toEqual({ title: 'chess-web', meta: '', segments: [] })
    // A plan the repo doesn't have: its slug made readable, no strip.
    expect(runHeader({ ...row, plan: 'gone-plan' }, repo, NOW)).toEqual({ title: 'Gone plan', meta: 'chess-web · Plan', segments: [] })

    expect(runHeader(undefined, repo, NOW)).toBeUndefined()
    expect(runHeader(row, undefined, NOW)).toBeUndefined()
    // Another repo's run never reads as this repo's.
    expect(runHeader({ ...row, repoId: 'other' }, repo, NOW)).toBeUndefined()
  })

  it('started time reads like a CI page', () => {
    const S = 1000
    const M = 60 * S
    const H = 60 * M
    const D = 24 * H
    const cases: [number, string][] = [
      [-5 * M, 'just now'], // a clock ahead of ours
      [0, 'just now'],
      [59 * S, 'just now'],
      [M, '1 min ago'],
      [59 * M + 59 * S, '59 min ago'],
      [H, '1 h ago'],
      [23 * H + 59 * M, '23 h ago'],
      [D, '1 day ago'],
      [2 * D + 23 * H, '2 days ago'],
      [45 * D, '45 days ago'],
    ]
    expect(cases.map(([ago]) => startedAgo(NOW - ago, NOW))).toEqual(cases.map(([, words]) => words))
  })
})

describe('flow edges', () => {
  const step = (key: string, state: Step['state'], label = key): Step => ({ key, label, state, detail: `${key} detail` })
  const stage = (key: string, caption: string, steps: Step[]): Stage => ({ key, caption, steps })
  const edges2 = (cols: ReturnType<typeof flowColumns>) => flowEdges(cols).map((e) => `${e.from}>${e.to} ${e.kind}${e.walked ? ' W' : ''}${e.dashed ? ' D' : ''}`)
  const edges = (stages: Stage[]) => flowEdges(flowColumns(stages)).map((e) => `${e.from}>${e.to} ${e.kind}${e.walked ? ' W' : ''}${e.dashed ? ' D' : ''}`)
  const plan = (review: Step['state'], fix: Step['state'], finalPr: Step['state']) => [
    stage('think', 'Think', [step('research', 'skipped'), step('interview', 'done')]),
    stage('you', 'You', [step('look', 'done')]),
    stage('check', 'Check', [step('review', review), step('fix', fix)]),
    stage('ship', 'Ship', [step('final-pr', finalPr)]),
  ]
  const fixRun = (engineer: Step['state'], fixPass: Step['state'], round1: Step['state'], round2: Step['state'], pr: Step['state']) => [
    stage('build', 'Build', [step('engineer', engineer), step('fix-pass', fixPass)]),
    stage('review', 'Review', [step('round-1', round1), step('round-2', round2)]),
    stage('ship', 'Ship', [step('pr', pr)]),
  ]

  it('plan, review running: the main path skips Fix pass; the detour is dashed and not walked', () => {
    expect(edges(plan('live', 'wait', 'wait'))).toEqual([
      'think:research>think:interview down W',
      'think:interview>you:look across W',
      'you:look>check:review across W',
      'check:review>ship:final-pr across',
      'check:review>check:fix down D',
      'check:fix>ship:final-pr across D',
    ])
  })

  it('plan, review passed first time: the walked line goes straight from Final review to Final PR, never through Fix pass', () => {
    expect(edges(plan('done', 'wait', 'you')).slice(3)).toEqual([
      'check:review>ship:final-pr across W',
      'check:review>check:fix down D',
      'check:fix>ship:final-pr across D',
    ])
    // Final PR not open yet: still the main line into it, Fix pass untouched.
    expect(edges(plan('done', 'wait', 'wait')).slice(3)).toEqual([
      'check:review>ship:final-pr across W',
      'check:review>check:fix down D',
      'check:fix>ship:final-pr across D',
    ])
  })

  it('plan, after a fix pass: the detour is walked too', () => {
    expect(edges(plan('done', 'done', 'you')).slice(3)).toEqual([
      'check:review>ship:final-pr across W',
      'check:review>check:fix down W D',
      'check:fix>ship:final-pr across W D',
    ])
  })

  it('plan, fix pass running: walked into Fix pass, not past it', () => {
    expect(edges(plan('done', 'live', 'wait')).slice(3)).toEqual([
      'check:review>ship:final-pr across',
      'check:review>check:fix down W D',
      'check:fix>ship:final-pr across D',
    ])
  })

  it('fix run in round 1: the main line runs Engineer → Round 1 → Round 2 → PR; Fix pass is a dashed detour back from Round 1', () => {
    expect(edges(fixRun('done', 'wait', 'live', 'wait', 'wait'))).toEqual([
      'build:engineer>review:round-1 across W',
      'review:round-1>review:round-2 down',
      'review:round-2>ship:pr across',
      'review:round-1>build:fix-pass back D',
      'build:fix-pass>review:round-2 across D',
    ])
  })

  it('fix run after a fix pass: the detour is walked, and the main line up to round 2', () => {
    expect(edges(fixRun('done', 'done', 'done', 'live', 'wait'))).toEqual([
      'build:engineer>review:round-1 across W',
      'review:round-1>review:round-2 down W',
      'review:round-2>ship:pr across',
      'review:round-1>build:fix-pass back W D',
      'build:fix-pass>review:round-2 across W D',
    ])
  })

  it('several sprints share one column: the path runs down through them in order, walked only up to the current wave', () => {
    const cols = flowColumns(buildFlow(chess((f) => (manual(f), threeSprints(f))), 'sparring-ladder', NOW) ?? [])
    expect(cols.map((c) => c.caption)).toEqual(['Think', 'You', 'Sprint 2 of 3', 'Check', 'Ship'])
    expect(edges2(cols)).toEqual([
      'think:research>think:interview down W',
      'think:interview>you:look across W',
      'you:look>you:go down W',
      'you:go>sprint:warmup across W',
      'sprint:warmup>sprint:ladder/wave-1 down W',
      'sprint:ladder/wave-1>sprint:ladder/wave-2 down W',
      'sprint:ladder/wave-2>sprint:ladder/wave-3 down W',
      // Rematch hasn't run: no walked line past the live wave.
      'sprint:ladder/wave-3>sprint:rematch down',
      'sprint:rematch>check:review across',
      'check:review>ship:final-pr across',
      'check:review>check:fix down D',
      'check:fix>ship:final-pr across D',
    ])
  })

  it('a sprint slugged like a flow step stays a plain sprint card: the detour still runs Final review → Fix pass → Final PR', () => {
    const cols = flowColumns([
      stage('sprint', 'Sprint 2 of 2', [step('review', 'done', 'review'), step('fix', 'done', 'fix'), step('ladder/wave-1', 'live', 'Wave 1')]),
      stage('check', 'Check', [step('review', 'wait', 'Final review'), step('fix', 'wait', 'Fix pass')]),
      stage('ship', 'Ship', [step('final-pr', 'wait', 'Final PR')]),
    ])
    // Only the Check column's Fix pass is optional, not a sprint named `fix`.
    expect(cols.flatMap((c) => c.steps).filter((s) => s.optional).map((s) => s.key)).toEqual(['check:fix'])
    expect(edges2(cols)).toEqual([
      'sprint:review>sprint:fix down W',
      'sprint:fix>sprint:ladder/wave-1 down W',
      'sprint:ladder/wave-1>check:review across',
      'check:review>ship:final-pr across',
      'check:review>check:fix down D',
      'check:fix>ship:final-pr across D',
    ])
  })

  it('sprints slugged review and fix leave Final review and Fix pass waiting: no walked line or done segment past the live wave', () => {
    const repo = chess((f) => (manual(f), threeSprints(f, 'review', 'fix')))
    const cols = flowColumns(buildFlow(repo, 'sparring-ladder', NOW) ?? [])
    expect(cols[3]?.steps.map((s) => `${s.label} ${s.word} ${s.detail}`)).toEqual(['Final review waiting not started', 'Fix pass waiting only if review fails'])
    expect(edges2(cols).filter((e) => e.startsWith('check:') || e.includes('>check:'))).toEqual([
      'sprint:fix>check:review across',
      'check:review>ship:final-pr across',
      'check:review>check:fix down D',
      'check:fix>ship:final-pr across D',
    ])
    // The strip: Research, Plan interview, Look, Go, the review sprint, Wave 1, Wave 2 done; Wave 3 current; the rest not reached.
    expect(runHeader(runOf(repo, 'sparring-ladder'), repo, NOW)?.segments).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'current', 'rest', 'rest', 'rest', 'rest'])
  })

  it('with no optional step: one path, walked up to the first waiting step, or all of it when done', () => {
    const cols = (states: Step['state'][]) => flowColumns([stage('s', 'S', states.map((st, i) => step(`s${i}`, st)))])
    expect(flowEdges(cols(['done', 'wait', 'wait'])).map((e) => e.walked)).toEqual([true, false])
    expect(flowEdges(cols(['done', 'done'])).map((e) => e.walked)).toEqual([true])
    expect(flowEdges(cols(['done']))).toEqual([])
    expect(flowEdges([])).toEqual([])
  })
})
