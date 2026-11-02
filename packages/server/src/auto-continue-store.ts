// The auto-continue toggles: `<config dir>/auto-continue.json` = `{ "runs": AutoToggle[] }`.
// Read once at start, failing closed (missing, unreadable, or bad → off). Each change writes the
// whole file atomically, one change at a time, and only then takes effect in memory.
// The rules and why are in pod-docs/feature-details/resume.md.

import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withAnsweredKey, type AutoToggle } from '@pod-board/model'

export type AutoContinueStore = {
  /** The toggles that are on, in the order they were turned on. */
  list(): AutoToggle[]
  /** On adds the toggle with no `lastKey` (again: clears it); off removes it. Throws when the save fails, and nothing changes. */
  set(repoId: string, run: string, on: boolean): Promise<void>
  /**
   * Saves the stop a toggle last sent for, and an `answered` key in its `answeredKeys` too. `false` when the
   * toggle is gone; throws when the save fails, and nothing changes.
   */
  saveKey(repoId: string, run: string, key: string): Promise<boolean>
  /** Forgets every toggle stored under these repo ids. */
  dropRepoIds(ids: readonly string[]): Promise<void>
}

export function createAutoContinueStore(o: { file: string; write?: (file: string, text: string) => Promise<void> }): AutoContinueStore {
  const write = o.write ?? writeAtomic
  let toggles = readToggles(o.file)
  // Changes run one at a time, so each write holds every change before it.
  let chain: Promise<unknown> = Promise.resolve()

  /** Saves `change(toggles)` and then uses it. `undefined` from `change` saves nothing. */
  function update(change: (current: AutoToggle[]) => AutoToggle[] | undefined): Promise<boolean> {
    const run = chain.then(async () => {
      const next = change(toggles)
      if (next === undefined) return false
      await write(o.file, JSON.stringify({ runs: next }, null, 2) + '\n')
      toggles = next
      return true
    })
    chain = run.catch(() => {})
    return run
  }

  const same = (t: AutoToggle, repoId: string, run: string) => t.repoId === repoId && t.run === run

  return {
    list: () => toggles.map((t) => ({ ...t })),
    async set(repoId, run, on) {
      await update((current) => {
        const rest = current.filter((t) => !same(t, repoId, run))
        if (on) {
          const at = current.findIndex((t) => same(t, repoId, run))
          // Turning on again keeps its place in the list and clears its key.
          if (at === -1) return [...rest, { repoId, run }]
          return current.map((t, i) => (i === at ? { repoId, run } : t))
        }
        return rest.length === current.length ? undefined : rest
      })
    },
    saveKey: (repoId, run, key) =>
      update((current) => (current.some((t) => same(t, repoId, run)) ? current.map((t) => (same(t, repoId, run) ? saved(t, key) : t)) : undefined)),
    dropRepoIds: async () => {},
  }
}

/** The toggle after a send of `key`. */
function saved(t: AutoToggle, key: string): AutoToggle {
  const answeredKeys = withAnsweredKey(t.answeredKeys, key)
  return answeredKeys === undefined ? { ...t, lastKey: key } : { ...t, lastKey: key, answeredKeys }
}

/** The good toggles in the file, first of each run only. Missing, unreadable, or bad JSON → none. */
function readToggles(file: string): AutoToggle[] {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const runs = data && typeof data === 'object' && !Array.isArray(data) ? (data as { runs?: unknown }).runs : undefined
  if (!Array.isArray(runs)) return []
  const out: AutoToggle[] = []
  for (const r of runs) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const { repoId, run, lastKey, answeredKeys } = r as Record<string, unknown>
    if (typeof repoId !== 'string' || typeof run !== 'string' || (lastKey !== undefined && typeof lastKey !== 'string')) continue
    if (out.some((t) => t.repoId === repoId && t.run === run)) continue
    const t: AutoToggle = lastKey === undefined ? { repoId, run } : { repoId, run, lastKey }
    // A bad list is dropped and the toggle kept; only its strings count.
    if (Array.isArray(answeredKeys)) t.answeredKeys = answeredKeys.filter((k): k is string => typeof k === 'string')
    out.push(t)
  }
  return out
}

/** A temp file beside it, then a rename, so a crash leaves the old file or the new one. Owner-only on POSIX. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
    await renameWithRetry(temp, file)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/** On Windows a rename over a file another process has open (a watcher, a virus scan) fails for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
    }
  }
}
