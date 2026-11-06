import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createOwnerFile, OWNER_FILE, processStartTime, type StartTimeRun } from './owner-file.ts'

// Runs right after the owner file's removal of a stale file, so a test can lose the race.
const afterRemove = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      real.rmSync(...args)
      const run = afterRemove.run
      afterRemove.run = undefined
      run?.()
    },
  }
})

let dir: string
let file: string
let logs: string[]
const log = (m: string) => void logs.push(m)

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'open-aflow-owner-')))
  file = join(dir, OWNER_FILE)
  logs = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => JSON.parse(readFileSync(file, 'utf8')) as { pid: number; id: string; startedAt: unknown }
const holder = (pid: number, id = 'other') => writeFileSync(file, JSON.stringify({ pid, id, startedAt: 1 }))
/** The process ID of a child that has already exited. */
const exitedPid = () => spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid

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
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => 1 })
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
      const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => 1 })
      expect(owner.take(), bad).toBe(true)
      expect(read().pid, bad).toBe(process.pid)
      owner.release()
    }
    expect(logs).toEqual([])
  })

  test('losing the take-over race reads as another holder', () => {
    holder(exitedPid())
    // Between this server's removal and its create, another server makes the file again.
    afterRemove.run = () => holder(2222, 'winner')
    const owner = createOwnerFile({ dir, log })
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
    const never = createOwnerFile({ dir, log, alive: () => true, startTime: () => 1 })
    never.take()
    never.release()
    expect(readFileSync(file, 'utf8')).toBe(text)
  })
})

const STARTED = 1_000_000
const held = (pid: number, extra: object) => writeFileSync(file, JSON.stringify({ pid, id: 'other', ...extra }))

describe('a process ID in use by another program', () => {
  test('a process that started after the file was written is no server: take over', () => {
    held(4242, { startedAt: STARTED })
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => STARTED + 60_000 })
    expect(owner.take()).toBe(true)
    expect(read().pid).toBe(process.pid)
    expect(owner.check()).toBe(true)
    expect(logs).toEqual([])
  })

  test('a file that names this process, from an earlier one with its ID, is taken over', () => {
    held(process.pid, { startedAt: STARTED })
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => STARTED + 60_000 })
    expect(owner.take()).toBe(true)
  })

  test('a process that started before the file was written is the server: it keeps it', () => {
    held(4242, { startedAt: STARTED })
    const text = readFileSync(file, 'utf8')
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => STARTED - 500 })
    expect(owner.take()).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('4242')
    expect(logs[0]).toContain("won't auto-continue until it restarts")
    expect(logs[0]).not.toContain("can't read")
  })

  test('a small clock step never reads as a reused ID', () => {
    held(4242, { startedAt: STARTED })
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => STARTED + 1000 })
    expect(owner.take()).toBe(false)
  })

  test("a start time it can't read keeps today's behavior and says so once", () => {
    held(4242, { startedAt: STARTED })
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime: () => undefined })
    expect(owner.take()).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('4242')
    expect(logs[0]).toContain(dir)
    expect(logs[0]).toContain("can't read")
    expect(logs[0]).toContain("won't auto-continue until it restarts")
  })

  test('a reader that throws fails closed', () => {
    held(4242, { startedAt: STARTED })
    const owner = createOwnerFile({
      dir,
      log,
      alive: () => true,
      startTime: () => {
        throw new Error('boom')
      },
    })
    expect(owner.take()).toBe(false)
    expect(logs).toHaveLength(1)
  })

  test.each([[{}], [{ startedAt: 'x' }], [{ startedAt: null }], [{ startedAt: -1 }]])('a file with no usable startedAt stays with its holder: %j', (extra) => {
    held(4242, extra)
    const startTime = vi.fn(() => STARTED)
    const owner = createOwnerFile({ dir, log, alive: () => true, startTime })
    expect(owner.take()).toBe(false)
    expect(startTime).not.toHaveBeenCalled()
    expect(read().pid).toBe(4242)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("can't read")
  })

  test('starts no lookup with no file or a dead holder', () => {
    const startTime = vi.fn(() => undefined)
    const free = createOwnerFile({ dir, log, startTime })
    expect(free.take()).toBe(true)
    free.release()
    held(4242, { startedAt: STARTED })
    const stale = createOwnerFile({ dir, log, alive: () => false, startTime })
    expect(stale.take()).toBe(true)
    expect(startTime).not.toHaveBeenCalled()
  })
})

