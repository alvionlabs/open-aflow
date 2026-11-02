// One pod agent's transcript read into an AgentRun: who it is, where it works,
// when it ran, what it cost, and whether it ended. Pure: the server reads the
// files and hands their text in. No transcript text, tool input, tool output,
// or the meta file's description is ever kept. The rules and why are in pod-docs/feature-details/run-model.md.

import type { AgentRun, AgentState, AgentTurn } from './board.ts'
import { readDispatch } from './dispatch.ts'
import { turnTokens } from './pod-flow/model.ts'
import type { Usage } from './pod-flow/types.ts'

/** An agent that wrote nothing for this long, and didn't end, reads as stale. */
export const STALE_MS = 30 * 60 * 1000

/**
 * A gap between two records longer than this is idle, not work: it ends one active span. 15 minutes:
 * headroom over the longest a foreground tool call runs (the Bash tool's 10-minute limit; a call that
 * runs to it writes its result about 10.02 minutes later) and Claude Code's 600 s stall watchdog. A
 * laptop asleep leaves gaps of hours.
 */
export const IDLE_GAP_MS = 15 * 60 * 1000

/** A gap that ends in the result of a tool call the agent was waiting on counts as active up to this long. */
export const TOOL_GAP_MS = 30 * 60 * 1000

/** One agent's files, as text: `agent-<id>.meta.json` and `agent-<id>.jsonl`. */
export type AgentFile = { id: string; session: string; meta: string; jsonl: string }

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The agent's run, or undefined when it isn't a pod agent or its meta isn't JSON. Never throws. */
export function parseAgentTranscript({ id, session, meta, jsonl }: AgentFile): AgentRun | undefined {
  const info = parseJson(meta)
  if (!isObject(info) || typeof info.agentType !== 'string' || !info.agentType.startsWith('pod:')) return undefined

  let prompt: string | undefined
  let startedAt: number | undefined
  let lastAt: number | undefined
  let model: string | undefined
  const active: [number, number][] = []
  // Tool calls the agent waits on: their ids, from tool_use blocks, until a tool_result answers them.
  const calls = new Set<string>()
  // A turn runs from a prompt to its hand-back (or end_turn); a prompt after that starts the next turn.
  let turn: Turn = { ended: false }
  const turns: Turn[] = [turn]
  // A message streams over several records with the same id; its last record has the final usage.
  const usageById = new Map<string, { tokens: number; turn: Turn }>()

  for (const line of jsonl.split('\n')) {
    const record = parseJson(line)
    if (!isObject(record)) continue
    const message = isObject(record.message) ? record.message : undefined
    // A prompt after a hand-back: the agent works again. Only the coordinator's resume (SendMessage)
    // starts a new turn; a task notification or a nudge re-opens the turn it answers.
    if (record.type === 'user' && message && isPrompt(message.content) && turn.ended) {
      if (isObject(record.origin) && record.origin.kind === 'coordinator') turns.push((turn = { ended: false }))
      else turn = Object.assign(turn, { ended: false, endedAt: undefined })
    }
    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    const answers = record.type === 'user' && message !== undefined && answersCall(message.content, calls)
    if (record.type === 'assistant' && message && Array.isArray(message.content)) {
      for (const b of message.content) if (isObject(b) && b.type === 'tool_use' && typeof b.id === 'string') calls.add(b.id)
    }
    if (Number.isFinite(time)) {
      startedAt ??= time
      const span = active.at(-1)
      if (span && time - span[1] <= (answers ? TOOL_GAP_MS : IDLE_GAP_MS)) span[1] = Math.max(span[1], time)
      else active.push([time, time])
      lastAt = time
      turn.startedAt ??= time
      turn.lastAt = time
    }
    if (!message) continue
    if (record.type === 'user') {
      prompt ??= promptText(message.content)
    } else if (record.type === 'assistant') {
      if (typeof message.model === 'string') model = message.model
      if (message.stop_reason === 'end_turn' || (Array.isArray(message.content) && message.content.some(isHandback))) {
        turn.ended = true
        if (Number.isFinite(time)) turn.endedAt ??= time
      }
      if (typeof message.id === 'string' && isObject(message.usage)) usageById.set(message.id, { tokens: tokensOf(message.usage), turn })
    }
  }

  // Ended only when the last turn handed back: a resumed agent works again until it hands back again.
  const run: AgentRun = { id, session, type: info.agentType, tokens: 0, ended: turn.ended }
  for (const u of usageById.values()) {
    run.tokens += u.tokens
    u.turn.tokens = (u.turn.tokens ?? 0) + u.tokens
  }
  if (prompt !== undefined) {
    for (const [key, value] of Object.entries(readDispatch(prompt, info.agentType))) {
      if (value !== undefined) Object.assign(run, { [key]: value })
    }
  }
  if (model !== undefined) run.model = model
  if (startedAt !== undefined) run.startedAt = startedAt
  if (lastAt !== undefined) run.lastAt = lastAt
  if (active.length > 0) run.active = active
  // Only a resumed agent gets its turns: one turn says nothing the run's own fields don't.
  const timed = turns.filter((t): t is Turn & { startedAt: number; lastAt: number } => t.startedAt !== undefined && t.lastAt !== undefined)
  if (timed.length > 1) {
    run.turns = timed.map((t) => {
      const out: AgentTurn = { startedAt: t.startedAt, lastAt: t.lastAt, tokens: t.tokens ?? 0 }
      if (t.endedAt !== undefined) out.endedAt = t.endedAt
      return out
    })
    run.resumedAt = timed.at(-1)!.startedAt
  }
  return run
}

type Turn = { ended: boolean; startedAt?: number; endedAt?: number; lastAt?: number; tokens?: number }

/** A user record that brings a prompt: text, and no tool result (a tool's answer is no prompt). */
function isPrompt(content: unknown): boolean {
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some((b) => isObject(b) && b.type === 'text') && !content.some((b) => isObject(b) && b.type === 'tool_result')
}

/** `ended` → ended; written to within STALE_MS → running; else, or never written to, stale. */
export function agentState(a: AgentRun, now: number): AgentState {
  if (a.ended) return 'ended'
  return a.lastAt !== undefined && now - a.lastAt < STALE_MS ? 'running' : 'stale'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A user message's prompt: its string content, or its first text block. */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const block = content.find((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
  return block?.text as string | undefined
}

/** A user record's content answers a call in `calls`; the answered ids leave the set. */
function answersCall(content: unknown, calls: Set<string>): boolean {
  if (!Array.isArray(content)) return false
  let answered = false
  for (const b of content) {
    if (isObject(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && calls.delete(b.tool_use_id)) answered = true
  }
  return answered
}

const isHandback = (block: unknown) => isObject(block) && block.type === 'tool_use' && block.name === 'SubagentHandback'

/** A usage field that's missing or not a number counts as 0. */
function tokensOf(u: Json): number {
  const usage: Usage = {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
  }
  return turnTokens(usage)
}
