import { describe, expect, it } from 'vitest'
import type { BoardRepo, PrStatus } from './board.ts'
import { parseQueue } from './pod-flow/model.ts'
import { closeText, doneReason, keepText, triage, valueInUse, withResolution } from './queue-triage.ts'
import { buildRepoModel, type QueueItem } from './run-model.ts'

const README = '# pod docs\n\npod docs: 2\n'

const plan = (slug: string, status: string, sprints: [string, string][]) =>
  [
    `# Plan: ${slug}`,
    '',
    `_Generated: 2026-10-21 · Status: ${status} · Grilled-with: grilling_`,
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, st]) => `| ${s} | goal | ${st} | — |`),
    '',
  ].join('\n')

const sprintDoc = (slug: string, from: string) =>
  [`# Sprint: ${slug}`, '', `_From plan: pod-docs/plans/${from}.md · Slug: ${slug} · Status: active_`, ''].join('\n')

// `old` is archived; `live` is active with sprint `first` archived (done) and `second` active.
const GATE_OLD = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 1 (blocked-concern): A1 cannot pass verify. **Resolution:** pending'
const GATE4_OLD = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 4 (wave-check-failed): wave 2 smoke failed. **Resolution:** pending'
const GATE5_OLD = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 5 (safety-bounded): token cap hit. **Resolution:** pending'
const GATE3_WAVE_OLD = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 3 (merge-failed): wave 2 PR #12 has conflicts. **Resolution:** pending'
const GATE3_FINAL_OLD = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 3 (merge-failed): the final PR #20 has conflicts. **Resolution:** pending'
const GATE2_OLD = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 2 (plan-review-fail): the final PR still has a FIX. **Resolution:** pending'
const HANDBACK_OLD = '- `[2026-10-20 · PENDING · orchestrator → human · plan: old]` plan old complete — final PR https://github.com/x/r/pull/20, review pass, 2 open entries sorted in the hand-back. **Resolution:** pending'
const GATE7_OLD =
  '- `[2026-10-20 · PENDING · orchestrator → human · plan: old]` gate 7 (plan-complete): plan old merged to `pod-staging` (final PR https://github.com/x/r/pull/20); review it and merge the staging PR https://github.com/x/r/pull/21 to `main` when ready. **Resolution:** pending'
const GATE_LIVE = '- `[2026-10-21 · BLOCKED · orchestrator → human · plan: live · sprint: second]` gate 1 (blocked-concern): B1 is stuck. **Resolution:** pending'
const GATE_LIVE_DONE_SPRINT = '- `[2026-10-21 · BLOCKED · orchestrator → human · plan: live · sprint: first]` gate 4 (wave-check-failed): wave 1 failed. **Resolution:** pending'
const GATE5_LIVE_DONE_SPRINT = '- `[2026-10-21 · BLOCKED · orchestrator → human · plan: live · sprint: first]` gate 5 (safety-bounded): cap hit. **Resolution:** pending'
const DECISION =
  '- `[2026-10-21 · PENDING · engineer → human · plan: live]` decision: which colour for the badge? Value in use: white. Answer to change it. **Resolution:** pending'
const DONE_WITH_VALUE = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 1 (blocked-concern): A1 stuck. Value in use: skip A1. **Resolution:** pending'
const PLAIN = '- `[2026-10-21 · PENDING · engineer → human · plan: live]` someday: tidy the logs. **Resolution:** pending'
const ANSWERED_GATE = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 1 (blocked-concern): A1. **Resolution:** pending **Answer (human):** rerun'
const TO_POD = '- `[2026-10-20 · BLOCKED · engineer → orchestrator · plan: old]` gate 1 (blocked-concern): for pod. **Resolution:** pending'
const VALUE_TO_POD = '- `[2026-10-21 · PENDING · engineer → orchestrator · plan: live]` decision: x. Value in use: y. **Resolution:** pending'

const ALL = [
  GATE_OLD,
  GATE4_OLD,
  GATE5_OLD,
  GATE3_WAVE_OLD,
  GATE3_FINAL_OLD,
  GATE2_OLD,
  HANDBACK_OLD,
  GATE7_OLD,
  GATE_LIVE,
  GATE_LIVE_DONE_SPRINT,
  GATE5_LIVE_DONE_SPRINT,
  DECISION,
  DONE_WITH_VALUE,
  PLAIN,
  ANSWERED_GATE,
  TO_POD,
  VALUE_TO_POD,
]

function repo(prs: PrStatus[] = []): BoardRepo {
  const model = buildRepoModel({
    'pod-docs/README.md': README,
    'pod-docs/plans/archive/old.md': plan('old', 'archived', [['one', 'done']]),
    'pod-docs/plans/live.md': plan('live', 'active', [
      ['first', 'done'],
      ['second', 'active'],
    ]),
    'pod-docs/sprints/archive/first.md': sprintDoc('first', 'live'),
    'pod-docs/sprints/second.md': sprintDoc('second', 'live'),
    'pod-docs/handoff-queue.md': ['# Handoff Queue', '', ...ALL, ''].join('\n'),
  })
  return { id: 'id', name: 'r', path: '/r', source: 'registered', model, agents: [], prs, claims: [] }
}

const pr = (number: number, state: PrStatus['state']): PrStatus => ({ number, state, checks: 'none', checkedAt: 1 })
const entry = (r: BoardRepo, line: string): QueueItem => r.model.queue.find((e) => e.line === line.trim())!

