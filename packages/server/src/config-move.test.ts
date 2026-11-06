import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { moveOldConfig } from './config-move.ts'

/** The pid of a process that has ended: the old folder's server is gone. */
const DEAD_PID = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid!

// Temp folders only: `from` and `to` are always under a fresh mkdtemp root.
let root: string
let from: string
let to: string
let logs: string[]
let errors: string[]
const io = () => ({ log: (l: string) => void logs.push(l), error: (l: string) => void errors.push(l) })

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
const filesIn = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/'))
    .sort()

const OLD_FILES: Record<string, string> = {
  'config.json': '{"version":1,"repos":[{"path":"C:\\r"}]}\n',
  'session-token': 'tok\n',
  'auto-continue.json': '{"on":[]}\n',
  'actions.jsonl': '{"a":1}\n',
  'tool-paths.json': '{"gh":"C:\\gh.exe"}\n',
  'resume-logs/one.log': 'stderr one\n',
  'resume-logs/deep/two.log': 'stderr two\n',
  'auto-continue-owner.json': `{"pid":${DEAD_PID}}\n`,
}

const writeOld = async () => {
  for (const [name, text] of Object.entries(OLD_FILES)) {
    await mkdir(join(from, name, '..'), { recursive: true })
    await writeFile(join(from, name), text)
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'open-aflow-move-')))
  from = join(root, 'pod-board')
  to = join(root, 'open-aflow-server')
  logs = []
  errors = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('moveOldConfig', () => {
  test('copies every file but the owner file, and leaves the old folder as it was', async () => {
    await writeOld()
    expect(await moveOldConfig({ from, to, ...io() })).toBe('copied')
    const want = Object.keys(OLD_FILES).filter((n) => n !== 'auto-continue-owner.json').sort()
    expect(await filesIn(to)).toEqual(want)
    for (const name of want) expect(await readFile(join(to, name), 'utf8')).toBe(OLD_FILES[name])
    expect(await filesIn(from)).toEqual(Object.keys(OLD_FILES).sort())
  })

  test('logs one line that names both folders', async () => {
    await writeOld()
    await moveOldConfig({ from, to, ...io() })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^open-aflow: /)
    expect(logs[0]).toContain(from)
    expect(logs[0]).toContain(to)
    expect(errors).toEqual([])
  })

  test('never touches a new folder that exists, even an empty one', async () => {
    await writeOld()
    await mkdir(to)
    expect(await moveOldConfig({ from, to, ...io() })).toBe('kept')
    expect(await readdir(to)).toEqual([])
    expect(logs).toEqual([])
  })

  test('copies only once: a later change in the old folder stays there', async () => {
    await writeOld()
    await moveOldConfig({ from, to, ...io() })
    await writeFile(join(from, 'config.json'), '{"version":1,"repos":[]}\n')
    await writeFile(join(to, 'actions.jsonl'), '{"new":1}\n')
    expect(await moveOldConfig({ from, to, ...io() })).toBe('kept')
    expect(await readFile(join(to, 'config.json'), 'utf8')).toBe(OLD_FILES['config.json'])
    expect(await readFile(join(to, 'actions.jsonl'), 'utf8')).toBe('{"new":1}\n')
    expect(logs).toHaveLength(1)
  })

  test('does nothing with no old folder, or with none to copy from', async () => {
    expect(await moveOldConfig({ from, to, ...io() })).toBe('none')
    expect(await moveOldConfig({ from: undefined, to, ...io() })).toBe('none')
    expect(existsSync(to)).toBe(false)
    expect(logs).toEqual([])
    expect(errors).toEqual([])
  })

  test('an old folder a live server holds is not copied: the start runs there, and one line says so', async () => {
    await writeOld()
    await writeFile(join(from, 'auto-continue-owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    expect(await moveOldConfig({ from, to, ...io() })).toBe('in-use')
    expect(existsSync(to)).toBe(false)
    expect(await readdir(root)).toEqual(['pod-board'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(from)
    expect(logs[0]).toContain(String(process.pid))
  })

  test('an owner file with no usable pid does not hold the old folder', async () => {
    await writeOld()
    await writeFile(join(from, 'auto-continue-owner.json'), 'not json')
    expect(await moveOldConfig({ from, to, ...io() })).toBe('copied')
  })

  test('an old path that is a file, not a folder, copies nothing', async () => {
    await writeFile(from, 'not a folder')
    expect(await moveOldConfig({ from, to, ...io() })).toBe('none')
    expect(existsSync(to)).toBe(false)
  })

  /** A copyFile that throws `code` for each source `failFor` names, `times` times (default always). */
  const failing = (failFor: (src: string) => boolean, code: string, times = Infinity) => {
    const calls = new Map<string, number>()
    const fn = async (src: string, dest: string) => {
      const n = (calls.get(src) ?? 0) + 1
      calls.set(src, n)
      if (failFor(src) && n <= times) throw Object.assign(new Error(`${code}: no`), { code })
      await copyFile(src, dest)
    }
    return { fn, calls }
  }
  const fast = { tries: 5, waitMs: 1 }

  test('a needed file that stays unreadable fails the copy: no new folder, no part copy, and one line naming the file', async () => {
    await writeOld()
    const { fn, calls } = failing((s) => s === join(from, 'config.json'), 'EPERM')
    expect(await moveOldConfig({ from, to, copyFile: fn, retry: fast, ...io() })).toBe('failed')
    expect(calls.get(join(from, 'config.json'))).toBe(5)
    expect(existsSync(to)).toBe(false)
    expect(await readdir(root)).toEqual(['pod-board'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^open-aflow: /)
    for (const part of [from, to, 'config.json', 'EPERM']) expect(errors[0]).toContain(part)
    expect(logs).toEqual([])
    // The next start tries again, because nothing was kept.
    expect(await moveOldConfig({ from, to, ...io() })).toBe('copied')
  })

  test('a busy file that clears within the retries is copied', async () => {
    await writeOld()
    const { fn, calls } = failing((s) => s === join(from, 'actions.jsonl'), 'EBUSY', 2)
    expect(await moveOldConfig({ from, to, copyFile: fn, retry: fast, ...io() })).toBe('copied')
    expect(calls.get(join(from, 'actions.jsonl'))).toBe(3)
    expect(await readFile(join(to, 'actions.jsonl'), 'utf8')).toBe(OLD_FILES['actions.jsonl'])
    expect(errors).toEqual([])
  })

  test('the default retries wait about 2 s in all before a busy needed file fails', async () => {
    await writeOld()
    const { fn } = failing((s) => s === join(from, 'auto-continue.json'), 'EBUSY')
    const at = Date.now()
    expect(await moveOldConfig({ from, to, copyFile: fn, ...io() })).toBe('failed')
    const took = Date.now() - at
    expect(took).toBeGreaterThanOrEqual(1500)
    expect(took).toBeLessThan(4000)
  })

  test('an unreadable resume log is skipped and logged, and the copy still succeeds', async () => {
    await writeOld()
    const bad = join(from, 'resume-logs', 'one.log')
    const { fn, calls } = failing((s) => s === bad, 'EPERM')
    expect(await moveOldConfig({ from, to, copyFile: fn, retry: fast, ...io() })).toBe('copied')
    expect(calls.get(bad)).toBe(1)
    const want = Object.keys(OLD_FILES).filter((n) => n !== 'auto-continue-owner.json' && n !== 'resume-logs/one.log').sort()
    expect(await filesIn(to)).toEqual(want)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(bad)
    expect(errors[0]).toContain('EPERM')
    expect(logs).toHaveLength(1)
  })

  const hoursAgo = (h: number) => (Date.now() - h * 3600_000) / 1000

  test("part copies older than an hour are removed; a newer one may be another start's and stays", async () => {
    await writeOld()
    const stale = `${to}.moving-stale`
    const fresh = `${to}.moving-fresh`
    for (const dir of [stale, fresh]) {
      await mkdir(dir)
      await writeFile(join(dir, 'x.txt'), 'part')
    }
    await utimes(stale, hoursAgo(2), hoursAgo(2))
    expect(await moveOldConfig({ from, to, ...io() })).toBe('copied')
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(fresh, 'x.txt'))).toBe(true)
    expect(await filesIn(to)).not.toContain('x.txt')
  })

  test('the clean-up of old part copies also runs when the new folder exists', async () => {
    await mkdir(to)
    const stale = `${to}.moving-stale`
    await mkdir(stale)
    await utimes(stale, hoursAgo(2), hoursAgo(2))
    expect(await moveOldConfig({ from, to, ...io() })).toBe('kept')
    expect(existsSync(stale)).toBe(false)
  })

  test('two copies at once: one copies every file, the other keeps it, and no part copy is left', async () => {
    const names = Array.from({ length: 400 }, (_, i) => `resume-logs/r${i}.log`)
    for (let round = 0; round < 5; round++) {
      from = join(root, `old-${round}`)
      to = join(root, `new-${round}`)
      await mkdir(join(from, 'resume-logs'), { recursive: true })
      await writeFile(join(from, 'config.json'), '{}')
      await Promise.all(names.map((n) => writeFile(join(from, n), n)))
      const both = await Promise.all([moveOldConfig({ from, to, ...io() }), moveOldConfig({ from, to, ...io() })])
      expect(both.sort(), `round ${round}`).toEqual(['copied', 'kept'])
      expect(await filesIn(to), `round ${round}`).toEqual(['config.json', ...names].sort())
      expect((await readdir(root)).filter((n) => n.startsWith(`new-${round}.`)), `round ${round}`).toEqual([])
    }
    expect(errors).toEqual([])
  })
})
