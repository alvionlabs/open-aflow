// One automatic check per config folder: dev and production can share a folder, and two checks would
// send one stop twice. The rules and why are in pod-docs/feature-details/resume.md.

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { envKey } from './bin-path.ts'
import { isPid, processAlive } from './parent-link.ts'

export const OWNER_FILE = 'auto-continue-owner.json'

/** A start this long after the file's write counts as a reused ID, so a small clock step never reads as one. */
const CLOCK_SLACK_MS = 2000
/** The lookup blocks the server's start, and only runs when a live process holds the file. */
const START_TIME_LIMIT_MS = 5000
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

export type StartTimeRun = (exe: string, args: string[], options: { windowsHide: boolean; shell: boolean; timeout: number }) => { status: number | null; stdout: string }

const runForText: StartTimeRun = (exe, args, options) => {
  const { status, stdout } = spawnSync(exe, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return { status, stdout: stdout ?? '' }
}

/**
 * When a process started, in ms since the epoch, or `undefined` when that can't be read: another
 * system, no `SystemRoot`, a process gone, or a time-out. `Win32_Process`, because `Get-Process` gives no
 * `StartTime` for another account's process unless elevated. Windows PowerShell by its absolute path,
 * because production can run with an empty `Path`. Never throws, and opens no window.
 */
export function processStartTime(pid: number, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: StartTimeRun } = {}): number | undefined {
  if ((o.platform ?? process.platform) !== 'win32') return undefined
  const root = envKey(o.env ?? process.env, 'SYSTEMROOT')
  if (root === undefined || !DRIVE_PATH.test(root)) return undefined
  const exe = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // A process that is gone gives no row and no error, so that exit is explicit.
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if (-not $p) { exit 1 }; [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds()`
  try {
    const { status, stdout } = (o.run ?? runForText)(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false, timeout: START_TIME_LIMIT_MS })
    const text = stdout.trim()
    return status === 0 && /^\d+$/.test(text) ? Number(text) : undefined
  } catch {
    return undefined
  }
}

export type OwnerFile = {
  /** At start, once: true when this server owns the check. Never throws. */
  take(): boolean
  /** Before each check: true when this server may send now. Never throws. */
  check(): boolean
  /** At the end of a normal stop: removes the file only when it holds this server's `id`. Never throws. */
  release(): void
}

type Holder = { pid: number; id: string; startedAt?: number }

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException).code ?? 'unknown error'

/** The file's text as a holder, or `undefined` for bad JSON or a bad shape. */
function parseHolder(text: string): Holder | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { pid, id, startedAt } = value as { pid?: unknown; id?: unknown; startedAt?: unknown }
  if (!isPid(pid) || typeof id !== 'string' || id === '') return undefined
  return typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? { pid, id, startedAt } : { pid, id }
}

export function createOwnerFile(o: {
  dir: string
  pid?: number
  alive?: (pid: number) => boolean
  startTime?: (pid: number) => number | undefined
  log?: (m: string) => void
}): OwnerFile {
  const file = join(o.dir, OWNER_FILE)
  const pid = o.pid ?? process.pid
  const id = randomUUID()
  const alive = o.alive ?? processAlive
  const startTime = o.startTime ?? processStartTime
  const log = o.log ?? ((m: string) => console.log(m))
  let owner = false
  let errorSaid = false

  const heldBy = (holder: Holder | undefined) =>
    `openaflow: ${holder ? `process ${holder.pid}` : 'another process'} runs auto-continue for ${o.dir}; this server won't auto-continue until it restarts`
  const unsure = (holder: Holder) =>
    `openaflow: process ${holder.pid} may run auto-continue for ${o.dir}, and this server can't read when it started; this server won't auto-continue until it restarts`
  const failed = (err: unknown) => `openaflow: can't use the auto-continue owner file in ${o.dir} (${codeOf(err)}); this server won't auto-continue now`

  /** The exclusive create, with the file's whole text in one write. */
  const create = () => writeFileSync(file, JSON.stringify({ pid, id, startedAt: Date.now() }), { flag: 'wx' })
  const remove = () => rmSync(file, { force: true })
  const read = () => readFileSync(file, 'utf8')

  /**
   * Whether the file's live process is the server that wrote it. A server starts before it writes the
   * file, so a later start means the process ID went to another program. `undefined`: can't tell.
   */
  const isServer = (holder: Holder): boolean | undefined => {
    if (holder.startedAt === undefined) return undefined
    const started = startTime(holder.pid)
    return started === undefined ? undefined : started <= holder.startedAt + CLOCK_SLACK_MS
  }

  /** Ends ownership for good, naming who has the file, when that can be read. */
  const lose = (holder: Holder | undefined) => {
    owner = false
    log(heldBy(holder))
    return false
  }

  /** The file's holder, when it can be read now. */
  const holderNow = () => {
    try {
      return parseHolder(read())
    } catch {
      return undefined
    }
  }

  /** The file is gone or bad: makes it again. A file that appears first belongs to another server. */
  const recreate = (): boolean => {
    try {
      create()
      errorSaid = false
      return true
    } catch (err) {
      return codeOf(err) === 'EEXIST' ? lose(holderNow()) : readError(err)
    }
  }

  /** A failed check sends nothing, says so once per spell of errors, and the next check reads again. */
  const readError = (err: unknown) => {
    if (!errorSaid) log(failed(err))
    errorSaid = true
    return false
  }

  return {
    take() {
      try {
        try {
          create()
          owner = true
          return true
        } catch (err) {
          if (codeOf(err) !== 'EEXIST') throw err
        }
        let holder: Holder | undefined
        try {
          holder = parseHolder(read())
        } catch (err) {
          // The holder released it a moment ago, which reads the same as a stale file.
          if (codeOf(err) !== 'ENOENT') throw err
        }
        if (holder && alive(holder.pid)) {
          const server = isServer(holder)
          if (server !== false) {
            log(server ? heldBy(holder) : unsure(holder))
            return false
          }
        }
        remove()
        try {
          create()
          owner = true
          return true
        } catch (err) {
          if (codeOf(err) !== 'EEXIST') throw err
        }
        // Another server made the file between the removal and the create.
        return lose(holderNow())
      } catch (err) {
        log(failed(err))
        return false
      }
    },
    check() {
      if (!owner) return false
      let holder: Holder | undefined
      try {
        holder = parseHolder(read())
        if (holder === undefined) remove()
      } catch (err) {
        return codeOf(err) === 'ENOENT' ? recreate() : readError(err)
      }
      if (holder === undefined) return recreate()
      if (holder.id !== id) return lose(holder)
      errorSaid = false
      return true
    },
    release() {
      try {
        if (parseHolder(read())?.id === id) remove()
      } catch {
        // Gone already, or stale for the next start to take over.
      }
    },
  }
}
