// The one-time copy of the config folder from before the rename to Open AFlow. The rules are in
// pod-docs/feature-details/server.md, under "Config folder".

import { cp, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** `copied`: done now. `none`: no old folder. `kept`: the new folder exists, so nothing is copied. `failed`: logged. */
export type MoveResult = 'copied' | 'none' | 'kept' | 'failed'

export type CopyFolder = (from: string, to: string, filter: (source: string) => boolean) => Promise<void>

export type MoveOptions = {
  /** The old folder, or undefined when there is none to copy from (a set `OPEN_AFLOW_CONFIG_DIR`). */
  from: string | undefined
  to: string
  log?: (line: string) => void
  error?: (line: string) => void
  /** Default: a recursive `fs.cp` that keeps timestamps. Tests pass one that fails. */
  copy?: CopyFolder
}

/** It names a live process of the old folder's server: a copy would make this server think another one owns auto-continue. */
const NOT_COPIED = new Set(['auto-continue-owner.json'])

const nodeCopy: CopyFolder = (from, to, filter) =>
  cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, filter })

const isFolder = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() === true
const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

/**
 * If `to` doesn't exist and `from` is a folder, copies `from` into `to` and leaves `from` as a backup. The copy goes
 * to `<to>.moving` first and is renamed into place, so a failed or cut copy never leaves a half folder that would
 * block the next try. Never throws: a failure is logged, and the server starts with an empty folder.
 */
export async function moveOldConfig(o: MoveOptions): Promise<MoveResult> {
  const { from, to } = o
  const log = o.log ?? ((line) => console.log(line))
  const error = o.error ?? ((line) => console.error(line))
  if (await exists(to)) return 'kept'
  if (from === undefined || !(await isFolder(from))) return 'none'

  const part = `${to}.moving`
  const topLevel = (source: string) => dirname(source) === from && NOT_COPIED.has(basename(source))
  try {
    await rm(part, { recursive: true, force: true })
    await (o.copy ?? nodeCopy)(from, part, (source) => !topLevel(source))
    await rename(part, to)
  } catch (err) {
    await rm(part, { recursive: true, force: true }).catch(() => {})
    const reason = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))
    error(`open-aflow: could not copy the old config folder ${from} to ${to} (${reason}); starting with an empty config`)
    return 'failed'
  }
  log(`open-aflow: copied the old config folder ${from} to ${to}; the old folder stays as a backup`)
  return 'copied'
}
