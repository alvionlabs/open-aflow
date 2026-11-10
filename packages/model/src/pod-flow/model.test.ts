import { expect, test } from 'vitest'

import { ageNote, buildTree, header, mainCheckout, snapshot, formatTokens, tokenTotals, turnTokens, concernText, fit, parseQueue, formatAge, prState, latestHalt, sliceOf, parseDispatch, parsePlan, parseSprint, milestones, prefixes, summarize, tableRows, visibleLines } from './model.ts'
import type { TreeLine } from './types.ts'

const PLAN = `# Plan: Long runs

_Generated: 2026-10-01 · Status: active · Grilled-with: pod_

## Sprints

| Sprint | Goal | Status | Depends on |
|--------|------|--------|------------|
| core | Build the core | done | — |
| ui | Build the screens | active | core |
| polish | Tidy up | planned | ui |
`

const SPRINT = `# Sprint: UI

_From plan: docs/plans/long-runs.md · Slug: ui · Status: active · Generated: 2026-10-02_

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | A1 | List screen | ui-A1 | merged | done | high | — |
| 1 | A2 | Detail screen | ui-A2 | merged | done | medium | — |
| 2 | B1 | Search box | ui-B1 | — | pending | — | A1 |
| 2 | B2 | Filters | ui-B2 | — | pending | — | A1 |

## Shared contract
`

test('tableRows reads the body of the table by its first header', () => {
  expect(tableRows(SPRINT, 'Wave')).toHaveLength(4)
  expect(tableRows(SPRINT, 'Nope')).toEqual([])
})

test('parsePlan reads the title, status and sprint rows', () => {
  const plan = parsePlan(PLAN, 'long-runs')
  expect(plan.title).toBe('Long runs')
  expect(plan.status).toBe('active')
  expect(plan.sprints.map(s => `${s.slug}:${s.status}`)).toEqual(['core:done', 'ui:active', 'polish:planned'])
})

test('parseSprint reads the slug, plan and board', () => {
  const sprint = parseSprint(SPRINT, false)
  expect(sprint?.slug).toBe('ui')
  expect(sprint?.plan).toBe('long-runs')
  expect(sprint?.rows[2]).toEqual({
    wave: 2,
    slice: 'B1',
    title: 'Search box',
    branch: 'ui-B1',
    pr: '—',
    status: 'pending',
    confidence: '—',
  })
})

test('parseSprint returns nothing for a doc with no slug', () => {
  expect(parseSprint('# Not a sprint', false)).toBeUndefined()
})

test('parseDispatch reads sprint, slice and branch from a dispatch prompt', () => {
  const prompt = ['- sprint slug:      ui', '- slice code:       B1', '- branch name:      ui-B1'].join('\n')
  expect(parseDispatch(prompt)).toEqual({ sprint: 'ui', slice: 'B1', branch: 'ui-B1' })
  expect(parseDispatch('Draft the next sprint.')).toEqual({ sprint: undefined, slice: undefined, branch: undefined })
})

test('latestHalt returns the newest pending orchestrator entry only', () => {
  const queue = [
    '- `[2026-10-01 · BLOCKED · orchestrator → human · sprint: ui]` Gate 4: wave check failed **Resolution:** 2026-10-01 — fixed',
    '- `[2026-10-02 · PENDING · engineer → orchestrator · sprint: ui · slice: B1]` NOTE for B2 **Resolution:** pending',
    '- `[2026-10-03 · BLOCKED · orchestrator → human · sprint: ui]` Gate 6: low confidence on B1 **Resolution:** pending',
  ].join('\n')
  expect(latestHalt(queue)).toEqual({ body: 'Gate 6: low confidence on B1', type: 'BLOCKED' })
  expect(latestHalt('- `[2026-10-01 · BLOCKED · orchestrator → human]` Done **Resolution:** 2026-10-02 — ok')).toBeUndefined()
})

test('latestHalt skips a pending orchestrator note that names no gate', () => {
  const queue = [
    '- `[2026-10-03 · BLOCKED · orchestrator → human · sprint: ui]` auto-merge-fail: PR #14 failed CI **Resolution:** pending',
    // chess-web's queue keeps notes like this one, which never stopped the run.
    '- `[2026-10-06 · PENDING · orchestrator → human · sprint: ui · slice: wave 2]` **Someday (Look):** the picker hangs past the board edge. **Resolution:** pending',
  ].join('\n')
  expect(latestHalt(queue)?.body).toBe('auto-merge-fail: PR #14 failed CI')
  expect(latestHalt(queue.split('\n')[1]!)).toBeUndefined()
  expect(latestHalt('- `[2026-10-06 · PENDING · orchestrator → human]` plan board-feel complete — final PR #55 **Resolution:** pending')?.type).toBe('PENDING')
})

test('latestHalt keeps to the plan shown, by its plan or its sprint', () => {
  const plan = { slug: 'next', title: 'Next', status: 'active', sprints: [{ slug: 'ui', goal: '', status: 'active' }] }
  const old = '- `[2026-10-06 · PENDING · orchestrator → human · plan: board-feel]` plan board-feel complete — final PR #55 **Resolution:** pending'
  const oldSprint = '- `[2026-10-06 · BLOCKED · orchestrator → human · sprint: rules]` Gate 6: low confidence **Resolution:** pending'
  expect(latestHalt(old, plan)).toBeUndefined()
  expect(latestHalt(oldSprint, plan)).toBeUndefined()
  expect(latestHalt(`${old}\n- \`[2026-10-07 · BLOCKED · orchestrator → human · sprint: ui]\` Gate 4: wave check failed **Resolution:** pending`, plan)?.body).toBe('Gate 4: wave check failed')
  // An entry that names neither is kept, as before.
  expect(latestHalt('- `[2026-10-07 · BLOCKED · orchestrator → human]` Gate 3: PR blocked **Resolution:** pending', plan)?.type).toBe('BLOCKED')
})

