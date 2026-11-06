// The action log: one JSON line per merge, answer, resume, or remove-repo request in `<config dir>/actions.jsonl`, and the newest
// 50 in memory for the Board. Read once at start; bad lines are skipped. The rules and why are in
// pod-docs/feature-details/actions.md.

import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import type { ActionEntry, AnswerOutcome, MergeOutcome, NewActionEntry, RemoveRepoOutcome, ResolveOutcome, ResumeOutcome } from '@open-aflow/model'

export const ACTION_LOG_MAX = 50
const MERGE_RESULTS = new Set<string>(['merged', 'queued', 'auto-merge', 'stale', 'failed', 'unconfirmed'] satisfies MergeOutcome[])
const ANSWER_RESULTS = new Set<string>(['answered', 'changed', 'failed'] satisfies AnswerOutcome[])
const RESOLVE_RESULTS = new Set<string>(['closed', 'kept', 'changed', 'failed'] satisfies ResolveOutcome[])
const RESUME_RESULTS = new Set<string>(['started', 'failed'] satisfies ResumeOutcome[])
const REMOVE_RESULTS = new Set<string>(['removed', 'failed'] satisfies RemoveRepoOutcome[])
const RESUME_REPLIES = new Set<unknown>(['continue', 'go'])

export type ActionLog = {
  /** Stamps the entry with `now()` and appends it as one line. `false` when it couldn't be written; then it isn't listed either. */
  append(entry: NewActionEntry): Promise<boolean>
  /** The newest 50, newest first. */
  recent(): ActionEntry[]
}

export function createActionLog(opts: { file: string; now: () => number }): ActionLog {
  let { entries, partial } = readEntries(opts.file)
  return {
    async append(entry) {
      const full: ActionEntry = { at: opts.now(), ...entry }
      // A last line cut short (a crash mid-write) gets its own line, so the new entry stays readable.
      const line = (partial ? '\n' : '') + JSON.stringify(full) + '\n'
      try {
        await appendFile(opts.file, line, { encoding: 'utf8', mode: 0o600 })
      } catch {
        return false
      }
      partial = false
      entries = [full, ...entries].slice(0, ACTION_LOG_MAX)
      return true
    },
    recent: () => entries,
  }
}

/** The newest 50 good entries, newest first. A missing or unreadable file is an empty list. */
function readEntries(file: string): { entries: ActionEntry[]; partial: boolean } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { entries: [], partial: false }
  }
  const out: ActionEntry[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < ACTION_LOG_MAX; i--) {
    const entry = parseEntry(lines[i]!)
    if (entry) out.push(entry)
  }
  return { entries: out, partial: text.length > 0 && !text.endsWith('\n') }
}

function parseEntry(line: string): ActionEntry | undefined {
  let d: unknown
  try {
    d = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined
  const e = d as Record<string, unknown>
  const str = (k: string) => typeof e[k] === 'string'
  if (typeof e.at !== 'number' || !Number.isFinite(e.at) || !str('repoId') || !str('repo') || !str('target') || !str('result')) return undefined
  if (e.message !== undefined && !str('message')) return undefined
  const base = { at: e.at, repoId: e.repoId as string, repo: e.repo as string, target: e.target as string }
  // Each action has its own results; a result from the other action is a bad line.
  let entry: ActionEntry
  if (e.action === 'merge' && MERGE_RESULTS.has(e.result as string)) entry = { ...base, action: 'merge', result: e.result as MergeOutcome }
  else if (e.action === 'answer' && ANSWER_RESULTS.has(e.result as string)) entry = { ...base, action: 'answer', result: e.result as AnswerOutcome }
  else if (e.action === 'resolve' && RESOLVE_RESULTS.has(e.result as string)) entry = { ...base, action: 'resolve', result: e.result as ResolveOutcome }
  else if (e.action === 'remove-repo' && REMOVE_RESULTS.has(e.result as string)) entry = { ...base, action: 'remove-repo', result: e.result as RemoveRepoOutcome }
  else if (e.action === 'resume' && RESUME_RESULTS.has(e.result as string) && RESUME_REPLIES.has(e.reply) && typeof e.auto === 'boolean')
    entry = { ...base, action: 'resume', result: e.result as ResumeOutcome, reply: e.reply as 'continue' | 'go', auto: e.auto }
  else return undefined
  if (e.message !== undefined) entry.message = e.message as string
  return entry
}
