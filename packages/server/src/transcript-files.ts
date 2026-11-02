import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRun } from '@pod-board/model'
import { envValue, type Env } from './config.ts'
import { isInsideRepo } from './guard.ts'

/** One subagent's transcript files: `<session>/subagents/agent-<id>.jsonl` and its `.meta.json`. */
export type AgentFile = { id: string; session: string; jsonlPath: string; metaPath: string }

/** What `parseAgentTranscript` takes. `meta` is `''` when the meta file is missing. */
export type AgentFileText = { id: string; session: string; meta: string; jsonl: string }

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TRANSCRIPT_DAYS = 30

/** Claude's config folder: `POD_BOARD_CLAUDE_DIR`, else `CLAUDE_CONFIG_DIR`, else `<home>/.claude`. */
export function claudeDir(env: Env, home: string): string {
  return envValue(env, 'POD_BOARD_CLAUDE_DIR') ?? envValue(env, 'CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude')
}

/** How many days back to look for sessions: `POD_BOARD_TRANSCRIPT_DAYS`, default 30. A bad value throws. */
export function transcriptDays(env: Env): number {
  const raw = envValue(env, 'POD_BOARD_TRANSCRIPT_DAYS')
  if (raw === undefined) return DEFAULT_TRANSCRIPT_DAYS
  const days = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(`POD_BOARD_TRANSCRIPT_DAYS must be a whole number of days, 1 or more, got ${JSON.stringify(raw)}`)
  }
  return days
}

/** Claude's folder name for a project: each character outside `[A-Za-z0-9]` becomes `-`. */
export function projectDirName(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * A parsed agent as a repo lists it, by the first `cwd` its transcript recorded, with the `cwd` taken off. Claude's
 * project folder name folds symbols, so `chess-web` and `chess_web` read one folder, also with no sibling on the board.
 * In the repo (its worktrees too) → listed, and its session can be sent to. In a folder that folds to this project's
 * name (a sibling or its worktree) → not this repo's, so undefined. No `cwd`, or anywhere else → listed as before,
 * but `sessionUnproven`, so nothing is sent.
 */
export function agentOfRepo(run: AgentRun, repo: { path: string; caseless: boolean }, platform: NodeJS.Platform): AgentRun | undefined {
  const { cwd, ...agent } = run
  if (cwd === undefined) return { ...agent, sessionUnproven: true }
  if (isInsideRepo(cwd, repo.path, platform, repo.caseless)) return agent
  const fold = (s: string) => projectDirName(repo.caseless ? s.toLowerCase() : s)
  const name = fold(repo.path)
  const there = fold(cwd)
  return there === name || there.startsWith(`${name}-`) ? undefined : { ...agent, sessionUnproven: true }
}

/**
 * The subagent transcripts of a repo's sessions changed in the last
 * `maxAgeDays`, sorted by session then id. A session counts as changed when
 * its folder or its `subagents/` folder changed (a new agent adds a file to
 * `subagents/` without touching the session folder). Missing folders give `[]`.
 */
export async function listAgentFiles(
  claudeDir: string,
  repoPath: string,
  maxAgeDays: number,
  now: number,
): Promise<AgentFile[]> {
  const project = path.join(claudeDir, 'projects', projectDirName(repoPath))
  const sessions = await dirsIn(project)
  const oldest = now - maxAgeDays * DAY_MS
  const found: AgentFile[] = []
  for (const session of sessions.sort()) {
    const sub = path.join(project, session, 'subagents')
    const changed = Math.max(await mtimeOf(path.join(project, session)), await mtimeOf(sub))
    if (changed < oldest) continue
    const ids = (await namesIn(sub))
      .map((n) => /^agent-(.+)\.jsonl$/.exec(n)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort()
    for (const id of ids) {
      found.push({
        id,
        session,
        jsonlPath: path.join(sub, `agent-${id}.jsonl`),
        metaPath: path.join(sub, `agent-${id}.meta.json`),
      })
    }
  }
  return found
}

type Stamp = { size: number; mtimeMs: number } | undefined
type Entry<T> = { jsonl: Stamp; meta: Stamp; value: T }

/** Reads an agent's files now, with no cache. `meta` is `''` when it can't be read; a missing transcript throws. */
export async function readAgentFile(file: AgentFile): Promise<AgentFileText> {
  return {
    id: file.id,
    session: file.session,
    meta: await readFile(file.metaPath, 'utf8').catch(() => ''),
    jsonl: await readFile(file.jsonlPath, 'utf8'),
  }
}

/**
 * Parses each agent's files once and keeps only what `parse` returns, never
 * the file text: an agent whose transcript and meta keep their size and mtime
 * is not read again. Both files are stamped before they're read, so a write
 * during the read is seen on the next call. `retain` forgets agents no longer
 * listed, so memory follows the listing. A missing transcript throws.
 */
export function createAgentFileCache<T>(parse: (text: AgentFileText) => T): {
  read(file: AgentFile): Promise<T>
  retain(files: readonly AgentFile[]): void
} {
  const cache = new Map<string, Entry<T>>()
  return {
    async read(file) {
      const jsonl = await stampOf(file.jsonlPath)
      if (!jsonl) throw new Error(`transcript gone: ${file.jsonlPath}`)
      const meta = await stampOf(file.metaPath)
      const hit = cache.get(file.jsonlPath)
      if (hit && same(hit.jsonl, jsonl) && same(hit.meta, meta)) return hit.value
      const value = parse(await readAgentFile(file))
      cache.set(file.jsonlPath, { jsonl, meta, value })
      return value
    },
    retain(files) {
      const keep = new Set(files.map((f) => f.jsonlPath))
      for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key)
    },
  }
}

const same = (a: Stamp, b: Stamp) => a?.size === b?.size && a?.mtimeMs === b?.mtimeMs

async function stampOf(file: string): Promise<Stamp> {
  try {
    const s = await stat(file)
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

async function mtimeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

async function dirsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}