describe('processStartTime', () => {
  const env = { SystemRoot: 'C:\\Windows' }

  test('asks Windows PowerShell by absolute path, with no window and no shell', () => {
    const run = vi.fn<StartTimeRun>(() => ({ status: 0, stdout: '1793762042037\r\n' }))
    expect(processStartTime(4242, { platform: 'win32', env, run })).toBe(1793762042037)
    const [exe, args, options] = run.mock.calls[0]!
    expect(exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args.join(' ')).toContain('ProcessId=4242')
    // Win32_Process gives every account's start time with no elevation. Get-Process doesn't.
    expect(args.join(' ')).toContain('CreationDate')
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    expect(options).toMatchObject({ windowsHide: true, shell: false })
    expect(options.timeout).toBeGreaterThan(0)
  })

  test('reads SystemRoot in any case', () => {
    expect(processStartTime(1, { platform: 'win32', env: { SYSTEMROOT: 'D:\\Win' }, run: () => ({ status: 0, stdout: '5' }) })).toBe(5)
  })

  test.each([
    ['a failed run', { status: 1, stdout: '' }],
    ['a time-out', { status: null, stdout: '' }],
    ['text', { status: 0, stdout: 'Get-Process: nope' }],
    ['nothing', { status: 0, stdout: '' }],
  ])('%s reads as unknown', (_name, result) => {
    expect(processStartTime(1, { platform: 'win32', env, run: () => result })).toBeUndefined()
  })

  test('a run that throws reads as unknown', () => {
    const run: StartTimeRun = () => {
      throw new Error('spawn failed')
    }
    expect(processStartTime(1, { platform: 'win32', env, run })).toBeUndefined()
  })

  test.each([
    ['no SystemRoot', 'win32', {}],
    ['a SystemRoot that is no drive path', 'win32', { SystemRoot: 'Windows' }],
    ['another system', 'linux', env],
  ])('%s starts nothing', (_name, platform, e) => {
    const run = vi.fn<StartTimeRun>(() => ({ status: 0, stdout: '5' }))
    expect(processStartTime(1, { platform: platform as NodeJS.Platform, env: e as NodeJS.ProcessEnv, run })).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform === 'win32')('on the real process table', () => {
  /** A process of another account: `services.exe` runs as SYSTEM, and this only reads its ID and start time. */
  const servicePid = () => {
    const { stdout } = spawnSync('tasklist', ['/FI', 'IMAGENAME eq services.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    const found = /"services\.exe","(\d+)"/i.exec(stdout)
    if (!found) throw new Error(`no services.exe in: ${stdout}`)
    return Number(found[1])
  }

  /**
   * The real lookup, asked again while it can't answer. PowerShell can pass the lookup's 5 s limit on a busy machine,
   * and these tests are about what it reads, not about that limit.
   */
  const startTimeOf = (pid: number) => {
    for (let tries = 1; tries < 4; tries++) {
      const start = processStartTime(pid)
      if (start !== undefined) return start
    }
    return processStartTime(pid)
  }

  test('reads the start time of a process of another account', () => {
    const start = startTimeOf(servicePid())
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThanOrEqual(Date.now())
  }, 60_000)

  test('a stale file whose ID went to a service is taken over, with no log line', () => {
    // Fixed well before any boot of this machine, as a file left by an earlier boot is.
    const pid = servicePid()
    held(pid, { startedAt: Date.UTC(2020, 0, 1) })
    const owner = createOwnerFile({ dir, log })
    expect(owner.take()).toBe(true)
    expect(read().pid).toBe(process.pid)
    expect(logs).toEqual([])
    owner.release()
  }, 20_000)

  test('a file written after that process started still reads as held', () => {
    const pid = servicePid()
    held(pid, { startedAt: Date.now() })
    const owner = createOwnerFile({ dir, log, startTime: startTimeOf })
    expect(owner.take()).toBe(false)
    expect(logs).toEqual([expect.stringContaining(`process ${pid} runs auto-continue`)])
  }, 60_000)

  test('reads a real start time, and none for a process that is gone', () => {
    const start = startTimeOf(process.pid)
    // Against the process's own clock, so a time zone mistake in the lookup shows.
    expect(Math.abs(start! - (Date.now() - process.uptime() * 1000))).toBeLessThan(10_000)
    // On a busy machine Windows can give a gone process's ID straight to a new one, so a real time here means
    // that happened: ask again about another gone process.
    let gone = processStartTime(exitedPid())
    for (let tries = 1; gone !== undefined && tries < 5; tries++) gone = processStartTime(exitedPid())
    expect(gone).toBeUndefined()
  }, 60_000)

  test('a live program with a reused ID loses the file, and a live server keeps it', async () => {
    const written = Date.now() - 60_000
    const program = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    try {
      await new Promise((resolve) => program.once('spawn', resolve))
      held(program.pid!, { startedAt: written })
      const owner = createOwnerFile({ dir, log })
      expect(owner.take()).toBe(true)
      expect(read().pid).toBe(process.pid)
      expect(logs).toEqual([])
      owner.release()

      // This test's own process stands in for a server that wrote the file after it started.
      held(process.pid, { startedAt: Date.now() })
      const second = createOwnerFile({ dir, log })
      expect(second.take()).toBe(false)
      expect(logs).toHaveLength(1)
    } finally {
      program.kill()
    }
  }, 30_000)
})
