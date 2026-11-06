import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRealConfigReader, proofPlace, refuseRealInstall, stateDiff, withInstallLock, type MachineState } from './install-check.ts'

let dir: string

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'open-aflow-install-check-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const clean = (): MachineState => ({ uninstallKeys: [], runValue: null, startMenu: [], apps: [], updaterCache: false, realConfig: ['config.json 1'] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A process ID that has already ended. */
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true }).stdout.trim())

describe('stateDiff', () => {
  test('stateDiff names each leftover', () => {
    expect(stateDiff(clean(), clean())).toEqual([])

    const cases: [Partial<MachineState>, RegExp][] = [
      [{ uninstallKeys: ['HKEY_CURRENT_USER\\key-a'] }, /uninstall key.*key-a/],
      [{ runValue: '"x.exe" --hidden' }, /Run value.*x\.exe/],
      [{ startMenu: ['C:\\sm\\Open AFlow.lnk'] }, /Start-menu.*Open AFlow\.lnk/],
      [{ apps: [4242] }, /app process.*4242/],
      [{ updaterCache: true }, /updater cache/],
      [{ realConfig: ['config.json 1', 'new.json 5'] }, /real config.*new\.json/],
      [{ realConfig: ['config.json 2'] }, /real config.*config\.json/],
      [{ realConfig: [] }, /real config.*config\.json/],
    ]
    for (const [change, line] of cases) {
      const diff = stateDiff(clean(), { ...clean(), ...change })
      expect(diff, String(line)).toHaveLength(1)
      expect(diff[0]).toMatch(line)
    }
  })

  test('a folder that first appears during the proof is a leftover', () => {
    expect(stateDiff({ ...clean(), realConfig: null }, { ...clean(), realConfig: ['config.json 3'] })[0]).toMatch(/real config.*config\.json/)
    expect(stateDiff({ ...clean(), realConfig: null }, { ...clean(), realConfig: null })).toEqual([])
  })

  test('what was there before is no leftover', () => {
    const before = { ...clean(), apps: [7], runValue: 'x', updaterCache: true }
    expect(stateDiff(before, { ...before })).toEqual([])
  })

  test('every leftover gets its own line', () => {
    expect(stateDiff(clean(), { ...clean(), uninstallKeys: ['a', 'b'], apps: [1, 2] })).toHaveLength(4)
  })
})

describe('the real config folder', () => {
  const owner = (pid: number) => writeFileSync(join(dir, 'auto-continue-owner.json'), JSON.stringify({ pid, id: 'x' }))

  test("a live server's folder is left out", () => {
    writeFileSync(join(dir, 'config.json'), '{}')

    owner(process.pid)
    expect(createRealConfigReader(dir)()).toEqual({ files: null, held: true })

    owner(deadPid())
    const stale = createRealConfigReader(dir)()
    expect(stale.held).toBe(false)
    expect(stale.files?.map((f) => f.split(' ')[0]).sort()).toEqual(['auto-continue-owner.json', 'config.json'])

    writeFileSync(join(dir, 'auto-continue-owner.json'), 'not json')
    expect(createRealConfigReader(dir)().held).toBe(false)
  })

  test('the first read decides for the whole proof', () => {
    writeFileSync(join(dir, 'config.json'), '{}')
    owner(process.pid)
    const read = createRealConfigReader(dir)
    expect(read().files).toBeNull()
    // The server ends during the proof. Both states still read null, so the diff can't name its files.
    owner(deadPid())
    expect(read()).toEqual({ files: null, held: true })
  })

  test('no folder reads null, and is not held', () => {
    expect(createRealConfigReader(join(dir, 'no-such-folder'))()).toEqual({ files: null, held: false })
  })

  test("a file carries its modified time, a subfolder's files included", () => {
    mkdirSync(join(dir, 'resume-logs'))
    writeFileSync(join(dir, 'resume-logs', 'a.log'), 'x')
    writeFileSync(join(dir, 'config.json'), '{}')
    const read = createRealConfigReader(dir)
    const before = read().files!
    expect(before.some((f) => f.startsWith('resume-logs/a.log '))).toBe(true)
    utimesSync(join(dir, 'config.json'), new Date(1000), new Date(1000))
    expect(read().files).not.toEqual(before)
  })
})

