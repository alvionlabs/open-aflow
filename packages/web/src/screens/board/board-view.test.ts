import { describe, expect, it } from 'vitest'
import { buildRepoModel, type AgentRun, type BoardRepo, type RepoFiles } from '@pod-board/model'
import { boardSlices, buildWaveBoard, cardChip, engineerFor, filterState, type Card, type CardState, type WaveBoard } from './board-view.ts'

// Snapshots are built inline, the way the model's pipeline tests build them.

const NOW = Date.UTC(2026, 9, 19, 12)
const MIN = 60_000

type SprintRow = [slug: string, status: string]
type BoardRow = {
  wave: number
  code: string
  pr?: string
  status?: string
  confidence?: string
  deps?: string
  model?: string
}

function planDoc(slug: string, sprints: SprintRow[]): string {
  return [
    `# Plan: ${slug}`,
    '',
    '_Generated: 2026-10-18 · Status: active · Grilled-with: grilling_',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, status]) => `| ${s} | goal of ${s} | ${status} | — |`),
    '',
  ].join('\n')
}

function sprintDoc(slug: string, plan: string, rows: BoardRow[]): string {
  return [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-10-18_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    ...rows.map(
      (r) =>
        `| ${r.wave} | ${r.code} | Title ${r.code} | ${slug}-${r.code} | ${r.pr ?? '—'} | ${r.status ?? 'pending'} | ${r.confidence ?? '—'} | ${r.deps ?? '—'} |`,
    ),
    '',
    '## Per-slice detail',
    '',
    ...rows.flatMap((r) => [`### ${r.code}: Title ${r.code}`, '- **Scope:** do it', ...(r.model ? [`- **Model:** ${r.model}`] : []), '']),
  ].join('\n')
}

type Docs = { sprints: SprintRow[]; docs?: Record<string, BoardRow[]>; archived?: Record<string, BoardRow[]>; queue?: string[] }

function files({ sprints, docs = {}, archived = {}, queue = [] }: Docs): RepoFiles {
  const out: RepoFiles = {
    'pod-docs/README.md': '# pod docs\n\npod docs: 2\n',
    'pod-docs/plans/alpha.md': planDoc('alpha', sprints),
    'pod-docs/handoff-queue.md': queue.join('\n'),
  }
  for (const [s, rows] of Object.entries(docs)) out[`pod-docs/sprints/${s}.md`] = sprintDoc(s, 'alpha', rows)
  for (const [s, rows] of Object.entries(archived)) out[`pod-docs/sprints/archive/${s}.md`] = sprintDoc(s, 'alpha', rows)
  return out
}

function repo(d: Docs, agents: AgentRun[] = []): BoardRepo {
  return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(files(d)), agents, prs: [], claims: [] }
}

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', description: '', tokens: 0, ended: false, ...over }
}
const running = (over: Partial<AgentRun>) => agent({ startedAt: NOW - 10 * MIN, lastAt: NOW - MIN, ...over })
const ended = (over: Partial<AgentRun>) => agent({ startedAt: NOW - 120 * MIN, lastAt: NOW - 98 * MIN, ended: true, ...over })

const q = (type: string, route: string, fields: string, body: string, pending = true) =>
  `- \`[2026-10-18 · ${type} · ${route} · ${fields}]\` ${body} **Resolution:** ${pending ? 'pending' : 'fixed in #9'}`