test('buildTree maps plan, sprints, waves and slices, and marks a live engineer', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { agent1: { type: 'pod:engineer', description: 'B1', sprint: 'ui', slice: 'B1', branch: 'ui-B1' } },
    live: [{ id: 'agent1', type: 'pod:engineer', status: 'running' }],
  })
  const text = lines.map(l => `${l.depth} ${l.kind} ${l.text.split(' ')[0]} ${l.status}`)
  expect(text).toContain('0 plan Long running')
  expect(text).toContain('1 sprint ui running')
  expect(text).toContain('2 wave wave done')
  expect(text).toContain('3 slice B1 running')
  expect(text).toContain('3 slice B2 waiting')
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 2')?.status).toBe('running')
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 1')?.note).toBeUndefined()
})

test('buildTree lists a running agent that matches no slice', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [],
    spawns: {},
    live: [{ id: 'r1', type: 'pod:reviewer', status: 'running' }],
  })
  expect(lines.some(l => l.kind === 'agent' && l.text === 'reviewer')).toBe(true)
})

test('buildTree shows a halt only when no agent is running', () => {
  const input = { plan: parsePlan(PLAN, 'long-runs'), sprints: [], spawns: {}, halt: 'Gate 2: plan review failed —' }
  const idle = buildTree({ ...input, live: [] })
  expect(idle.find(l => l.kind === 'halt')).toMatchObject({ status: 'blocked', note: 'Gate 2: plan review failed' })
  const busy = buildTree({ ...input, live: [{ id: 'r1', type: 'pod:reviewer', status: 'running' }] })
  expect(busy.some(l => l.kind === 'halt')).toBe(false)
})

test('sliceOf falls back to a slice code in the description or branch', () => {
  const codes = ['A1', 'B1']
  expect(sliceOf({ type: 'pod:engineer', description: 'B1 search box' }, codes)).toBe('B1')
  expect(sliceOf({ type: 'pod:engineer', description: 'work', branch: 'ui-A1' }, codes)).toBe('A1')
  expect(sliceOf({ type: 'pod:engineer', description: 'Draft the sprint' }, codes)).toBeUndefined()
  expect(sliceOf({ type: 'pod:engineer', description: 'x', slice: 'B1' }, codes)).toBe('B1')
})

test('buildTree marks the slice live when the prompt gave no slice code', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { e1: { type: 'pod:engineer', description: 'B1 search box' } },
    live: [{ id: 'e1', type: 'pod:engineer', status: 'running' }],
  })
  expect(lines.find(l => l.kind === 'slice' && l.text.startsWith('B1'))?.status).toBe('running')
  expect(lines.some(l => l.kind === 'agent')).toBe(false)
})

test('prefixes draw branches and close them under the last sibling, each sprint a tree of its own', () => {
  const at = (depth: number, text: string): TreeLine => ({ depth, kind: 'slice', text, status: 'done' })
  const lines = [at(1, 'core'), at(2, 'wave 1'), at(2, 'wave 2'), at(3, 'A1'), at(1, 'ui'), at(2, 'wave 1')]
  expect(prefixes(lines)).toEqual(['', '├─ ', '└─ ', '   └─ ', '', '└─ '])
})

test('a narrow header shortens the plan name first, then leaves it out', () => {
  const lines: TreeLine[] = [
    { depth: 0, kind: 'plan', text: 'Skyscraper View', status: 'done', note: '3.0M tokens' },
    { depth: 1, kind: 'sprint', text: 'city-scene', status: 'done' },
    { depth: 1, kind: 'halt', text: 'waiting', status: 'pushed' },
  ]
  expect(header(lines)).toBe('Skyscraper View · all sprints done · waiting on you · 3.0M tokens')
  expect(header(lines, 60)).toBe('Skyscrape… · all sprints done · waiting on you · 3.0M tokens')
  expect(header(lines, 50)).toBe('all sprints done · waiting on you · 3.0M tokens')
})

test('summarize reports sprint, wave, running and blocked counts', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { e1: { type: 'pod:engineer', description: 'B1 search box' } },
    live: [{ id: 'e1', type: 'pod:engineer', status: 'running' }],
  })
  expect(summarize(lines)).toBe('sprint 2/3 · wave 2/2 · 1 running')
})

test('summarize counts blocked slices and says when all sprints are done', () => {
  const blocked = parseSprint(SPRINT.replaceAll('| pending | — | A1 |', '| blocked | — | A1 |'), false)!
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [blocked], spawns: {}, live: [] })
  expect(summarize(lines)).toContain('2 blocked')
  const done = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |').replace('planned', 'done'), 'long-runs')
  expect(summarize(buildTree({ plan: done, sprints: [], spawns: {}, live: [] }))).toBe('all sprints done')
})

test('milestones name finished waves and sprints, open PRs and blocked slices, never a wave start', () => {
  const live = parseSprint(SPRINT.replace('| ui-B1 | — | pending |', '| ui-B1 | https://github.com/demo/app/pull/14 | pushed |').replace('| ui-B2 | — | pending |', '| ui-B2 | — | blocked |'), false)!
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [live], spawns: {}, live: [] })
  expect([...milestones(lines).values()]).toEqual([
    '✓ sprint core done (1/3)',
    '✓ ui · wave 1 done',
    '◐ ui · wave 2 · PR #14 open',
    '✗ BLOCKED · ui · B2 Filters',
  ])
})

test('milestones name a halt and a finished plan', () => {
  const done = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |').replace('planned', 'done'), 'long-runs')
  const lines = buildTree({ plan: done, sprints: [], spawns: {}, live: [], halt: 'plan long-runs complete — final PR #20' })
  const told = milestones(lines)
  expect(told.get('plan')).toBe('✓ plan Long runs done')
  expect([...told.values()]).toContain('◐ WAITING · plan long-runs complete — final PR #20')
})

