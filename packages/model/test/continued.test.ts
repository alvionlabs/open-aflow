import { describe, expect, test } from 'vitest'

import { buildFixPipeline, buildPipeline, listRuns, parseAgentTranscript, type AgentRun, type BoardRepo } from '../src/index.ts'
import { CONTINUED_ENGINEER, CONTINUED_REVIEWER, jsonlAt } from './continued-agents.ts'
import { loadFixture } from './load-fixture.ts'
import { buildRepoModel } from '../src/run-model.ts'

// openaflow's real /pod:fix run fix-show-fix-runs: the engineer built (17:25–18:08), the reviewer ran
// round 1 (18:10–18:19), the same engineer was continued for the fix pass (18:19–18:54), and the same
// reviewer was continued for round 2 (18:55–19:02). Each step reads the transcripts as they stood then.

const agentAt = (id: string, type: string, recs: typeof CONTINUED_ENGINEER, at: string): AgentRun | undefined =>
  parseAgentTranscript({ id, session: 's', meta: JSON.stringify({ agentType: type }), jsonl: jsonlAt(recs, at) })

function fixRepoAt(at: string): BoardRepo {
  const agents = [agentAt('eng', 'pod:engineer', CONTINUED_ENGINEER, at), agentAt('rev', 'pod:reviewer', CONTINUED_REVIEWER, at)].filter(
    (a): a is AgentRun => a !== undefined && a.startedAt !== undefined,
  )
  return {
    id: 'pb',
    name: 'openaflow',
    path: '/r/openaflow',
    source: 'claim',
    model: buildRepoModel({ 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n' }),
    agents,
    prs: [{ number: 23, state: 'open', checks: 'pass', checkedAt: 0, branch: 'fix-show-fix-runs' }],
    claims: [{ portBase: 3500, repoPath: '/r/openaflow', plan: 'fix-show-fix-runs' }],
  }
}

const rowAt = (at: string) => listRuns({ generatedAt: 0, gh: 'ok', repos: [fixRepoAt(at)] }, Date.parse(at)).map((r) => [r.where, r.state])
const pipeAt = (at: string) => buildFixPipeline(fixRepoAt(at), 'fix-show-fix-runs', Date.parse(at))!
const stepsAt = (at: string) => pipeAt(at).stages.flatMap((s) => s.steps.map((x) => [x.label, x.state]))
const shipAt = (at: string) => pipeAt(at).stages[2]!.steps[0]!.detail

describe('continued agents in a real fix run', () => {
  test('the transcripts read as continued: two turns each, ended only after the last hand-back', () => {
    const eng = agentAt('eng', 'pod:engineer', CONTINUED_ENGINEER, '2026-10-20T18:30:00Z')!
    expect(eng.ended).toBe(false)
    expect(eng.resumedAt).toBe(Date.parse('2026-10-20T18:19:37.869Z'))
    expect(eng.turns?.map((t) => [new Date(t.startedAt).toISOString(), t.endedAt && new Date(t.endedAt).toISOString()])).toEqual([
      ['2026-10-20T17:25:53.517Z', '2026-10-20T18:08:49.831Z'],
      ['2026-10-20T18:19:37.869Z', undefined],
    ])
    const rev = agentAt('rev', 'pod:reviewer', CONTINUED_REVIEWER, '2026-10-20T19:05:00Z')!
    expect(rev.ended).toBe(true)
    expect(rev.turns).toHaveLength(2)
  })

  test('round 1 running, then the engineer continued for the fix pass reads fix pass · running', () => {
    expect(rowAt('2026-10-20T18:15:00Z')).toEqual([['review', 'running']])
    expect(rowAt('2026-10-20T18:30:00Z')).toEqual([['fix pass', 'running']])
    expect(stepsAt('2026-10-20T18:30:00Z')).toEqual([
      ['Engineer', 'done'],
      ['Fix pass', 'live'],
      ['Round 1', 'done'],
      ['Round 2', 'wait'],
      ['PR', 'wait'],
    ])
    expect(pipeAt('2026-10-20T18:30:00Z').log.map((x) => [x.agentId, x.role, x.round, x.state])).toEqual([
      ['eng', 'engineer', undefined, 'ended'],
      ['rev', 'reviewer', 1, 'ended'],
      ['eng', 'fix pass', undefined, 'running'],
    ])
  })

  test('once the fix pass hands back: review · idle, Ship after review', () => {
    expect(rowAt('2026-10-20T18:54:40Z')).toEqual([['review', 'idle']])
    expect(shipAt('2026-10-20T18:54:40Z')).toBe('PR #23 · after review')
  })

  test('the reviewer continued for round 2 is not needs-you until it hands back again', () => {
    expect(rowAt('2026-10-20T18:58:00Z')).toEqual([['review round 2', 'running']])
    expect(stepsAt('2026-10-20T18:58:00Z')).toEqual([
      ['Engineer', 'done'],
      ['Fix pass', 'done'],
      ['Round 1', 'done'],
      ['Round 2', 'live'],
      ['PR', 'wait'],
    ])
    expect(shipAt('2026-10-20T18:58:00Z')).toBe('PR #23 · after review')
    // Round 1 keeps its own time: 18:10:36 to 18:19:26, not folded into round 2.
    expect(pipeAt('2026-10-20T18:58:00Z').stages[1]!.steps[0]!.detail).toMatch(/^9 min/)

    expect(rowAt('2026-10-20T19:05:00Z')).toEqual([['PR', 'needs-you']])
    expect(shipAt('2026-10-20T19:05:00Z')).toBe('PR #23 · you merge')
    expect(pipeAt('2026-10-20T19:05:00Z').log.map((x) => [x.role, x.round, x.state])).toEqual([
      ['engineer', undefined, 'ended'],
      ['reviewer', 1, 'ended'],
      ['fix pass', undefined, 'ended'],
      ['reviewer', 2, 'ended'],
    ])
  })
})

test('the engineer resumed again after round 2 is a second fix pass: fix pass · running, 2 passes', () => {
  expect(rowAt('2026-10-20T23:38:00Z')).toEqual([['fix pass', 'running']])
  const fixPass = pipeAt('2026-10-20T23:38:00Z').stages[0]!.steps[1]!
  // 18:19:37–18:54:19 plus 23:37:19–23:38:00: each turn's own active time, not the idle hours between them.
  expect([fixPass.state, fixPass.detail]).toEqual(['live', '2 passes · 35 min so far'])
  expect(shipAt('2026-10-20T23:38:00Z')).toBe('PR #23 · after review')
})

describe('a continued plan engineer', () => {
  test('reads running on its slice again while it works, and not once it hands back', () => {
    // The real engineer shape, dispatched to chess-web's pending ladder slice T1.
    const recs = CONTINUED_ENGINEER.map((r, i) =>
      i === 0 ? { ...r, message: { ...r.message, content: '- sprint slug: ladder\n- slice code: T1\n- branch name: ladder-T1' } } : r,
    )
    const repoAt = (at: string): BoardRepo => ({
      id: 'cw',
      name: 'chess-web',
      path: '/r/chess-web',
      source: 'registered',
      model: buildRepoModel(loadFixture('chess-web')),
      agents: [agentAt('eng', 'pod:engineer', recs, at)!],
      prs: [],
      claims: [],
    })
    const t1At = (at: string) =>
      buildPipeline(repoAt(at), 'sparring-ladder', Date.parse(at))!
        .log.flatMap((g) => g.rows)
        .find((r) => r.code === 'T1')!.live
    expect(t1At('2026-10-20T18:30:00Z')).toBe(true)
    expect(t1At('2026-10-20T18:54:40Z')).toBe(false)
  })
})