const pr = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`

const one = (rows: BoardRow[], extra: Partial<Docs> = {}, agents: AgentRun[] = []) =>
  repo({ sprints: [['s1', 'active']], docs: { s1: rows }, ...extra }, agents)

const wb = (r: BoardRepo): WaveBoard => {
  const b = buildWaveBoard(r, 'alpha', NOW)
  expect(b).toBeDefined()
  return b!
}
const cards = (b: WaveBoard): Card[] => b.columns.flatMap((c) => c.cards)
const card = (b: WaveBoard, code: string): Card => {
  const c = cards(b).find((x) => x.code === code)
  expect(c, code).toBeDefined()
  return c!
}
const stateOf = (r: BoardRepo, code: string): CardState => card(wb(r), code).state

/** pod is alive: an agent of the plan handed back lately, so a pushed slice is pod's. */
const POD: AgentRun = { id: 'pod', session: 's', type: 'pod:engineer', tokens: 0, ended: true, plan: 'alpha', lastAt: NOW - 10 * MIN }

describe('card state', () => {
  const askC1 = q('PENDING', 'engineer → human', 'sprint: s1 · slice: C1', 'keep undo after reload?')

  it('blocked beats needs-you', () => {
    expect(stateOf(one([{ wave: 1, code: 'C1', status: 'blocked' }], { queue: [askC1] }), 'C1')).toBe('blocked')
    expect(stateOf(one([{ wave: 1, code: 'C1', pr: 'skipped' }], { queue: [askC1] }), 'C1')).toBe('blocked')
  })

  it('merged beats needs-you (done beats you)', () => {
    const r = one([{ wave: 1, code: 'C1', status: 'done', pr: pr(4), confidence: 'high' }, { wave: 1, code: 'C2' }], {
      queue: [askC1, q('PENDING', 'engineer → human', 'sprint: s1 · slice: C2', 'x')],
    })
    expect(stateOf(r, 'C1')).toBe('merged')
    // A done card keeps its merged meta, not the entry's line.
    expect(card(wb(r), 'C1').meta).toBe('high')
    // The unfinished card beside it still needs you.
    expect(stateOf(r, 'C2')).toBe('needs-you')
    expect(wb(r).counts).toEqual({ 'needs-you': 1, running: 0, waiting: 0, blocked: 0, merged: 1 })
  })

  it('merged beats running', () => {
    expect(stateOf(one([{ wave: 1, code: 'C1', status: 'done', pr: pr(4) }], {}, [running({ sprint: 's1', slice: 'C1' })]), 'C1')).toBe('merged')
  })

  it('running beats waiting: pushed with an agent of the plan writing lately, or a running agent of the slice', () => {
    expect(stateOf(one([{ wave: 1, code: 'C1', status: 'pushed' }], {}, [POD]), 'C1')).toBe('running')
    expect(stateOf(one([{ wave: 1, code: 'C1', status: 'pushed' }]), 'C1')).toBe('waiting')
    expect(stateOf(one([{ wave: 1, code: 'C1' }], {}, [running({ sprint: 's1', slice: 'C1' })]), 'C1')).toBe('running')
    expect(stateOf(one([{ wave: 1, code: 'C1' }], {}, [ended({ sprint: 's1', slice: 'C1' })]), 'C1')).toBe('waiting')
    expect(stateOf(one([{ wave: 1, code: 'C1' }, { wave: 1, code: 'C2' }], {}, [running({ sprint: 's1', slice: 'C2' })]), 'C1')).toBe('waiting')
  })

  it('cards of a waiting wave need you', () => {
    const handedBack: BoardRow[] = [
      { wave: 1, code: 'A1', status: 'done', pr: pr(5) },
      { wave: 2, code: 'B1', status: 'pushed', pr: pr(7) },
      { wave: 2, code: 'B2', status: 'pushed', pr: pr(7) },
      { wave: 3, code: 'C1' },
    ]
    const b = wb(one(handedBack))
    expect(['A1', 'B1', 'B2', 'C1'].map((c) => card(b, c).state)).toEqual(['merged', 'needs-you', 'needs-you', 'waiting'])
    // With no ask naming it, the card says what you do.
    expect(card(b, 'B1').meta).toBe('PR #7 · you merge')
    // A running engineer of the wave: running, as today.
    expect(stateOf(one(handedBack, {}, [running({ sprint: 's1', slice: 'B2' })]), 'B1')).toBe('running')
    // blocked keeps precedence: a blocked slice blocks the wave, and its card reads blocked.
    const withBlock = one([{ wave: 1, code: 'B1', status: 'pushed', pr: pr(7) }, { wave: 1, code: 'B2', status: 'blocked' }], {}, [POD])
    expect(['B1', 'B2'].map((c) => stateOf(withBlock, c))).toEqual(['running', 'blocked'])
    // merged keeps precedence: a done slice in a waiting wave reads merged.
    const mixed = wb(one([{ wave: 1, code: 'B1', status: 'done', pr: pr(7) }, { wave: 1, code: 'B2', status: 'pushed', pr: pr(7) }]))
    expect([card(mixed, 'B1').state, card(mixed, 'B2').state]).toEqual(['merged', 'needs-you'])
    // A shown sprint that isn't current (the plan's last sprint with a doc) has no waiting wave, and with no agent read its pushed slice isn't running.
    const old = repo({ sprints: [['s1', 'done']], docs: { s1: [{ wave: 1, code: 'B1', status: 'pushed', pr: pr(7) }] } })
    expect(stateOf(old, 'B1')).toBe('waiting')
  })

  it('cards of an autopilot wave: autopilot merges, or it stopped', () => {
    const rows: BoardRow[] = [{ wave: 1, code: 'B1', status: 'pushed', pr: pr(7) }]
    const autopilot = (queue: string[]): BoardRepo => {
      const f = files({ sprints: [['s1', 'active']], docs: { s1: rows }, queue })
      f['pod-docs/sprints/s1.md'] = f['pod-docs/sprints/s1.md']!.replace('## Status board', '<!-- autopilot-run: started=2026-10-18T10:00:00Z sprints=0 waves=1 -->\n\n## Status board')
      return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(f), agents: [POD], prs: [], claims: [] }
    }
    // Not halted: pod merges it, so the card is running, not yours.
    expect(stateOf(autopilot([]), 'B1')).toBe('running')
    // Halted (a pending BLOCKED from the orchestrator): it needs you, and says autopilot stopped.
    const halted = wb(autopilot([q('BLOCKED', 'orchestrator → human', 'plan: alpha · sprint: s1', 'gate 3 auto-merge-fail: no passing CI')]))
    expect(card(halted, 'B1')).toMatchObject({ state: 'needs-you', meta: 'PR #7 · autopilot stopped' })
  })

  it('needs-you only from an entry naming this slice, with this sprint or none', () => {
    const rows = [{ wave: 1, code: 'C1' }]
    expect(stateOf(one(rows, { queue: [q('PENDING', 'engineer → human', 'plan: alpha · slice: C1', 'x')] }), 'C1')).toBe('needs-you')
    expect(stateOf(one(rows, { queue: [q('PENDING', 'engineer → human', 'sprint: s1 · slice: C2', 'x')] }), 'C1')).toBe('waiting')
    expect(stateOf(one(rows, { queue: [q('PENDING', 'engineer → human', 'sprint: s1 · slice: C1', 'x', false)] }), 'C1')).toBe('waiting')
    expect(stateOf(one(rows, { queue: [q('NOTE', 'engineer → orchestrator', 'sprint: s1 · slice: C1', 'x')] }), 'C1')).toBe('waiting')
    // Another sprint of the same plan: the entry is the plan's, but names a different sprint.
    const two = repo({
      sprints: [['s0', 'done'], ['s1', 'active']],
      archived: { s0: [{ wave: 1, code: 'C1', status: 'done', pr: pr(1) }] },
      docs: { s1: rows },
      queue: [q('PENDING', 'engineer → human', 'sprint: s0 · slice: C1', 'x')],
    })
    expect(stateOf(two, 'C1')).toBe('waiting')
  })

  it('each state has its chip', () => {
    expect(cardChip('needs-you')).toEqual({ cls: 's-you', label: 'needs you' })
    expect(cardChip('running')).toEqual({ cls: 's-run', label: 'running' })
    expect(cardChip('waiting')).toEqual({ cls: 's-idle', label: 'waiting' })
    expect(cardChip('blocked')).toEqual({ cls: 's-bad', label: 'blocked' })
    expect(cardChip('merged')).toEqual({ cls: 's-ok', label: 'merged' })
  })
})

describe('shown sprint', () => {
  const rows = (code: string): BoardRow[] => [{ wave: 1, code, status: 'done', pr: pr(1) }]

  it('the current sprint, with its caption, columns, and log status', () => {
    const r = repo({
      sprints: [
        ['s1', 'done'],
        ['s2', 'active'],
        ['s3', 'planned'],
      ],
      archived: { s1: rows('A1') },
      docs: { s2: [{ wave: 1, code: 'B1', status: 'done', pr: pr(7) }, { wave: 2, code: 'B2' }], s3: rows('C1') },
    })
    const b = wb(r)
    expect(b.sprint).toBe('s2')
    expect(b.caption).toBe('Sprint 2 of 3 · s2')
    expect(b.columns.map((c) => [c.wave, c.status, c.cards.map((k) => k.code)])).toEqual([
      [1, 'merged PR #7', ['B1']],
      // Nothing runs and nothing asks: the wave in progress waits, as the runs list says (idle).
      [2, 'waiting', ['B2']],
    ])
    expect(card(b, 'B1').row).toMatchObject({ code: 'B1', title: 'Title B1' })
    expect(card(b, 'B1').slice).toMatchObject({ code: 'B1', branch: 's2-B1' })
    expect(card(b, 'B1').title).toBe('Title B1')
  })

  it('no current sprint → the last sprint with a doc', () => {
    const r = repo({
      sprints: [
        ['s1', 'done'],
        ['s2', 'done'],
        ['s3', 'done'],
      ],
      archived: { s1: rows('A1'), s2: rows('B1') },
    })
    const b = wb(r)
    expect(b.sprint).toBe('s2')
    expect(b.caption).toBe('Sprint 2 of 3 · s2')
    expect(cards(b).map((c) => c.code)).toEqual(['B1'])
  })

  it('a current sprint with no doc, or with no slices, gives no columns', () => {
    const noDoc = wb(repo({ sprints: [['s1', 'done'], ['s2', 'active']], archived: { s1: rows('A1') } }))
    expect(noDoc).toMatchObject({ sprint: 's2', columns: [], edges: [] })
    const empty = wb(repo({ sprints: [['s1', 'active']], docs: { s1: [] } }))
    expect(empty).toMatchObject({ sprint: 's1', columns: [] })
    expect(empty.counts).toEqual({ 'needs-you': 0, running: 0, waiting: 0, blocked: 0, merged: 0 })
  })

  it('no sprint with a doc at all gives no sprint and no columns', () => {
    const r = repo({ sprints: [['s1', 'done']] })
    expect(wb(r)).toMatchObject({ columns: [], edges: [] })
    expect(wb(r).sprint).toBeUndefined()
  })

  it('an unknown plan → undefined', () => {
    expect(buildWaveBoard(one([{ wave: 1, code: 'A1' }]), 'nope', NOW)).toBeUndefined()
  })

  it('boardSlices lists the shown board’s codes, or none', () => {
    const r = one([{ wave: 1, code: 'A1' }, { wave: 2, code: 'B1' }])
    expect(boardSlices(r, 'alpha', NOW)).toEqual(['A1', 'B1'])
    expect(boardSlices(r, 'nope', NOW)).toEqual([])
    expect(boardSlices(undefined, 'alpha', NOW)).toEqual([])
  })
})

describe('card meta', () => {
  const long = 'x'.repeat(80)

  it('merged → model · confidence · minutes', () => {
    const r = one([{ wave: 1, code: 'A1', status: 'done', pr: pr(1), confidence: 'high', model: 'Opus' }], {}, [ended({ sprint: 's1', slice: 'A1' })])
    expect(card(wb(r), 'A1').meta).toBe('opus · high · 22 min')
  })

  it('merged with unknown parts leaves them out', () => {
    expect(card(wb(one([{ wave: 1, code: 'A1', status: 'done', pr: pr(1) }])), 'A1').meta).toBe('')
    expect(card(wb(one([{ wave: 1, code: 'A1', status: 'done', pr: pr(1), confidence: 'high' }])), 'A1').meta).toBe('high')
  })

  it('running → model · minutes', () => {
    const r = one([{ wave: 1, code: 'A1', model: 'sonnet', confidence: 'high' }], {}, [running({ sprint: 's1', slice: 'A1' })])
    expect(card(wb(r), 'A1').meta).toBe('sonnet · 10 min')
    expect(card(wb(one([{ wave: 1, code: 'A1', status: 'pushed' }])), 'A1').meta).toBe('')
  })

  it('needs-you → TYPE: body of the latest such entry, cut to 60 characters', () => {
    const queue = [
      q('PENDING', 'engineer → human', 'sprint: s1 · slice: A1', 'older question'),
      q('PENDING', 'engineer → human', 'sprint: s1 · slice: A1', 'keep undo after reload?'),
      q('NOTE', 'engineer → orchestrator', 'sprint: s1 · slice: A1', 'not for you'),
    ]
    expect(card(wb(one([{ wave: 1, code: 'A1' }], { queue })), 'A1').meta).toBe('PENDING: keep undo after reload?')
    const cut = card(wb(one([{ wave: 1, code: 'A1' }], { queue: [q('PENDING', 'engineer → human', 'plan: alpha · slice: A1', long)] })), 'A1').meta
    expect(cut).toBe(`PENDING: ${'x'.repeat(50)}…`)
    expect(cut).toHaveLength(60)
    const exact = 'y'.repeat(51)
    expect(card(wb(one([{ wave: 1, code: 'A1' }], { queue: [q('PENDING', 'engineer → human', 'plan: alpha · slice: A1', exact)] })), 'A1').meta).toBe(`PENDING: ${exact}`)
  })

  it('blocked → the latest pending BLOCKED entry naming it, else its status', () => {
    const queue = [
      q('BLOCKED', 'engineer → orchestrator', 'sprint: s1 · slice: A1', 'tests fail on main'),
      q('BLOCKED', 'engineer → orchestrator', 'sprint: s1 · slice: A1', 'old', false),
      q('BLOCKED', 'engineer → orchestrator', 'plan: alpha · slice: A2', 'another slice'),
    ]
    expect(card(wb(one([{ wave: 1, code: 'A1', status: 'blocked' }], { queue })), 'A1').meta).toBe('BLOCKED: tests fail on main')
    expect(card(wb(one([{ wave: 1, code: 'A1', status: 'skipped' }])), 'A1').meta).toBe('status skipped')
    const cut = card(wb(one([{ wave: 1, code: 'A1', status: 'blocked' }], { queue: [q('BLOCKED', 'engineer → orchestrator', 'plan: alpha · slice: A1', long)] })), 'A1').meta
    expect(cut).toHaveLength(60)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('waiting → needs <codes> as written, else the model', () => {
    const b = wb(
      one([
        { wave: 1, code: 'A1', model: 'opus' },
        { wave: 2, code: 'B1', deps: 'A1, Z9', model: 'opus' },
        { wave: 2, code: 'B2' },
      ]),
    )
    expect(card(b, 'A1').meta).toBe('opus')
    expect(card(b, 'B1').meta).toBe('needs A1, Z9')
    expect(card(b, 'B2').meta).toBe('')
  })
})

describe('edges', () => {
  it('one per dependency on an earlier-wave slice of this board, in board order', () => {
    const r = repo({
      sprints: [['s0', 'done'], ['s1', 'active']],
      archived: { s0: [{ wave: 1, code: 'X1', status: 'done', pr: pr(1) }] },
      docs: {
        s1: [
          { wave: 1, code: 'A1' },
          { wave: 1, code: 'A2', deps: 'A1' }, // same wave
          { wave: 2, code: 'B1', deps: 'A1, A1, A2, X1' }, // duplicate, another sprint's code
          { wave: 2, code: 'B2', deps: 'B2, C1' }, // self, later wave
          { wave: 3, code: 'C1', deps: 'B1, A2' },
        ],
      },
    })
    expect(wb(r).edges.map(({ from, to }) => `${from}>${to}`)).toEqual(['A1>B1', 'A2>B1', 'B1>C1', 'A2>C1'])
  })

  it('no dependencies, no edges', () => {
    expect(wb(one([{ wave: 1, code: 'A1' }, { wave: 2, code: 'B1' }])).edges).toEqual([])
  })
})

describe('critical path', () => {
  const crit = (b: WaveBoard) => ({
    cards: cards(b)
      .filter((c) => c.critical)
      .map((c) => c.code),
    edges: b.edges.filter((e) => e.critical).map((e) => `${e.from}>${e.to}`),
  })

  it("the preview's example gives B1 → C1 → D1", () => {
    const b = wb(
      one([
        { wave: 1, code: 'B1' },
        { wave: 1, code: 'B2' },
        { wave: 1, code: 'B3' },
        { wave: 2, code: 'C1', deps: 'B1, B2' },
        { wave: 2, code: 'C2', deps: 'B1, B3' },
        { wave: 3, code: 'D1', deps: 'C1, C2' },
      ]),
    )
    expect(crit(b)).toEqual({ cards: ['B1', 'C1', 'D1'], edges: ['B1>C1', 'C1>D1'] })
    expect(b.edges.filter((e) => !e.critical)).toHaveLength(4)
  })

  it('a tie goes to the chain whose slices come first in board order, slice by slice', () => {
    // Both chains have 2 slices; A1 comes before A2 on the board, so A1 > B2 wins.
    const b = wb(
      one([
        { wave: 1, code: 'A1' },
        { wave: 1, code: 'A2' },
        { wave: 2, code: 'B1', deps: 'A2' },
        { wave: 2, code: 'B2', deps: 'A1' },
      ]),
    )
    expect(crit(b)).toEqual({ cards: ['A1', 'B2'], edges: ['A1>B2'] })
    // Same start: the second slice decides, by table order within its wave.
    const c = wb(
      one([
        { wave: 1, code: 'A1' },
        { wave: 2, code: 'B9', deps: 'A1' },
        { wave: 2, code: 'B1', deps: 'A1' },
      ]),
    )
    expect(crit(c)).toEqual({ cards: ['A1', 'B9'], edges: ['A1>B9'] })
  })

  it('a longer chain beats an earlier one', () => {
    const b = wb(
      one([
        { wave: 1, code: 'A1' },
        { wave: 1, code: 'A2' },
        { wave: 2, code: 'B1', deps: 'A1' },
        { wave: 2, code: 'B2', deps: 'A2' },
        { wave: 3, code: 'C1', deps: 'B2' },
      ]),
    )
    expect(crit(b).cards).toEqual(['A2', 'B2', 'C1'])
  })

  it('no edges → none; a single slice → none', () => {
    expect(crit(wb(one([{ wave: 1, code: 'A1' }, { wave: 2, code: 'B1' }])))).toEqual({ cards: [], edges: [] })
    expect(crit(wb(one([{ wave: 1, code: 'A1', deps: 'A1' }])))).toEqual({ cards: [], edges: [] })
  })
})

describe('filters', () => {
  const b = wb(
    one(
      [
        { wave: 1, code: 'A1', status: 'done', pr: pr(1) },
        { wave: 1, code: 'A2', status: 'done', pr: pr(1) },
        { wave: 2, code: 'B1', status: 'pushed' },
        { wave: 2, code: 'B2', status: 'blocked' },
        { wave: 3, code: 'C1' },
        { wave: 3, code: 'C2' },
      ],
      { queue: [q('PENDING', 'engineer → human', 'sprint: s1 · slice: C2', 'x')] },
      [POD],
    ),
  )
  const dimmed = (f: ReturnType<typeof filterState.toggle>) =>
    cards(b)
      .filter((c) => filterState.isDimmed(f, c))
      .map((c) => c.code)

  it('counts over all cards', () => {
    expect(b.counts).toEqual({ 'needs-you': 1, running: 1, waiting: 1, blocked: 1, merged: 2 })
  })

  it('the chips come in the preview’s order', () => {
    expect(filterState.ORDER).toEqual(['needs-you', 'running', 'waiting', 'blocked', 'merged'])
  })

  it('an empty set dims nothing; toggle adds and removes', () => {
    let f = filterState.forSprint(undefined, 's1')
    expect(dimmed(f)).toEqual([])
    f = filterState.toggle(f, 'merged')
    expect(filterState.isOn(f, 'merged')).toBe(true)
    expect(dimmed(f)).toEqual(['B1', 'B2', 'C1', 'C2'])
    f = filterState.toggle(f, 'running')
    expect(dimmed(f)).toEqual(['B2', 'C1', 'C2'])
    f = filterState.toggle(filterState.toggle(f, 'merged'), 'running')
    expect(filterState.isOn(f, 'merged')).toBe(false)
    expect(dimmed(f)).toEqual([])
  })

  it('counts never change with the filter', () => {
    const before = structuredClone(b.counts)
    filterState.toggle(filterState.forSprint(undefined, 's1'), 'blocked')
    expect(b.counts).toEqual(before)
  })

  it('the set clears when the shown sprint changes, and stays while it doesn’t', () => {
    const f = filterState.toggle(filterState.forSprint(undefined, 'r/alpha/s1'), 'merged')
    expect(filterState.forSprint(f, 'r/alpha/s1')).toBe(f)
    const g = filterState.forSprint(f, 'r/alpha/s2')
    expect(filterState.isOn(g, 'merged')).toBe(false)
    expect(g.key).toBe('r/alpha/s2')
  })
})

describe('engineer for a slice', () => {
  it('picks the latest-started engineer of the slice', () => {
    const old = ended({ sprint: 's1', slice: 'A1', startedAt: NOW - 300 * MIN })
    const late = ended({ sprint: 's1', slice: 'A1', startedAt: NOW - 30 * MIN })
    const noStart = agent({ sprint: 's1', slice: 'A1' })
    const reviewer = agent({ type: 'pod:reviewer', plan: 'alpha', sprint: 's1', slice: 'A1', startedAt: NOW })
    const other = agent({ sprint: 's1', slice: 'A2', startedAt: NOW })
    const notEngineer = agent({ type: 'pod:scout', sprint: 's1', slice: 'A1', startedAt: NOW })
    const r = one([{ wave: 1, code: 'A1' }, { wave: 1, code: 'A2' }], {}, [noStart, old, late, reviewer, other, notEngineer])
    expect(engineerFor(r, 'alpha', 's1', 'A1')).toBe(late)
    expect(engineerFor(r, 'alpha', 's1', 'A2')).toBe(other)
  })

  it('a missing start counts as oldest; an engineer type ends in engineer', () => {
    const noStart = agent({ sprint: 's1', slice: 'A1' })
    const plain = agent({ type: 'engineer', sprint: 's1', slice: 'A1', startedAt: NOW - 50 * MIN })
    const r = one([{ wave: 1, code: 'A1' }], {}, [plain, noStart])
    expect(engineerFor(r, 'alpha', 's1', 'A1')).toBe(plain)
    expect(engineerFor(one([{ wave: 1, code: 'A1' }], {}, [noStart]), 'alpha', 's1', 'A1')).toBe(noStart)
  })

  it('none, another sprint, or an unknown plan → undefined', () => {
    const r = one([{ wave: 1, code: 'A1' }, { wave: 1, code: 'A2' }], {}, [ended({ sprint: 's1', slice: 'A2' })])
    expect(engineerFor(r, 'alpha', 's1', 'A1')).toBeUndefined()
    expect(engineerFor(r, 'alpha', 's9', 'A2')).toBeUndefined()
    expect(engineerFor(r, 'nope', 's1', 'A2')).toBeUndefined()
  })
})