test('formatAge writes seconds, minutes and hours', () => {
  expect([45_000, 180_000, 3_900_000].map(formatAge)).toEqual(['45s', '3m', '1h05m'])
})

test('an archived sprint doc is done, though the plan cell still says active', () => {
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(SPRINT, true)!], spawns: {}, live: [] })
  expect(lines.find(l => l.kind === 'sprint' && l.text === 'ui')?.status).toBe('done')
  expect(summarize(lines)).toBe('sprint 3/3')
})

test('ageNote adds a quiet flag after two silent minutes', () => {
  expect(ageNote(0, 170_000, 180_000)).toBe('3m')
  expect(ageNote(0, 30_000, 180_000)).toBe('3m · quiet 2m')
  expect(ageNote(0, undefined, 60_000)).toBe('1m')
  expect(ageNote(undefined, undefined, 60_000)).toBeUndefined()
})

test('buildTree shows how long a running engineer has run', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { e1: { type: 'pod:engineer', description: 'B1 search box', startedAt: 0 } },
    live: [{ id: 'e1', type: 'pod:engineer', status: 'running' }],
    now: 300_000,
    lastSeen: { e1: 100_000 },
  })
  expect(lines.find(l => l.kind === 'slice' && l.text.startsWith('B1'))?.note).toBe('5m · quiet 3m')
})

test('visibleLines folds a finished sprint with a board, and opens it on request', () => {
  const done = SPRINT.replaceAll('| pending |', '| done |')
  const plan = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |'), 'long-runs')
  const lines = buildTree({ plan, sprints: [parseSprint(done, true)!], spawns: {}, live: [] })

  const folded = visibleLines(lines, [])
  expect(folded.some(l => l.kind === 'slice')).toBe(false)
  expect(folded.find(l => l.sprint === 'ui' && l.kind === 'sprint')?.detail).toBe('2 waves · 4 slices')

  const opened = visibleLines(lines, ['ui'])
  expect(opened.filter(l => l.kind === 'slice')).toHaveLength(4)
})

test('visibleLines never folds a sprint that is running or has no board, but folds its finished waves', () => {
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(SPRINT, false)!], spawns: {}, live: [] })
  const shown = visibleLines(lines, [])
  expect(shown.some(l => l.kind === 'sprint' && l.text === 'core')).toBe(true)
  // Wave 1 is done: one row in place of its two slices. Wave 2 is at work and stays open.
  expect(shown.find(l => l.kind === 'wave' && l.text === 'wave 1')).toMatchObject({ status: 'done', detail: '2 slices' })
  expect(shown.filter(l => l.kind === 'slice').map(l => l.text.split(' ')[0])).toEqual(['B1', 'B2'])
  expect(visibleLines(lines, ['ui/wave 1']).filter(l => l.kind === 'slice')).toHaveLength(4)
})

test('a finished wave stays open when its sprint is done, or when it has a queue entry', () => {
  const done = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(SPRINT, true)!], spawns: {}, live: [] })
  // An opened finished sprint shows all of it: its waves don't fold again.
  expect(done.filter(l => l.kind === 'wave').every(l => l.detail === undefined)).toBe(true)
  const queue = parseQueue('- `[2026-10-02 · BLOCKED · engineer → human · sprint: ui · slice: A1]` the list API needs a key **Resolution:** pending')
  const noted = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(SPRINT, false)!], spawns: {}, live: [], queue })
  expect(noted.find(l => l.kind === 'wave' && l.text === 'wave 1')?.detail).toBeUndefined()
})

test('prState reads the board PR cell', () => {
  expect(prState('—')).toEqual({ state: 'none' })
  expect(prState('merged')).toEqual({ state: 'merged' })
  expect(prState('skipped — verification failed')).toEqual({ state: 'skipped' })
  expect(prState('blocked')).toEqual({ state: 'blocked' })
  expect(prState('https://github.com/me/app/pull/12')).toEqual({ state: 'open', number: '12' })
  expect(prState('[#12](https://github.com/me/app/pull/12)')).toEqual({ state: 'open', number: '12' })
})

const waveNote = (pr: string, status = 'pushed') => {
  const board = SPRINT.replaceAll('| ui-B1 | — | pending |', `| ui-B1 | ${pr} | ${status} |`).replaceAll('| ui-B2 | — | pending |', `| ui-B2 | ${pr} | ${status} |`)
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(board, false)!], spawns: {}, live: [] })
  return lines.find(l => l.kind === 'wave' && l.text === 'wave 2')
}

test('a wave with an open PR says so', () => {
  expect(waveNote('https://github.com/me/app/pull/12')).toMatchObject({ status: 'running', note: 'PR #12 open · 0/2' })
})

test('an open PR wins even when every slice is marked done', () => {
  expect(waveNote('https://github.com/me/app/pull/12', 'done')).toMatchObject({ status: 'running', note: 'PR #12 open · 2/2' })
})

test('a merged wave is done, and a skipped one is blocked', () => {
  expect(waveNote('merged', 'done')).toMatchObject({ status: 'done', note: undefined })
  expect(waveNote('skipped — verification failed')).toMatchObject({ status: 'blocked', note: 'skipped · 0/2' })
})

test('fit keeps the note and shortens the name when the row is too long', () => {
  expect(fit('├─ ✓ short', '3 waves', 40)).toBe('├─ ✓ short  3 waves')
  const row = fit('├─ ✓ king-safety-endgame', '3 waves · 3 slices', 40)
  expect(row).toBe('├─ ✓ king-safety-en…  3 waves · 3 slices')
  expect(row.length).toBeLessThanOrEqual(40)
})

test('fit keeps the whole name and cuts the end of a long note', () => {
  const row = fit('└─ ● engineer', '4m · Fix inaudible capture sound', 40)
  expect(row).toBe('└─ ● engineer  4m · Fix inaudible captu…')
  expect(row.length).toBeLessThanOrEqual(40)
})

