// Screen 3, the engineer view: the details list, the tests line, last active,
// and the timeline rows. Pure; EngineerView only renders these. The rules and
// why are in pod-docs/feature-details/engineer-view.md. Never shows
// AgentRun.description: the view shows tool names and short summaries only.

import { formatTokens, type AgentRun, type AgentTimeline, type SliceModel, type TestProgress } from '@open-aflow/model'
import type { ChipClass } from '../runs/view.ts'

export type Detail = { label: string; value: string; mono: boolean }
export type Row = { key: string; time: string; summary: string; result?: { label: string; cls: ChipClass } }

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const NONE = '—'

const pad = (n: number) => String(n).padStart(2, '0')

/** `HH:MM` in local time. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `<s> s ago`, `<m> min ago`, or `<h> h ago`; ahead of now → `just now`; none → `unknown`; ended → `ended HH:MM`. */
export function lastActive(lastAt: number | undefined, now: number, ended: boolean): string {
  if (ended) return lastAt === undefined ? 'ended' : `ended ${clock(lastAt)}`
  if (lastAt === undefined) return 'unknown'
  const ago = now - lastAt
  if (ago < 0) return 'just now'
  if (ago < MIN) return `${Math.floor(ago / SEC)} s ago`
  if (ago < HOUR) return `${Math.floor(ago / MIN)} min ago`
  return `${Math.floor(ago / HOUR)} h ago`
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `yes · 2 test files · 3 runs · last passed`, unknown parts left out; nothing → `no test runs yet`. */
export function testsLine(tests: TestProgress | undefined): string {
  if (!tests) return 'no test runs yet'
  const parts: string[] = []
  if (tests.testFirst !== undefined) parts.push(tests.testFirst ? 'yes' : 'no')
  if (tests.testFiles > 0) parts.push(count(tests.testFiles, 'test file', 'test files'))
  if (tests.runs > 0) parts.push(count(tests.runs, 'run', 'runs'))
  if (tests.last !== undefined) parts.push(tests.last === 'pass' ? 'last passed' : 'last failed')
  return parts.length === 0 ? 'no test runs yet' : parts.join(' · ')
}

const RESULTS = {
  ok: { label: '→ ok', cls: 's-ok' },
  failed: { label: '→ failed', cls: 's-bad' },
} as const satisfies Record<string, { label: string; cls: ChipClass }>

/** One row per event, oldest first, plus `<n> earlier steps not shown` when the server cut older ones. */
export function timelineRows(timeline: AgentTimeline): { rows: Row[]; earlier?: string } {
  const rows = timeline.events.map((e, i): Row => {
    const row: Row = { key: `${i}:${e.at}`, time: clock(e.at), summary: e.summary }
    if (e.result) row.result = { ...RESULTS[e.result] }
    return row
  })
  const hidden = timeline.total - timeline.events.length
  return hidden > 0 ? { rows, earlier: `${count(hidden, 'earlier step', 'earlier steps')} not shown` } : { rows }
}

/**
 * The details list: the agent's branch and model, else the slice's; `—` for what only an engineer has.
 * With no slice (a fix run's engineer), files owned read `not listed`.
 */
export function engineerDetails(slice: SliceModel | undefined, agent: AgentRun | undefined, now: number, tests?: TestProgress): Detail[] {
  const branch = agent?.branch || slice?.branch.trim() || NONE
  const model = agent?.model || slice?.model || NONE
  const files = slice && slice.filesOwned.length > 0 ? { value: slice.filesOwned.join(', '), mono: true } : { value: 'not listed', mono: false }
  return [
    { label: 'Branch', value: branch, mono: branch !== NONE },
    { label: 'Files owned', ...files },
    { label: 'Tests first', value: testsLine(tests), mono: false },
    { label: 'Last active', value: agent ? lastActive(agent.lastAt, now, agent.ended) : NONE, mono: false },
    { label: 'Model', value: model, mono: model !== NONE },
    { label: 'Tokens', value: agent ? formatTokens(agent.tokens) : NONE, mono: agent !== undefined },
  ]
}
