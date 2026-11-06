// The one-time copy of the config folder from before the rename to Open AFlow. The rules are in
// pod-docs/feature-details/server.md, under "Config folder".

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** `copied`: done now. `none`: no old folder. `kept`: the new folder exists, so nothing is copied. `failed`: logged. */
export type MoveResult = 'copied' | 'none' | 'kept' | 'failed'

export type CopyFile = (from: string, to: string) => Promise<void>

export type MoveOptions = {
  /** The old folder, or undefined when there is none to copy from (a set `OPEN_AFLOW_CONFIG_DIR`). */
  from: string | undefined
  to: string
  log?: (line: string) => void
  error?: (line: string) => void
  /** Default: `fs.copyFile`. Tests pass one that fails. */
  copyFile?: CopyFile
  /** How often a busy needed file is tried. Default: 5 tries, 500 ms apart, about 2 s in all. */
  retry?: { tries: number; waitMs: number }
}

/** It names a live process of the old folder's server: a copy would make this server think another one owns auto-continue. */
const NOT_COPIED = new Set(['auto-continue-owner.json'])
/** A lock another program holds for a moment. Windows also says EPERM for a file open with no sharing. */
const BUSY = new Set(['EBUSY', 'EPERM'])
/** A copy takes seconds, so a part copy this old has no live owner. */
const STALE_MS = 3600_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))
const isFolder = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() === true
const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

/** Removes `<to>.moving-*` folders older than an hour. A newer one may be another start's copy right now. */
async function removeStaleParts(to: string): Promise<void> {
  const prefix = `${basename(to)}.moving-`
  const names = await readdir(dirname(to)).catch(() => [] as string[])
  for (const name of names.filter((n) => n.startsWith(prefix))) {
    const path = join(dirname(to), name)
    const info = await stat(path).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

/** Every file under `dir`, relative to it. Folders that can't be read count as having no files. */
async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const r = rel ? join(rel, e.name) : e.name
    if (e.isDirectory()) out.push(...(await filesUnder(dir, r)))
    else if (e.isFile()) out.push(r)
  }
  return out
}

/**
 * If `to` doesn't exist and `from` is a folder, copies `from` into `to` and leaves `from` as a backup.
 * - Needed: every top-level file but the owner file. A busy one is tried again; one that still fails fails the copy.
 * - Best effort: files in folders (`resume-logs/`). One that can't be read is skipped and logged.
 * Each call copies into its own `<to>.moving-<id>` and renames it into place, so `to` appears whole or not at all.
 * The call whose rename loses to another start's returns `kept`. Never throws. On `failed`, the caller runs on `from`
 * and doesn't create `to`, so the next start tries again (`liveConfigDir`).
 */
export async function moveOldConfig(o: MoveOptions): Promise<MoveResult> {
  const { from, to } = o
  const log = o.log ?? ((line) => console.log(line))
  const error = o.error ?? ((line) => console.error(line))
  const copy = o.copyFile ?? copyFile
  const retry = o.retry ?? { tries: 5, waitMs: 500 }
  await removeStaleParts(to)
  if (await exists(to)) return 'kept'
  if (from === undefined || !(await isFolder(from))) return 'none'

  const part = `${to}.moving-${randomUUID()}`
  let failedFile = ''
  try {
    await mkdir(part, { recursive: true })
    for (const rel of await filesUnder(from)) {
      const src = join(from, rel)
      const dest = join(part, rel)
      const needed = dirname(rel) === '.'
      if (needed && NOT_COPIED.has(rel)) continue
      if (!needed) await mkdir(dirname(dest), { recursive: true })
      for (let tryNo = 1; ; tryNo++) {
        try {
          await copy(src, dest)
          break
        } catch (err) {
          if (!needed) {
            error(`open-aflow: skipped ${src} in the old config folder copy (${code(err)})`)
            break
          }
          if (!BUSY.has(code(err)) || tryNo >= retry.tries) {
            failedFile = src
            throw err
          }
          await sleep(retry.waitMs)
        }
      }
    }
    await rename(part, to)
  } catch (err) {
    await rm(part, { recursive: true, force: true }).catch(() => {})
    // Another start's copy got there first: that folder is whole, so it counts.
    if (await exists(to)) return 'kept'
    const what = failedFile ? `${failedFile} of the old config folder ${from}` : `the old config folder ${from}`
    error(`open-aflow: could not copy ${what} to ${to} (${code(err)}); this start uses the old folder, and the next start tries again`)
    return 'failed'
  }
  log(`open-aflow: copied the old config folder ${from} to ${to}; the old folder stays as a backup`)
  return 'copied'
}