test('an agent line puts its age before its description', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [],
    spawns: { f1: { type: 'pod:engineer', description: 'Fix inaudible capture sound', startedAt: 0 } },
    live: [{ id: 'f1', type: 'pod:engineer', status: 'running' }],
    now: 240_000,
    lastSeen: { f1: 230_000 },
  })
  expect(lines.find(l => l.kind === 'agent')?.note).toBe('4m · Fix inaudible capture sound')
})

test('the plan shows done once every sprint is done and no agent runs', () => {
  const done = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |').replace('planned', 'done'), 'long-runs')
  expect(buildTree({ plan: done, sprints: [], spawns: {}, live: [] })[0]?.status).toBe('done')
  const busy = buildTree({ plan: done, sprints: [], spawns: {}, live: [{ id: 'f1', type: 'pod:engineer', status: 'running' }] })
  expect(busy[0]?.status).toBe('running')
})

// A board as chess-web writes it: extra Difficulty and Agent columns, no Confidence, "#3 merged" in PR.
const CHESS_BOARD = `# Sprint: Engine Foundation

_From plan: docs/plans/pure-engine-refactor.md · Slug: engine-foundation · Status: archived · Generated: 2026-06-04_

## Status board

| Wave | Slice | Title | Difficulty | Agent | Branch | PR | Status | Depends on |
|------|-------|-------|------------|-------|--------|----|--------|------------|
| 1 | harness | Stand up the Vitest test harness | 2 | engineer-junior | engine-foundation-harness | #3 merged | done | — |
| 2 | gamestate | Define the immutable GameState | 3 | engineer-senior | engine-foundation-gamestate | #4 merged | done | harness |
| 2 | tracer | Tracer-bullet legalMoves | 3 | engineer-senior | engine-foundation-tracer | #5 merged | done | harness |
`

const CHESS_PLAN = `# Plan: Pure engine

_Generated: 2026-06-01 · Status: active_

| Sprint | Goal | Status | Depends on |
|--------|------|--------|------------|
| engine-foundation | Build the engine base | done | — |
`

test('parseSprint reads a board by its header names, whatever the column order', () => {
  const sprint = parseSprint(CHESS_BOARD, true)
  expect(sprint?.rows[0]).toEqual({
    wave: 1,
    slice: 'harness',
    title: 'Stand up the Vitest test harness',
    branch: 'engine-foundation-harness',
    pr: '#3 merged',
    status: 'done',
    confidence: '—',
  })
})

test("a board with a different layout still shows merged waves as done with no stray notes", () => {
  const lines = buildTree({
    plan: parsePlan(CHESS_PLAN, 'pure-engine'),
    sprints: [parseSprint(CHESS_BOARD, true)!],
    spawns: {},
    live: [],
  })
  const waves = lines.filter(l => l.kind === 'wave')
  expect(waves.map(w => `${w.text} ${w.status} ${w.note}`)).toEqual(['wave 1 done undefined', 'wave 2 done undefined'])
  const slices = lines.filter(l => l.kind === 'slice')
  expect(slices.every(l => l.status === 'done' && l.note === undefined)).toBe(true)
})

test('an open PR in that layout shows on its wave', () => {
  const open = CHESS_BOARD.replaceAll('| #4 merged | done |', '| https://github.com/me/chess/pull/4 | pushed |').replaceAll('| #5 merged | done |', '| https://github.com/me/chess/pull/4 | pushed |')
  const lines = buildTree({ plan: parsePlan(CHESS_PLAN, 'pure-engine'), sprints: [parseSprint(open, false)!], spawns: {}, live: [] })
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 2')).toMatchObject({ status: 'running', note: 'PR #4 open · 0/2' })
})

const PR4 = 'https://github.com/me/chess/pull/4'

test('a done slice with a PR link is merged once the sprint is archived', () => {
  const board = CHESS_BOARD.replaceAll('| #4 merged |', `| ${PR4} |`).replaceAll('| #5 merged |', `| ${PR4} |`)
  const lines = buildTree({ plan: parsePlan(CHESS_PLAN, 'pure-engine'), sprints: [parseSprint(board, true)!], spawns: {}, live: [] })
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 2')).toMatchObject({ status: 'done', note: undefined })
})

test('a done slice with a PR link is merged once a later wave has started', () => {
  const board = `| Wave | Slice | Title | Branch | PR | Status |
|------|-------|-------|--------|----|--------|
| 1 | A | one | b-A | ${PR4} | done |
| 2 | B | two | b-B | — | pushed |
`
  const doc = parseSprint(`_From plan: docs/plans/p.md · Slug: s · Status: active_\n\n${board}`, false)!
  const plan = parsePlan(`# Plan: P\n\n_Status: active_\n\n| Sprint | Goal | Status | Depends on |\n|---|---|---|---|\n| s | g | active | — |\n`, 'p')
  const lines = buildTree({ plan, sprints: [doc], spawns: {}, live: [] })
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 1')).toMatchObject({ status: 'done' })
})

test('a running sprint-planner sits under the sprint it drafts, not loose at the end', () => {
  const plan = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |'), 'long-runs')
  const spawns = { p1: { type: 'pod:sprint-planner', description: 'Draft next sprint', startedAt: 0 } }
  const lines = buildTree({ plan, sprints: [], spawns, live: [{ id: 'p1', type: 'pod:sprint-planner', status: 'running' }], now: 120_000 })
  const at = lines.findIndex(l => l.kind === 'sprint' && l.text === 'polish')
  expect(lines[at]).toMatchObject({ status: 'running' })
  expect(lines[at + 1]).toMatchObject({ depth: 2, kind: 'agent', text: 'drafting', status: 'running' })
  expect(lines.filter(l => l.kind === 'agent')).toHaveLength(1)
  expect(snapshot(lines)).toBe(`Long runs · sprint 3/3 · 1 running\n✓ 2 sprints done\n● polish\n└─ ● drafting ${lines[at + 1]!.note}`)
})