describe('done entries', () => {
  it('a wave-time gate halt of an archived plan is done', () => {
    const r = repo()
    for (const line of [GATE_OLD, GATE4_OLD, GATE5_OLD, GATE3_WAVE_OLD]) expect(doneReason(r, entry(r, line)), line).toBe('plan old is archived')
  })

  it('a gate written at or after the plan archive is not done by the archive alone', () => {
    // pod archives a plan before its final review, merge and hand-back, so these come after the archive.
    const r = repo()
    for (const line of [GATE3_FINAL_OLD, GATE2_OLD, HANDBACK_OLD, GATE7_OLD]) expect(doneReason(r, entry(r, line)), line).toBeUndefined()
    // The final PR merged changes nothing for the hand-back: pod still waits for continue to clean up.
    const merged = repo([pr(20, 'merged')])
    expect(doneReason(merged, entry(merged, HANDBACK_OLD))).toBeUndefined()
  })

  it('a gate halt of a plan that is not archived is not done', () => {
    const r = repo()
    expect(doneReason(r, entry(r, GATE_LIVE))).toBeUndefined()
  })

  it('a wave-time gate halt of an archived sprint is done', () => {
    const r = repo()
    expect(doneReason(r, entry(r, GATE_LIVE_DONE_SPRINT))).toBe('sprint first is archived')
    // Gate 5 is checked after a sprint is archived, so it can be live on an archived sprint.
    expect(doneReason(r, entry(r, GATE5_LIVE_DONE_SPRINT))).toBeUndefined()
  })

  it('a gate 7 entry is done once gh says its staging PR merged', () => {
    expect(doneReason(repo(), entry(repo(), GATE7_OLD))).toBeUndefined()
    const open = repo([pr(20, 'merged'), pr(21, 'open')])
    expect(doneReason(open, entry(open, GATE7_OLD))).toBeUndefined()
    // The final PR (#20, the first URL) merging isn't the staging PR merging.
    const finalOnly = repo([pr(20, 'merged')])
    expect(doneReason(finalOnly, entry(finalOnly, GATE7_OLD))).toBeUndefined()
    const closed = repo([pr(21, 'closed')])
    expect(doneReason(closed, entry(closed, GATE7_OLD))).toBeUndefined()
    const merged = repo([pr(21, 'merged')])
    expect(doneReason(merged, entry(merged, GATE7_OLD))).toBe('staging PR #21 merged')
  })

  it('an entry that matches no rule is not done', () => {
    const r = repo([pr(21, 'merged')])
    for (const line of [DECISION, PLAIN]) expect(doneReason(r, entry(r, line)), line).toBeUndefined()
  })
})

describe('value in use', () => {
  it('reads the value up to the end of its sentence', () => {
    expect(valueInUse('decision: which colour? Value in use: white. Answer to change it.')).toBe('white')
    expect(valueInUse('Value in use: leave it (PR https://github.com/x/r/pull/3). Then more.')).toBe('leave it (PR https://github.com/x/r/pull/3)')
    expect(valueInUse('Value in use: "2732" on phones; change it in `src/features/levelView.tsx`.')).toBe('"2732" on phones; change it in src/features/levelView.tsx')
    expect(valueInUse('Value in use: keep it')).toBe('keep it')
    expect(valueInUse('Value in use: keep it! Then more.')).toBe('keep it')
  })

  it('reads lowercase and backticks', () => {
    expect(valueInUse('pick one. value in use: `flow only`. done')).toBe('flow only')
    expect(valueInUse('pick one. `Value in use`: **these**.')).toBe('these')
    expect(valueInUse('pick one. VALUE IN USE : the first.')).toBe('the first')
  })

  it('reads nothing without a value', () => {
    expect(valueInUse('pod goes on with the value in use until you answer.')).toBeUndefined()
    expect(valueInUse('Value in use: .')).toBeUndefined()
    expect(valueInUse('Value in use:')).toBeUndefined()
    expect(valueInUse('no value here')).toBeUndefined()
  })
})

describe('triage', () => {
  it('done wins over a value in use', () => {
    const r = repo()
    expect(triage(r, entry(r, DONE_WITH_VALUE))).toEqual({ done: 'plan old is archived' })
    expect(triage(r, entry(r, DECISION))).toEqual({ keep: 'white' })
    expect(triage(r, entry(r, PLAIN))).toEqual({})
  })

  it('only for entries you can answer', () => {
    const r = repo()
    // Answered, or routed to pod: nothing to close or keep.
    expect(triage(r, entry(r, ANSWERED_GATE))).toEqual({})
    expect(triage(r, entry(r, TO_POD))).toEqual({})
    expect(triage(r, entry(r, VALUE_TO_POD))).toEqual({})
  })
})

describe('the resolution', () => {
  it('replaces pending and keeps the rest of the line', () => {
    const line = DECISION.trim()
    const out = withResolution(line, keepText('2026-10-31', 'white'))
    expect(out).toBe(line.replace('**Resolution:** pending', '**Resolution:** 2026-10-31 — kept: white'))
    expect(parseQueue(out!)[0]!.isPending).toBe(false)
    expect(withResolution('- `[x · PENDING · a → human]` b **Resolution:** pending (sorted)', 'T')).toBe('- `[x · PENDING · a → human]` b **Resolution:** T (sorted)')
    expect(closeText('2026-10-31', 'plan old is archived')).toBe('2026-10-31 — closed from the board: plan old is archived')
  })

  it('reads nothing on a line that is not pending', () => {
    expect(withResolution('- `[x · PENDING · a → human]` b **Resolution:** 2026-10-20 — fixed', 'T')).toBeUndefined()
    expect(withResolution('- `[x · PENDING · a → human]` b', 'T')).toBeUndefined()
  })
})
