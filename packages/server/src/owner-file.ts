// One automatic check per config folder: dev and production can share a folder, and two checks would
// send one stop twice. The rules and why are in pod-docs/feature-details/resume.md.

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPid, processAlive } from './parent-link.ts'

export const OWNER_FILE = 'auto-continue-owner.json'

export type OwnerFile = {
  /** At start, once: true when this server owns the check. Never throws. */
  take(): boolean
  /** Before each check: true when this server may send now. Never throws. */
  check(): boolean
  /** At the end of a normal stop: removes the file only when it holds this server's `id`. Never throws. */
  release(): void
}

type Holder = { pid: number; id: string }

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
  const { pid, id } = value as { pid?: unknown; id?: unknown }
  return isPid(pid) && typeof id === 'string' && id !== '' ? { pid, id } : undefined
}

export function createOwnerFile(o: { dir: string; pid?: number; alive?: (pid: number) => boolean; log?: (m: string) => void }): OwnerFile {
  const file = join(o.dir, OWNER_FILE)
  const pid = o.pid ?? process.pid
  const id = randomUUID()
  const alive = o.alive ?? processAlive
  const log = o.log ?? ((m: string) => console.log(m))
  let owner = false
  let errorSaid = false

  const heldBy = (holder: Holder | undefined) =>
    `pod-board: ${holder ? `process ${holder.pid}` : 'another process'} runs auto-continue for ${o.dir}; this server won't auto-continue until it restarts`
  const failed = (err: unknown) => `pod-board: can't use the auto-continue owner file in ${o.dir} (${codeOf(err)}); this server won't auto-continue now`

  /** The exclusive create, with the file's whole text in one write. */
  const create = () => writeFileSync(file, JSON.stringify({ pid, id, startedAt: Date.now() }), { flag: 'wx' })
  const remove = () => rmSync(file, { force: true })
  const read = () => readFileSync(file, 'utf8')

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
          log(heldBy(holder))
          return false
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