test('a plan header that ends on its status reads it without the closing underscore', () => {
  expect(parsePlan('# Plan: P\n\n_Generated: 2026-10-01 · Status: archived_\n', 'p').status).toBe('archived')
})

test('plan and sprint statuses read the same in any case', () => {
  const plan = parsePlan(PLAN.replace('Status: active', 'Status: Archived').replace('| core | Build the core | done |', '| core | Build the core | Done |'), 'long-runs')
  expect(plan.status).toBe('archived')
  expect(plan.sprints[0]?.status).toBe('done')
})

test('a sprint with a live doc runs even when its plan cell still says planned', () => {
  const plan = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | planned |'), 'long-runs')
  const lines = buildTree({ plan, sprints: [parseSprint(SPRINT, false)!], spawns: {}, live: [] })
  expect(lines.filter(l => l.kind === 'sprint').map(l => `${l.text}:${l.status}`)).toEqual(['core:done', 'ui:running', 'polish:waiting'])
  expect(summarize(lines)).toBe('sprint 2/3 · wave 2/2')
})

test('merged as a status counts as done', () => {
  const board = CHESS_BOARD.replaceAll('| #3 merged | done |', '| — | merged |').replaceAll('| #4 merged | done |', '| — | merged |').replaceAll('| #5 merged | done |', '| — | merged |')
  const lines = buildTree({ plan: parsePlan(CHESS_PLAN, 'pure-engine'), sprints: [parseSprint(board, false)!], spawns: {}, live: [] })
  expect(lines.filter(l => l.kind === 'wave').every(w => w.status === 'done')).toBe(true)
})

test('a status cell with a PR link in front still reads as its status word', () => {
  const board = CHESS_BOARD.replace('| #3 merged | done |', '| — | [#225](https://github.com/me/chess/pull/225) merged |')
  expect(parseSprint(board, true)?.rows[0]?.status).toBe('merged')
})

test('parseSprint falls back to the file name when a doc has no Slug header', () => {
  expect(parseSprint('# Old sprint\n\n' + tableRowsFixture(), true, 'roster-foundation')?.slug).toBe('roster-foundation')
  expect(parseSprint('# Old sprint', true)).toBeUndefined()
})

function tableRowsFixture() {
  return '| Wave | Slice | Title | Status |\n|---|---|---|---|\n| 1 | a | t | done |\n'
}

test('a finished plan waiting on its final PR is a hand-back, not a halt', () => {
  const done = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |').replace('planned', 'done'), 'long-runs')
  const lines = buildTree({ plan: done, sprints: [], spawns: {}, live: [], halt: 'plan board-feel complete — final PR https://github.com/me/app/pull/55' }).filter(l => l.kind !== 'sprint')
  expect(lines.find(l => l.kind === 'halt')).toMatchObject({ kind: 'halt', text: 'waiting', status: 'pushed' })
  const summary = summarize(buildTree({ plan: done, sprints: [], spawns: {}, live: [], halt: 'plan board-feel complete' }))
  expect(summary).toContain('waiting on you')
  expect(summary).not.toContain('blocked')
})

test('a gate halt shows as halted in the summary, with no blocked slice', () => {
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [], spawns: {}, live: [], halt: 'Gate 4: wave check failed' })
  expect(lines.find(l => l.kind === 'halt')).toMatchObject({ text: 'halted', status: 'blocked' })
  expect(summarize(lines)).toBe('sprint 2/3 · halted')
})

test('a halt gets a resume hint on lines of its own, and a hand-back gets none', () => {
  const input = { plan: parsePlan(PLAN, 'long-runs'), sprints: [], spawns: {}, live: [] }
  const blocked = buildTree({ ...input, halt: 'Gate 4: wave check failed', haltType: 'BLOCKED' })
  expect(blocked.slice(-2)).toMatchObject([
    { depth: 2, kind: 'hint', text: 'fix it first' },
    { depth: 2, kind: 'hint', text: 'then /pod:autopilot to resume', isContinued: true },
  ])
  // One branch for the hint; its second line hangs under it.
  expect(prefixes(blocked).slice(-3)).toEqual(['', '└─ ', '   '])
  const pending = buildTree({ ...input, halt: 'Gate 5: --max-waves reached', haltType: 'PENDING' })
  expect(pending.at(-1)).toMatchObject({ kind: 'hint', text: '/pod:autopilot to resume' })
  const handBack = buildTree({ ...input, halt: 'plan long-runs complete — final PR #20', haltType: 'PENDING' })
  expect(handBack.some(l => l.kind === 'hint')).toBe(false)
})

test('the halt milestone leads with what to do, then why', () => {
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [], spawns: {}, live: [], halt: 'Gate 4: wave check failed', haltType: 'BLOCKED' })
  expect([...milestones(lines).values()]).toContain('✗ HALTED · fix it first, then /pod:autopilot to resume · Gate 4: wave check failed')
})

const QUEUE = [
  '- `[2026-10-06 · PENDING · engineer (B1) → orchestrator · sprint: ui · slice: B1]` The **search** box needs a `debounce`. See [the doc](docs/x.md). Second sentence. **Resolution:** pending',
  '- `[2026-10-06 · BLOCKED · engineer → orchestrator · sprint: ui · slice: B2]` Filters need a design call. **Resolution:** pending',
  '- `[2026-10-05 · PENDING · reviewer → orchestrator · sprint: ui · slice: A1]` Someday: rename the helper. **Resolution:** pending',
  '- `[2026-10-05 · PENDING · engineer → orchestrator · sprint: ui · slice: B1]` Old note already settled. **Resolution:** 2026-10-06 — fixed',
  '- `[2026-10-04 · SOLVED · engineer → orchestrator · sprint: ui · slice: B1]` Solved thing. **Resolution:** pending',
  '- `[2026-10-04 · PENDING · engineer → orchestrator · sprint: other · slice: B1]` Different sprint. **Resolution:** pending',
].join('\n')

