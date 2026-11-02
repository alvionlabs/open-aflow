import { describe, expect, it } from 'vitest'
import { STALE_MS, agentState, parseAgentTranscript } from './transcript.ts'
import type { AgentRun } from './board.ts'

// Transcripts are built inline in the shape the shared contract describes:
// test/no-io.test.ts scans this folder, so no file reads here.

type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
type Block = Record<string, unknown>

const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
})

const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

const user = (minutes: number, content: string | Block[]) => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content } })

function assistant(
  minutes: number,
  id: string,
  opts: { usage?: Usage; stop?: string | null; model?: string; content?: Block[] } = {},
) {
  return {
    type: 'assistant',
    timestamp: at(minutes),
    message: {
      id,
      role: 'assistant',
      model: opts.model ?? 'claude-opus-5-5',
      stop_reason: opts.stop ?? null,
      usage: opts.usage ?? usage(1, 1),
      content: opts.content ?? [{ type: 'text', text: 'working' }],
    },
  }
}

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const meta = (agentType: string, description = 'Build M1') => JSON.stringify({ agentType, description })

const PROMPT = [
  'Dispatched by /pod:autopilot (wave 1 of 3, sprint server-runs, plan board-read).',
  '',
  '- **sprint slug:** server-runs',
  '- **slice code:** M1',
  '- **branch name:** server-runs-M1 (cut from origin/board-read)',
  '- **merge-target branch:** board-read',
].join('\n')

const parse = (m: string, lines: string) => parseAgentTranscript({ id: 'a1', session: 's1', meta: m, jsonl: lines })

