import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentTimeline, SliceModel, TestProgress } from '@openaflow/model'
import { clock, engineerDetails, lastActive, testsLine, timelineRows } from './view.ts'

const SEC = 1000
const MIN = 60 * SEC
// Local time, so HH:MM reads the same in every time zone.
const NOW = new Date(2026, 9, 19, 14, 30, 0).getTime()

describe('last active', () => {
  it('seconds under a minute, then minutes, then hours', () => {
    expect(lastActive(NOW - 59 * SEC, NOW, false)).toBe('59 s ago')
    expect(lastActive(NOW - 60 * SEC, NOW, false)).toBe('1 min ago')
    expect(lastActive(NOW - 59 * MIN - 59 * SEC, NOW, false)).toBe('59 min ago')
    expect(lastActive(NOW - 60 * MIN, NOW, false)).toBe('1 h ago')
    expect(lastActive(NOW - 49 * 60 * MIN, NOW, false)).toBe('49 h ago')
    expect(lastActive(NOW, NOW, false)).toBe('0 s ago')
  })

  it('ahead of now → just now', () => {
    expect(lastActive(NOW + 5 * SEC, NOW, false)).toBe('just now')
  })

  it('none → unknown', () => {
    expect(lastActive(undefined, NOW, false)).toBe('unknown')
  })

  it('ended → ended HH:MM in local time; ended with no time → ended', () => {
    expect(lastActive(new Date(2026, 9, 19, 9, 5).getTime(), NOW, true)).toBe('ended 09:05')
    expect(lastActive(undefined, NOW, true)).toBe('ended')
  })

  it('clock pads hours and minutes', () => {
    expect(clock(new Date(2026, 0, 1, 0, 7).getTime())).toBe('00:07')
    expect(clock(new Date(2026, 0, 1, 23, 59).getTime())).toBe('23:59')
  })
})

const progress = (p: Partial<TestProgress>): TestProgress => ({ testFiles: 0, runs: 0, failedRuns: 0, ...p })

const timeline = (events: AgentTimeline['events'], total = events.length): AgentTimeline => ({
  agentId: 'a1',
  events,
  total,
  tests: progress({}),
})

describe('tests and rows', () => {
  it('testsLine: full progress', () => {
    expect(testsLine(progress({ testFirst: true, testFiles: 2, runs: 3, failedRuns: 1, last: 'pass' }))).toBe(
      'yes · 2 test files · 3 runs · last passed',
    )
    expect(testsLine(progress({ testFirst: false, testFiles: 1, runs: 1, failedRuns: 1, last: 'fail' }))).toBe(
      'no · 1 test file · 1 run · last failed',
    )
  })

  it('testsLine: unknown parts left out', () => {
    expect(testsLine(progress({ testFirst: true, testFiles: 1 }))).toBe('yes · 1 test file')
    expect(testsLine(progress({ runs: 2, last: 'pass' }))).toBe('2 runs · last passed')
  })

  it('testsLine: nothing → no test runs yet, also with no timeline', () => {
    expect(testsLine(progress({}))).toBe('no test runs yet')
    expect(testsLine(undefined)).toBe('no test runs yet')
  })

  it('timelineRows: HH:MM, the summary, and the result with its chip class', () => {
    const at = new Date(2026, 9, 19, 14, 2).getTime()
    const view = timelineRows(
      timeline([
        { at, tool: 'Write', summary: 'Write src/a.test.ts' },
        { at: at + MIN, tool: 'Bash', summary: 'Bash: pnpm test', result: 'failed' },
        { at: at + 2 * MIN, tool: 'Bash', summary: 'Bash: pnpm test', result: 'ok' },
      ]),
    )
    expect(view.earlier).toBeUndefined()
    expect(view.rows.map(({ time, summary, result }) => ({ time, summary, result }))).toEqual([
      { time: '14:02', summary: 'Write src/a.test.ts', result: undefined },
      { time: '14:03', summary: 'Bash: pnpm test', result: { label: '→ failed', cls: 's-bad' } },
      { time: '14:04', summary: 'Bash: pnpm test', result: { label: '→ ok', cls: 's-ok' } },
    ])
    expect(new Set(view.rows.map((r) => r.key)).size).toBe(3)
  })

  it('timelineRows: the earlier-steps line when total is over the events shown', () => {
    const e = { at: NOW, tool: 'Read', summary: 'Read a.ts' }
    expect(timelineRows(timeline([e], 301)).earlier).toBe('300 earlier steps not shown')
    expect(timelineRows(timeline([e], 2)).earlier).toBe('1 earlier step not shown')
    expect(timelineRows(timeline([e], 1)).earlier).toBeUndefined()
    expect(timelineRows(timeline([])).rows).toEqual([])
  })
})