test('parseQueue reads type, route, sprint, slice, body and whether it is pending', () => {
  const entries = parseQueue(QUEUE)
  expect(entries).toHaveLength(6)
  expect(entries[0]).toMatchObject({ type: 'PENDING', route: 'engineer (B1) → orchestrator', sprint: 'ui', slice: 'B1', isPending: true })
  expect(entries[3]?.isPending).toBe(false)
  expect(entries[0]?.body).not.toContain('Resolution')
})

test('concernText gives the first sentence as plain text', () => {
  expect(concernText('The **search** box needs a `debounce`. See [the doc](docs/x.md). Second sentence.')).toBe('The search box needs a debounce.')
  expect(concernText('**Someday:** rename the helper.')).toBe('rename the helper.')
})

const concernLines = (queue: string) =>
  buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(SPRINT, false)!], spawns: {}, live: [], queue: parseQueue(queue) }).filter(l => l.kind === 'concern')

test('a slice that is not done shows its pending concerns, nothing resolved or from another sprint', () => {
  const lines = concernLines(QUEUE)
  expect(lines.map(l => `${l.status} ${l.text}`)).toEqual(['waiting The search box needs a debounce.', 'blocked Filters need a design call.'])
})

test('a finished slice hides its notes, but still shows a BLOCKED one', () => {
  const finished = concernLines(QUEUE).some(l => l.text.includes('rename the helper'))
  expect(finished).toBe(false)
  const blocked = QUEUE + '\n- `[2026-10-06 · BLOCKED · engineer → orchestrator · sprint: ui · slice: A1]` Needs a decision. **Resolution:** pending'
  expect(concernLines(blocked).some(l => l.text === 'Needs a decision.')).toBe(true)
})

test('a slice shows at most the two newest concerns', () => {
  const many = [1, 2, 3, 4].map(n => `- \`[2026-10-0${n} · PENDING · e → o · sprint: ui · slice: B1]\` Note ${n}. **Resolution:** pending`).join('\n')
  expect(concernLines(many).map(l => l.text)).toEqual(['Note 3.', 'Note 4.'])
})

test('concerns sit under their slice, and do not add to the blocked count', () => {
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [parseSprint(SPRINT, false)!], spawns: {}, live: [], queue: parseQueue(QUEUE) })
  const at = lines.findIndex(l => l.kind === 'concern' && l.text.startsWith('Filters'))
  expect(lines[at - 1]?.text.startsWith('B2')).toBe(true)
  expect(summarize(lines)).not.toContain('blocked')
})

test('parseDispatch reads a reviewer plan slug and round, and ignores words that only end in round', () => {
  expect(parseDispatch('**plan slug**: `long-runs`\n**round**: 2')).toMatchObject({ plan: 'long-runs', round: 2 })
  expect(parseDispatch('run it in background: true').round).toBeUndefined()
})

test('mainCheckout gives the repo above a worktree, and leaves any other path alone', () => {
  expect(mainCheckout('E:\\Projects\\sky\\.claude\\worktrees\\living-day-w3')).toBe('E:\\Projects\\sky')
  expect(mainCheckout('/e/Projects/sky/.claude/worktrees/living-day-w3/src')).toBe('/e/Projects/sky')
  expect(mainCheckout('E:\\Projects\\sky')).toBe('E:\\Projects\\sky')
})

test('parseDispatch reads fields with the colon inside the bold, as autopilot writes them', () => {
  // From a real autopilot run: the closing ** sits between the colon and the value.
  const engineer = `Build slice D1 of sprint living-day.

- **sprint slug:** living-day
- **slice code:** D1
- **branch name:** living-day-D1 (local branch already in the worktree; not yet on origin)`
  expect(parseDispatch(engineer)).toMatchObject({ sprint: 'living-day', slice: 'D1', branch: 'living-day-D1' })
  expect(parseDispatch('- **plan slug:** `skyscraper-view`\n- **round:** 2')).toMatchObject({ plan: 'skyscraper-view', round: 2 })
})

test('review and fix rounds sit under a review node in order, and stay after they finish', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [],
    spawns: {
      r2: { type: 'pod:reviewer', description: 'Review again', plan: 'long-runs', round: 2, startedAt: 3 },
      r1: { type: 'pod:reviewer', description: 'Review plan', plan: 'long-runs', startedAt: 1 },
      f1: { type: 'pod:engineer', description: 'Review fixes', branch: 'long-runs-fix', startedAt: 2 },
      old: { type: 'pod:reviewer', description: 'Review other plan', plan: 'other', startedAt: 0 },
    },
    live: [
      { id: 'r1', type: 'pod:reviewer', status: 'completed' },
      { id: 'r2', type: 'pod:reviewer', status: 'running' },
    ],
  })
  const review = lines.slice(lines.findIndex(l => l.kind === 'review'))
  expect(review.map(l => `${l.depth} ${l.text} ${l.status}`)).toEqual([
    '1 review running',
    '2 round 1 done',
    '2 fix pass done',
    '2 round 2 running',
  ])
  expect(lines.some(l => l.kind === 'agent')).toBe(false)
  expect(summarize(lines)).toContain('1 running')
})

test('a wave fix sits under its own wave, not as a loose agent or a slice', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { w: { type: 'pod:engineer', description: 'Fix wave 1', sprint: 'ui', slice: 'B1', branch: 'ui-w1-fix' } },
    live: [{ id: 'w', type: 'pod:engineer', status: 'running' }],
  })
  const at = lines.findIndex(l => l.kind === 'round')
  expect(lines[at]).toMatchObject({ depth: 3, text: 'wave fix', status: 'running', sprint: 'ui' })
  expect(lines.slice(0, at).filter(l => l.kind === 'wave').at(-1)).toMatchObject({ text: 'wave 1', status: 'running' })
  expect(lines.find(l => l.text.startsWith('B1'))?.status).not.toBe('running')
  expect(lines.some(l => l.kind === 'review' || l.kind === 'agent')).toBe(false)
})

