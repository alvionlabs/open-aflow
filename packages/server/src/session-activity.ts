// Whether a Claude session is quiet enough for the board to resume it. Checks file times only:
// the main chat is never read. The rules and why are in pod-docs/feature-details/resume.md.

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BoardRepo } from '@openaflow/model'
import { projectDirName } from './transcript-files.ts'

/** How long a session's files must be quiet before it counts as idle. */
export const SESSION_IDLE_MS = 60_000
/** How deep under `<session>/subagents/` to look. Claude keeps it flat; this only bounds a strange tree. */
const MAX_DEPTH = 3

/** The only file calls the check makes: a stat and a folder listing. Nothing here can open a file. */
export type StatFs = {
  statSync(p: string): { mtimeMs: number; isDirectory(): boolean }
  readdirSync(p: string): string[]
}

const nodeFs: StatFs = { statSync: (p) => statSync(p), readdirSync: (p) => readdirSync(p) }

/**
 * `idle(repo, session)`: the session's `<session>.jsonl` exists, and it and everything under
 * `<session>/subagents/` were last modified at least 60 s ago (a foreground subagent writes only
 * there). A missing main file, a time ahead of the clock, or any error → busy.
 */
export function createIdleCheck(o: { claudeDir: string; now: () => number; fs?: StatFs }): (repo: Pick<BoardRepo, 'path'>, session: string) => boolean {
  const fs = o.fs ?? nodeFs
  const quiet = (mtimeMs: number, now: number) => mtimeMs <= now - SESSION_IDLE_MS

  /** Every entry under `dir` is quiet. A missing folder is quiet; any other error is not. */
  function quietTree(dir: string, now: number, depth: number): boolean {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
    }
    for (const name of names) {
      const p = path.join(dir, name)
      let st: ReturnType<StatFs['statSync']>
      try {
        st = fs.statSync(p)
      } catch (err) {
        // Gone between the listing and the stat: nothing there to be busy.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        return false
      }
      if (!quiet(st.mtimeMs, now)) return false
      if (st.isDirectory() && (depth >= MAX_DEPTH || !quietTree(p, now, depth + 1))) return false
    }
    return true
  }

  return (repo, session) => {
    const now = o.now()
    const project = path.join(o.claudeDir, 'projects', projectDirName(repo.path))
    try {
      if (!quiet(fs.statSync(path.join(project, `${session}.jsonl`)).mtimeMs, now)) return false
    } catch {
      return false
    }
    return quietTree(path.join(project, session, 'subagents'), now, 1)
  }
}