const slice = (p: Partial<SliceModel> = {}): SliceModel => ({
  code: 'C1',
  title: 'Edit history panel',
  branch: 'sprint-c1',
  status: 'pending',
  confidence: '',
  pr: { state: 'none' },
  dependsOn: [],
  filesOwned: ['src/history/*', 'src/panel.tsx'],
  model: 'opus',
  ...p,
})

const agent = (p: Partial<AgentRun> = {}): AgentRun => ({
  id: 'a1',
  session: 's1',
  type: 'pod:engineer',
  description: 'SECRET-ISH description text',
  tokens: 248_000,
  ended: false,
  ...p,
})

describe('engineer details', () => {
  it('takes the agent’s branch and model, and formats tokens and last active', () => {
    const d = engineerDetails(slice(), agent({ branch: 'agent-branch', model: 'claude-opus-5-5', lastAt: NOW - 40 * SEC }), NOW, progress({ testFirst: true, testFiles: 1 }))
    expect(d).toEqual([
      { label: 'Branch', value: 'agent-branch', mono: true },
      { label: 'Files owned', value: 'src/history/*, src/panel.tsx', mono: true },
      { label: 'Tests first', value: 'yes · 1 test file', mono: false },
      { label: 'Last active', value: '40 s ago', mono: false },
      { label: 'Model', value: 'claude-opus-5-5', mono: true },
      { label: 'Tokens', value: '248k', mono: true },
    ])
  })

  it('falls back to the slice’s branch and model; no files → not listed', () => {
    const d = engineerDetails(slice({ filesOwned: [] }), agent(), NOW)
    expect(d.find((x) => x.label === 'Branch')?.value).toBe('sprint-c1')
    expect(d.find((x) => x.label === 'Model')?.value).toBe('opus')
    expect(d.find((x) => x.label === 'Files owned')).toEqual({ label: 'Files owned', value: 'not listed', mono: false })
  })

  it('with no engineer: the slice’s parts, and — for the agent’s', () => {
    const d = engineerDetails(slice({ branch: '', model: undefined }), undefined, NOW)
    expect(d.find((x) => x.label === 'Branch')?.value).toBe('—')
    expect(d.find((x) => x.label === 'Model')?.value).toBe('—')
    expect(d.find((x) => x.label === 'Last active')?.value).toBe('—')
    expect(d.find((x) => x.label === 'Tokens')?.value).toBe('—')
    expect(d.find((x) => x.label === 'Tests first')?.value).toBe('no test runs yet')
  })

  it('never shows the agent’s description', () => {
    expect(JSON.stringify(engineerDetails(slice(), agent(), NOW))).not.toContain('SECRET-ISH')
  })
})

describe('engineer details with no slice (a fix run’s engineer)', () => {
  it('the agent’s branch and model; files owned not listed', () => {
    const d = engineerDetails(undefined, agent({ branch: 'fix-scroll', model: 'claude-opus-5-5', lastAt: NOW - 40 * SEC }), NOW)
    expect(d).toEqual([
      { label: 'Branch', value: 'fix-scroll', mono: true },
      { label: 'Files owned', value: 'not listed', mono: false },
      { label: 'Tests first', value: 'no test runs yet', mono: false },
      { label: 'Last active', value: '40 s ago', mono: false },
      { label: 'Model', value: 'claude-opus-5-5', mono: true },
      { label: 'Tokens', value: '248k', mono: true },
    ])
  })
})