test('a blocked status wins over a merged PR cell, so the wave does not count it done', () => {
  const doc = parseSprint(SPRINT.replace('| merged | done | high |', '| merged | blocked | high |'), true)!
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [doc], spawns: {}, live: [] })
  expect(lines.find(l => l.text.startsWith('A1'))?.status).toBe('blocked')
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 1')?.note).toBe('1/2')
})

test('a sprint counts its blocked slices for its folded row', () => {
  const doc = parseSprint(SPRINT.replace('| merged | done | high |', '| merged | blocked | high |'), true)!
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [doc], spawns: {}, live: [] })
  expect(lines.find(l => l.kind === 'sprint' && l.text === 'ui')?.blockedCount).toBe(1)
  expect(lines.find(l => l.kind === 'sprint' && l.text === 'core')?.blockedCount).toBeUndefined()
})

test('formatTokens keeps a count to a few characters', () => {
  expect([950, 9_940, 410_400, 1_240_000].map(formatTokens)).toEqual(['950', '9.9k', '410k', '1.2M'])
})

test('turnTokens leaves cache reads out', () => {
  expect(turnTokens({ input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 90_000 })).toBe(3210)
})

test('tokens roll up to the sprint, the review and the plan, not the wave', () => {
  const ui = parseSprint(SPRINT, false)!
  const spawns = {
    a1: { type: 'pod:engineer', description: 'A1', sprint: 'ui', slice: 'A1' },
    a2: { type: 'pod:engineer', description: 'A2 detail screen' },
    b1: { type: 'pod:engineer', description: 'B1', sprint: 'ui', slice: 'B1' },
    fix: { type: 'pod:engineer', description: 'Fix wave 1', branch: 'ui-w1-fix' },
    rev: { type: 'pod:reviewer', description: 'Review plan', plan: 'long-runs' },
    plan: { type: 'pod:sprint-planner', description: 'Draft sprint' },
  }
  const tokens = { a1: 100_000, a2: 50_000, b1: 20_000, fix: 5_000, rev: 90_000, plan: 1_000 }
  const totals = tokenTotals(spawns, tokens, [ui], 'long-runs')
  expect(totals.sprints.get('ui')).toBe(175_000)
  expect(totals.review).toBe(90_000)
  expect(totals.plan).toBe(266_000)

  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [ui], spawns, live: [], tokens })
  expect(lines[0]?.note).toBe('266k tokens')
  expect(lines.find(l => l.kind === 'wave' && l.text === 'wave 1')?.note).toBeUndefined()
  expect(lines.find(l => l.kind === 'sprint' && l.text === 'ui')?.note).toBe('175k tokens · Build the screens')
  expect(lines.find(l => l.kind === 'review')?.note).toBe('90k tokens')
  expect(lines.find(l => l.kind === 'sprint' && l.text === 'core')?.note).toBe('Build the core')
})

test('a halt is not counted as one more blocked row', () => {
  const doc = parseSprint(SPRINT.replace('| merged | done | high |', '| merged | blocked | high |'), true)!
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [doc], spawns: {}, live: [], halt: 'Gate 4: wave check failed' })
  expect(lines.some(l => l.kind === 'halt' && l.status === 'blocked')).toBe(true)
  expect(summarize(lines)).toMatch(/ · 1 blocked · halted$/)
})

test('long goals and titles are kept whole, and cut only by the pane width', () => {
  const title = 'Perft harness plus start-position node counts at depth one to three'
  const doc = parseSprint(SPRINT.replace('List screen', title), false)!
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [doc], spawns: {}, live: [] })
  const slice = lines.find(l => l.text.startsWith('A1'))!
  expect(slice.text).toBe(`A1 ${title}`)
  expect(fit(slice.text, slice.note, 120)).toBe(`A1 ${title}  high`)
  expect(fit(slice.text, slice.note, 40)).toMatch(/…  high$/)
})

test('a final PR URL reads as its number, with a merge line of its own', () => {
  const done = parsePlan(PLAN.replace('| ui | Build the screens | active |', '| ui | Build the screens | done |').replace('planned', 'done'), 'long-runs')
  const halt = 'plan long-runs complete — final PR https://github.com/me/app/pull/58, review pass, 1 open entries sorted in the hand-back'
  const lines = buildTree({ plan: done, sprints: [], spawns: {}, live: [], halt })
  expect(lines.find(l => l.kind === 'halt')?.note).toBe('plan long-runs complete — final PR #58, review pass, 1 open entries sorted in the hand-back')
  expect(lines.at(-1)).toMatchObject({ depth: 2, kind: 'hint', text: 'merge PR #58' })
  expect([...milestones(lines).values()].at(-1)).toBe('◐ WAITING · merge PR #58 · plan long-runs complete — final PR #58, review pass, 1 open entries sorted in the hand-back')
})

test('snapshot is a little tree: finished sprints as a count, then only what runs, is blocked or waits on you', () => {
  const coreDoc = SPRINT.replace('Slug: ui', 'Slug: core').replace('| merged | done | high |', '| merged | blocked | high |')
  const core = parseSprint(coreDoc, true)!
  const ui = parseSprint(SPRINT, false)!
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [core, ui],
    spawns: {
      b1: { type: 'pod:engineer', description: 'B1', sprint: 'ui', slice: 'B1', startedAt: 0 },
      r1: { type: 'pod:reviewer', description: 'Review plan', plan: 'long-runs', startedAt: 1 },
    },
    live: [{ id: 'b1', type: 'pod:engineer', status: 'running' }],
    now: 4 * 60_000,
    lastSeen: { b1: 4 * 60_000 },
    tokens: { b1: 140_000 },
    halt: 'Gate 4: wave check failed',
  })
  expect(snapshot(lines).split('\n')).toEqual([
    'Long runs · sprint 2/3 · wave 2/2 · 1 running · 1 blocked · 140k tokens',
    '✓ 1 sprint done',
    '✓ core',
    '└─ ✗ wave 1 · A1 blocked',
    '● ui',
    '└─ ● wave 2 · B1 Search box 4m',
    '○ polish',
    '✓ review · 1 round',
  ])
})