describe('refuseRealInstall', () => {
  test('refuses a real install', () => {
    expect(() => refuseRealInstall(clean())).not.toThrow()
    expect(() => refuseRealInstall({ ...clean(), realConfig: null, updaterCache: true })).not.toThrow()
    expect(() => refuseRealInstall({ ...clean(), uninstallKeys: ['HKEY_CURRENT_USER\\the-key'] })).toThrow(/the-key/)
    expect(() => refuseRealInstall({ ...clean(), startMenu: ['C:\\sm\\Open AFlow.lnk'] })).toThrow(/Open AFlow\.lnk/)
    expect(() => refuseRealInstall({ ...clean(), runValue: '"C:\\real\\Open AFlow.exe" --hidden' })).toThrow(/Run value/)
    expect(() => refuseRealInstall({ ...clean(), apps: [99] })).toThrow(/99/)
  })
})

describe('proofPlace', () => {
  test('its folders sit inside one temp root, and the env points at them', () => {
    const place = proofPlace(3110)
    try {
      expect(basename(place.root)).toMatch(/^open-aflow-install-proof-/)
      expect(realpathSync.native(place.root)).toBe(place.root)
      expect(place.port).toBe(3110)
      expect(place.installDir.startsWith(place.root)).toBe(true)
      for (const name of ['OPEN_AFLOW_CONFIG_DIR', 'OPEN_AFLOW_DESKTOP_DATA_DIR', 'OPEN_AFLOW_PORTS_DIR', 'OPEN_AFLOW_CLAUDE_DIR']) {
        expect(place.env[name]?.startsWith(place.root), name).toBe(true)
        expect(existsSync(place.env[name]!), name).toBe(true)
      }
      expect(place.env.OPEN_AFLOW_API_PORT).toBe('3110')
      // Never the real claude: this path has no file.
      expect(place.env.OPEN_AFLOW_CLAUDE_BIN?.startsWith(place.root)).toBe(true)
      expect(existsSync(place.env.OPEN_AFLOW_CLAUDE_BIN!)).toBe(false)
      expect(place.env.SystemRoot ?? place.env.SYSTEMROOT).toBeTruthy()
      expect(place.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(Object.keys(place.env).filter((k) => k.toUpperCase().startsWith('VITEST'))).toEqual([])
    } finally {
      rmSync(place.root, { recursive: true, force: true })
    }
  })
})

describe('withInstallLock', () => {
  const opts = () => ({ path: join(dir, 'lock'), pollMs: 10, waitMs: 5000 })

  /** Runs `count` jobs at once and answers the most holders seen at one time. */
  const contend = async (count: number) => {
    let holders = 0
    let most = 0
    const job = () =>
      withInstallLock(async () => {
        holders++
        most = Math.max(most, holders)
        await sleep(25)
        holders--
      }, opts())
    await Promise.all(Array.from({ length: count }, job))
    return most
  }

  test('install lock', async () => {
    // One holder at a time.
    expect(await contend(3)).toBe(1)
    expect(existsSync(opts().path)).toBe(false)

    // A stale holder is taken over.
    writeFileSync(opts().path, String(deadPid()))
    await expect(withInstallLock(async () => 'took over', opts())).resolves.toBe('took over')

    // A throw frees it, and the error comes through.
    await expect(withInstallLock(() => Promise.reject(new Error('boom')), opts())).rejects.toThrow('boom')
    expect(existsSync(opts().path)).toBe(false)
    await expect(withInstallLock(async () => 'free', opts())).resolves.toBe('free')
  })

  test('a live holder is waited for, up to the limit', async () => {
    writeFileSync(opts().path, String(process.pid))
    await expect(withInstallLock(async () => 'never', { ...opts(), waitMs: 60 })).rejects.toThrow(new RegExp(String(process.pid)))
    // The live holder's lock stays.
    expect(existsSync(opts().path)).toBe(true)
  })

  test('waiters on one stale lock give one holder at a time', async () => {
    writeFileSync(opts().path, String(deadPid()))
    expect(await contend(4)).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })

  test('a lock with no process ID is stale only once it is old', async () => {
    writeFileSync(opts().path, '')
    await expect(withInstallLock(async () => 'x', { ...opts(), waitMs: 60 })).rejects.toThrow(/lock/)
    utimesSync(opts().path, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    await expect(withInstallLock(async () => 'old', opts())).resolves.toBe('old')
  })
})
