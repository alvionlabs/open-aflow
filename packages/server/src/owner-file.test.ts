import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createOwnerFile, OWNER_FILE } from './owner-file.ts'

let dir: string
let file: string
let logs: string[]
const log = (m: string) => void logs.push(m)

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-owner-')))
  file = join(dir, OWNER_FILE)
  logs = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => JSON.parse(readFileSync(file, 'utf8')) as { pid: number; id: string; startedAt: unknown }
const holder = (pid: number, id = 'other') => writeFileSync(file, JSON.stringify({ pid, id, startedAt: 1 }))
/** The process ID of a child that has already exited. */
const exitedPid = () => spawnSync(process.execPath, ['-e', '0']).pid

describe('owner file', () => {
  test('takes a free file', () => {
    const owner = createOwnerFile({ dir, log })
    expect(owner.take()).toBe(true)
    const held = read()
    expect(held.pid).toBe(process.pid)
    expect(held.id).toBeTruthy()
    expect(held.startedAt).toBeDefined()
    expect(owner.check()).toBe(true)
    expect(logs).toEqual([])
  })

  test('each server gets its own id', () => {
    const one = createOwnerFile({ dir, log })
    one.take()
    const first = read().id
    one.release()
    const two = createOwnerFile({ dir, log })
    two.take()
    expect(read().id).not.toBe(first)
  })

  test('a live holder keeps it', () => {
    holder(4242)
    const before = readFileSync(file, 'utf8')
    const owner = createOwnerFile({ dir, log, alive: () => true })
    expect(owner.take()).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('4242')
    expect(logs[0]).toContain(dir)
    // It looks only at start: off also after the holder exits, with no more log lines.
    rmSync(file)
    expect(owner.check()).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(logs).toHaveLength(1)
  })

  test('takes over a stale file', () => {
    holder(exitedPid())
    const stale = createOwnerFile({ dir, log })
    expect(stale.take()).toBe(true)
    expect(read().pid).toBe(process.pid)
    stale.release()

    for (const bad of ['', 'not json', '{"pid":', 'null', '[]', '7', '{}', '{"pid":"x","id":"y"}', '{"pid":0,"id":"y"}', '{"pid":-1,"id":"y"}', '{"pid":1.5,"id":"y"}', '{"pid":99999999999,"id":"y"}', '{"pid":5}', '{"pid":5,"id":7}']) {
      writeFileSync(file, bad)
      const owner = createOwnerFile({ dir, log, alive: () => true })
      expect(owner.take(), bad).toBe(true)
      expect(read().pid, bad).toBe(process.pid)
      owner.release()
    }
    expect(logs).toEqual([])
  })

  test('losing the take-over race reads as another holder', () => {
    holder(1111)
    // Between this server's read and its create, another server makes the file again.
    const owner = createOwnerFile({
      dir,
      log,
      alive: (pid) => {
        if (pid === 1111) {
          rmSync(file)
          holder(2222, 'winner')
          return false
        }
        return true
      },
    })
    expect(owner.take()).toBe(false)
    expect(read().id).toBe('winner')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('2222')
  })

  test('the owner checks again', () => {
    const owner = createOwnerFile({ dir, log })
    owner.take()
    // Gone: created again, with the same id.
    const id = read().id
    rmSync(file)
    expect(owner.check()).toBe(true)
    expect(read().id).toBe(id)
    expect(logs).toEqual([])

    // Bad JSON: the same as gone, and never a reason to stop.
    writeFileSync(file, 'not json')
    expect(owner.check()).toBe(true)
    expect(read().id).toBe(id)

    // Another id: over for good, with one line naming the new holder.
    holder(4242, 'other')
    expect(owner.check()).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('4242')
    expect(owner.check()).toBe(false)
    expect(logs).toHaveLength(1)
    // Also once the file is free again.
    rmSync(file)
    expect(owner.check()).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(logs).toHaveLength(1)
  })

  test('an error fails closed', () => {
    // A path under a file: the folder can't exist, on any OS.
    const blocker = join(dir, 'a-file')
    writeFileSync(blocker, 'x')
    const owner = createOwnerFile({ dir: blocker, log })
    expect(owner.take()).toBe(false)
    expect(owner.check()).toBe(false)
    expect(() => owner.release()).not.toThrow()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(blocker)

    // A folder where the file should be.
    logs = []
    const other = join(dir, 'other')
    mkdirSync(join(other, OWNER_FILE), { recursive: true })
    const blocked = createOwnerFile({ dir: other, log })
    expect(blocked.take()).toBe(false)
    expect(logs).toHaveLength(1)
    expect(() => blocked.release()).not.toThrow()
  })

  test("a read error during a check skips that check, says so once, and doesn't end ownership", () => {
    const owner = createOwnerFile({ dir, log })
    owner.take()
    const id = read().id
    // A folder in its place reads as an error that isn't "gone".
    rmSync(file)
    mkdirSync(file)
    expect(owner.check()).toBe(false)
    expect(owner.check()).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(dir)
    // The error ends: this server is still the owner, and it says nothing more.
    rmSync(file, { recursive: true })
    writeFileSync(file, JSON.stringify({ pid: process.pid, id, startedAt: 1 }))
    expect(owner.check()).toBe(true)
    expect(logs).toHaveLength(1)
  })

  test('releases only its own', () => {
    const owner = createOwnerFile({ dir, log })
    owner.take()
    owner.release()
    expect(existsSync(file)).toBe(false)
    // A release with nothing there is fine.
    expect(() => owner.release()).not.toThrow()

    const another = createOwnerFile({ dir, log })
    another.take()
    holder(4242, 'other')
    const text = readFileSync(file, 'utf8')
    another.release()
    expect(readFileSync(file, 'utf8')).toBe(text)

    // A server that never held it leaves the holder's file.
    const never = createOwnerFile({ dir, log, alive: () => true })
    never.take()
    never.release()
    expect(readFileSync(file, 'utf8')).toBe(text)
  })
})