test('snapshot ends with the halt and what to do', () => {
  const lines = buildTree({ plan: parsePlan(PLAN, 'long-runs'), sprints: [], spawns: {}, live: [], halt: 'Gate 4: wave check failed', haltType: 'BLOCKED' })
  expect(snapshot(lines).split('\n').slice(-2)).toEqual(['✗ halted  Gate 4: wave check failed', '└─ ➜ fix it first, then /pod:autopilot to resume'])
})

test('an agent waiting on its own background work still runs its slice and holds back a halt', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { b1: { type: 'pod:engineer', description: 'B1', sprint: 'ui', slice: 'B1' } },
    live: [{ id: 'b1', type: 'pod:engineer', status: 'waiting' }],
    halt: 'Gate 4: wave check failed',
  })
  expect(lines.find(l => l.text.startsWith('B1'))?.status).toBe('running')
  expect(lines.some(l => l.kind === 'halt')).toBe(false)
  expect(summarize(lines)).toContain('1 running')
  const ended = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [parseSprint(SPRINT, false)!],
    spawns: { b1: { type: 'pod:engineer', description: 'B1', sprint: 'ui', slice: 'B1' } },
    live: [{ id: 'b1', type: 'pod:engineer', status: 'completed' }],
  })
  expect(ended.find(l => l.text.startsWith('B1'))?.status).toBe('waiting')
})

test('a BLOCKED gate-2 halt naming the final PR is a halt, not a hand-back', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [],
    spawns: {},
    live: [],
    halt: 'Gate 2 plan-review-fail: final PR https://github.com/me/app/pull/58 still has FIX findings',
    haltType: 'BLOCKED',
  })
  expect(lines.find(l => l.kind === 'halt')).toMatchObject({ text: 'halted', status: 'blocked' })
  expect(lines.some(l => l.kind === 'hint' && l.text === 'fix it first')).toBe(true)
  expect(lines.some(l => l.text === 'merge PR #58')).toBe(false)
})

test('a plan-complete entry with review still failing is a halt with no merge line', () => {
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [],
    spawns: {},
    live: [],
    halt: 'plan long-runs complete — final PR https://github.com/me/app/pull/58, review still failing, 2 open entries sorted in the hand-back',
    haltType: 'PENDING',
  })
  expect(lines.find(l => l.kind === 'halt')).toMatchObject({ text: 'halted' })
  expect(lines.some(l => l.text === 'merge PR #58')).toBe(false)
})

test('the same slice code in two sprints runs only in the sprint its agent works for', () => {
  const open = (doc: string) => doc.replace('| merged | done | high |', '| — | pending | — |').replace('| merged | done | medium |', '| — | pending | — |')
  const core = parseSprint(open(SPRINT.replace('Slug: ui', 'Slug: core')), false)!
  const ui = parseSprint(open(SPRINT), false)!
  const lines = buildTree({
    plan: parsePlan(PLAN, 'long-runs'),
    sprints: [core, ui],
    spawns: { a1: { type: 'pod:engineer', description: 'A1', sprint: 'ui', slice: 'A1' } },
    live: [{ id: 'a1', type: 'pod:engineer', status: 'running' }],
  })
  const sliceIn = (sprint: string) => lines.find(l => l.kind === 'slice' && l.sprint === sprint && l.text.startsWith('A1 '))
  expect(sliceIn('ui')).toMatchObject({ status: 'running' })
  expect(sliceIn('core')?.status).not.toBe('running')
})

test('parseDispatch reads the branch name, not the merge-target branch', () => {
  expect(parseDispatch('- **merge-target branch:** main\n- **branch name:** ui-A1').branch).toBe('ui-A1')
  expect(parseDispatch('merge-target: long-runs\nbranch: ui-A1').branch).toBe('ui-A1')
  expect(parseDispatch('plan branch: long-runs\n- branch: long-runs-fix').branch).toBe('long-runs-fix')
})

test('a sprint doc links its plan from pod-docs/ or, before the move, docs/', () => {
  const head = (dir: string) => `_From plan: ${dir}/plans/demo.md · Slug: one · Status: active_\n`
  expect(parseSprint(head('pod-docs'), false)?.plan).toBe('demo')
  expect(parseSprint(head('docs'), false)?.plan).toBe('demo')
})

// Added in openaflow (not in the claude-pod source): rows copied from chess-web's ladder sprint board.
const CHESS_WEB_LADDER = `# Sprint: Sparring ladder to Liem

_From plan: pod-docs/plans/sparring-ladder.md · Slug: ladder · Status: active · Generated: 2026-10-18_
<!-- autopilot-run: started=2026-10-18T10:31:18Z sprints=1 waves=3 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | L1 | Look: sparring avatar style and token checks | ladder-L1 | #76 | merged | medium | — |
| 2 | M1 | \`npm run calibrate -- --measure\`: self-play from his book, graded | ladder-M1 | #77 | merged | high | H1, C1 |

## Shared contract
`

test('parseSprint reads a real chess-web board row', () => {
  const sprint = parseSprint(CHESS_WEB_LADDER, true)
  expect(sprint?.slug).toBe('ladder')
  expect(sprint?.plan).toBe('sparring-ladder')
  expect(sprint?.rows[0]).toEqual({
    wave: 1,
    slice: 'L1',
    title: 'Look: sparring avatar style and token checks',
    branch: 'ladder-L1',
    pr: '#76',
    status: 'merged',
    confidence: 'medium',
  })
  expect(sprint?.rows[1]?.title).toBe('`npm run calibrate -- --measure`: self-play from his book, graded')
  expect(sprint?.rows[1]?.pr).toBe('#77')
})