describe('parseAgentTranscript', () => {
  it('reads an engineer transcript', () => {
    const run = parse(
      meta('pod:engineer', 'Build M1: board types and transcript parser'),
      jsonl(
        user(0, PROMPT),
        assistant(1, 'm1', { model: 'claude-sonnet-5-5' }),
        user(2, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
        assistant(5, 'm2', { model: 'claude-opus-5-5' }),
      ),
    )
    expect(run).toMatchObject({
      id: 'a1',
      session: 's1',
      type: 'pod:engineer',
      sprint: 'server-runs',
      slice: 'M1',
      branch: 'server-runs-M1',
      model: 'claude-opus-5-5',
      startedAt: T0,
      lastAt: T0 + 5 * 60_000,
      ended: false,
    })
    expect(run).not.toHaveProperty('plan')
    expect(run).not.toHaveProperty('round')
  })

  it('reads the prompt from the first text block, and a reviewer plan and round', () => {
    const prompt = '- **plan slug:** board-read\n- **round:** 2\n'
    const run = parse(
      meta('pod:reviewer', 'Review board-read'),
      jsonl(user(0, [{ type: 'image', source: {} }, { type: 'text', text: prompt }]), assistant(1, 'm1')),
    )
    expect(run).toMatchObject({ type: 'pod:reviewer', plan: 'board-read', round: 2 })
    expect(run).not.toHaveProperty('sprint')
  })

  it('takes dispatch fields from the first user record only', () => {
    const run = parse(
      meta('pod:engineer'),
      jsonl(user(0, 'no fields here'), assistant(1, 'm1'), user(2, '- **slice code:** Z9')),
    )
    expect(run).not.toHaveProperty('slice')
  })

  it('never carries the meta file description', () => {
    const secret = `desc-${Math.random().toString(36).slice(2)}`
    const run = parse(meta('pod:engineer', secret), jsonl(user(0, PROMPT)))
    expect(run).toBeDefined()
    expect(run).not.toHaveProperty('description')
    expect(JSON.stringify(run)).not.toContain(secret)
  })

  it('tokens count each message once', () => {
    const run = parse(
      meta('pod:engineer'),
      jsonl(
        user(0, PROMPT),
        // One message streamed over three records: its usage counts once, from its last record.
        assistant(1, 'm1', { usage: usage(10, 1, 100, 5000) }),
        assistant(1, 'm1', { usage: usage(10, 1, 100, 5000) }),
        assistant(1, 'm1', { usage: usage(10, 20, 100, 5000), stop: 'tool_use' }),
        assistant(2, 'm2', { usage: usage(3, 4, 0, 9999) }),
      ),
    )
    // m1: 10 + 20 + 100; m2: 3 + 4. Cache reads are left out.
    expect(run?.tokens).toBe(130 + 7)
  })

  it('ended rules', () => {
    const handback = parse(
      meta('pod:engineer'),
      jsonl(
        user(0, PROMPT),
        assistant(1, 'm1', { content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: 'done' } }] }),
        // A streamed copy after the hand-back, still mid-turn: the hand-back alone ends it.
        assistant(1, 'm1', { stop: null }),
      ),
    )
    expect(handback?.ended).toBe(true)

    const endTurn = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), assistant(1, 'm1', { stop: 'tool_use' }), assistant(2, 'm2', { stop: 'end_turn' })))
    expect(endTurn?.ended).toBe(true)

    // end_turn earlier, then more work: only the last assistant record counts.
    const midTurn = parse(
      meta('pod:engineer'),
      jsonl(user(0, PROMPT), assistant(1, 'm1', { stop: 'end_turn' }), user(2, 'go on'), assistant(3, 'm2', { stop: 'tool_use' })),
    )
    expect(midTurn?.ended).toBe(false)

    const otherTool = parse(
      meta('pod:engineer'),
      jsonl(user(0, PROMPT), assistant(1, 'm1', { stop: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] })),
    )
    expect(otherTool?.ended).toBe(false)
  })

  it('tolerates bad transcripts', () => {
    expect(parse(meta('general-purpose'), jsonl(user(0, PROMPT)))).toBeUndefined()
    expect(parse(meta('Explore'), jsonl(user(0, PROMPT)))).toBeUndefined()
    expect(parse('{not json', jsonl(user(0, PROMPT)))).toBeUndefined()
    expect(parse('', jsonl(user(0, PROMPT)))).toBeUndefined()
    expect(parse('null', jsonl(user(0, PROMPT)))).toBeUndefined()
    expect(parse('[]', jsonl(user(0, PROMPT)))).toBeUndefined()
    expect(parse(JSON.stringify({ agentType: 7 }), jsonl(user(0, PROMPT)))).toBeUndefined()

    // Empty text: a run with nothing known yet.
    const empty = parse(meta('pod:engineer'), '')
    expect(empty).toEqual({ id: 'a1', session: 's1', type: 'pod:engineer', tokens: 0, ended: false })

    // Bad lines, records missing fields, odd values, and a partial last line are skipped.
    const lines = [
      'not json at all',
      '42',
      'null',
      '"a string"',
      JSON.stringify({ type: 'user' }),
      JSON.stringify({ type: 'user', timestamp: 'yesterday', message: { content: 7 } }),
      JSON.stringify(user(0, PROMPT)),
      JSON.stringify({ type: 'assistant', timestamp: at(1) }),
      JSON.stringify({ type: 'assistant', timestamp: at(2), message: { id: 'm1', usage: { input_tokens: 'many' }, content: 'oops' } }),
      JSON.stringify({ type: 'assistant', timestamp: at(3), message: { usage: usage(1000, 1000) } }),
      JSON.stringify(assistant(4, 'm2', { usage: usage(5, 5) })),
      JSON.stringify(assistant(9, 'm3', { usage: usage(7, 7) })).slice(0, 40),
    ].join('\r\n')
    const run = parse(meta('pod:engineer'), lines)
    expect(run).toMatchObject({ slice: 'M1', startedAt: T0, lastAt: T0 + 4 * 60_000, tokens: 10, model: 'claude-opus-5-5', ended: false })
  })

  it('never keeps transcript text', () => {
    const SECRET = 'sk-FAKE-planted-secret-0000'
    const run = parse(
      meta('pod:engineer'),
      jsonl(
        user(0, PROMPT),
        assistant(1, 'm1', { content: [{ type: 'text', text: `here is ${SECRET}` }] }),
        assistant(2, 'm2', { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${SECRET}` } }] }),
        user(3, [{ type: 'tool_result', tool_use_id: 't1', content: SECRET }]),
        user(4, [{ type: 'text', text: SECRET }]),
        assistant(5, 'm3', { stop: 'end_turn', content: [{ type: 'text', text: SECRET }] }),
      ),
    )
    expect(run).toBeDefined()
    expect(JSON.stringify(run)).not.toContain('planted')
  })
})

describe('agentState', () => {
  const run = (patch: Partial<AgentRun>): AgentRun => ({ id: 'a', session: 's', type: 'pod:engineer', tokens: 0, ended: false, ...patch })
  const now = T0 + 60 * 60_000

  it('agentState edges', () => {
    expect(STALE_MS).toBe(30 * 60_000)
    expect(agentState(run({ ended: true, lastAt: now }), now)).toBe('ended')
    expect(agentState(run({ ended: true }), now)).toBe('ended')
    expect(agentState(run({ lastAt: now - 29 * 60_000 }), now)).toBe('running')
    expect(agentState(run({ lastAt: now - STALE_MS + 1 }), now)).toBe('running')
    expect(agentState(run({ lastAt: now - 30 * 60_000 }), now)).toBe('stale')
    expect(agentState(run({}), now)).toBe('stale')
    // A clock running behind the transcript still reads as running.
    expect(agentState(run({ lastAt: now + 5000 }), now)).toBe('running')
  })
})

describe('continued agents (SendMessage after a hand-back)', () => {
  const handback = (minutes: number, id: string) =>
    assistant(minutes, id, { content: [{ type: 'tool_use', id: `t-${id}`, name: 'SubagentHandback', input: { message: 'SECRET-HANDBACK' } }] })
  const toolResult = (minutes: number) => user(minutes, [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET-RESULT' }])
  // A resume prompt as the runtime writes it: a meta user record from the coordinator.
  const resume = (minutes: number) => ({ ...user(minutes, 'SECRET-RESUME'), isMeta: true, origin: { kind: 'coordinator' } })

  it('a resumed agent is running again until it hands back again', () => {
    const working = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), assistant(1, 'm1'), handback(5, 'm2'), toolResult(5), resume(10), assistant(12, 'm3')))
    expect(working?.ended).toBe(false)
    expect(working?.resumedAt).toBe(Date.parse(at(10)))
    expect(working?.turns).toEqual([
      { startedAt: Date.parse(at(0)), endedAt: Date.parse(at(5)), lastAt: Date.parse(at(5)), tokens: 4 },
      { startedAt: Date.parse(at(10)), lastAt: Date.parse(at(12)), tokens: 2 },
    ])
    expect(agentState(working!, Date.parse(at(13)))).toBe('running')

    const done = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), assistant(1, 'm1'), handback(5, 'm2'), toolResult(5), resume(10), assistant(12, 'm3'), handback(15, 'm4')))
    expect(done?.ended).toBe(true)
    expect(done?.turns?.[1]).toEqual({ startedAt: Date.parse(at(10)), endedAt: Date.parse(at(15)), lastAt: Date.parse(at(15)), tokens: 4 })
  })

  it('an end_turn ends a turn too, and a trailing end_turn after the hand-back stays in that turn', () => {
    const r = parse(meta('pod:reviewer'), jsonl(user(0, PROMPT), handback(5, 'm1'), toolResult(5), assistant(6, 'm2', { stop: 'end_turn' }), resume(10), assistant(11, 'm3')))
    expect(r?.ended).toBe(false)
    expect(r?.turns?.map((t) => [t.startedAt, t.endedAt, t.lastAt])).toEqual([
      [Date.parse(at(0)), Date.parse(at(5)), Date.parse(at(6))],
      [Date.parse(at(10)), undefined, Date.parse(at(11))],
    ])
  })

  it('a task notification or a nudge after the hand-back re-opens the same turn: working again, but no new turn', () => {
    const notice = (minutes: number) => ({ ...user(minutes, 'SECRET-NOTICE'), isMeta: true, origin: { kind: 'task-notification' } })
    const nudge = (minutes: number) => ({ ...user(minutes, 'SECRET-NUDGE'), isMeta: true })
    const working = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), handback(5, 'm1'), toolResult(5), notice(6), assistant(7, 'm2')))
    expect(working?.ended).toBe(false)
    expect(working).not.toHaveProperty('turns')
    const again = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), assistant(4, 'm1', { stop: 'end_turn' }), nudge(4), handback(5, 'm2')))
    expect(again?.ended).toBe(true)
    expect(again).not.toHaveProperty('turns')
    // With a real resume later, the notice stays in turn 1, which ends at its last hand-back.
    const later = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), handback(5, 'm1'), notice(6), handback(7, 'm2'), resume(10), assistant(11, 'm3')))
    expect(later?.turns?.map((t) => [t.startedAt, t.endedAt])).toEqual([
      [Date.parse(at(0)), Date.parse(at(7))],
      [Date.parse(at(10)), undefined],
    ])
  })

  it('a meta prompt beside the first one, and tool results, start no turn; an agent never resumed has no turns', () => {
    const r = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), { ...user(0, 'reminder'), isMeta: true }, assistant(1, 'm1'), toolResult(2), handback(3, 'm2'), toolResult(3)))
    expect(r?.ended).toBe(true)
    expect(r).not.toHaveProperty('turns')
    expect(r).not.toHaveProperty('resumedAt')
  })

  it('dispatch fields still come from the first prompt only, not a resume', () => {
    const r = parse(meta('pod:reviewer'), jsonl(user(0, '- kind: fix\n- round: 1'), handback(5, 'm1'), { ...user(10, '- round: 2\n- kind: plan'), isMeta: true }, assistant(11, 'm2')))
    expect(r).toMatchObject({ kind: 'fix', round: 1 })
  })

  it('keeps no text from a resume, a hand-back, or a tool result', () => {
    const r = parse(meta('pod:engineer'), jsonl(user(0, PROMPT), handback(5, 'm1'), toolResult(5), resume(10), assistant(11, 'm2')))
    expect(JSON.stringify(r)).not.toMatch(/SECRET/)
  })
})
