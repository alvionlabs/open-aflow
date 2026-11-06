import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { moveOldConfig } from './config-move.ts'

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
  'auto-continue-owner.json': '{"pid":1}\n',
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

  test('an old path that is a file, not a folder, copies nothing', async () => {
    await writeFile(from, 'not a folder')
    expect(await moveOldConfig({ from, to, ...io() })).toBe('none')
    expect(existsSync(to)).toBe(false)
  })

  test('a failed copy resolves, leaves no new folder and no part copy, and logs the failure', async () => {
    await writeOld()
    const copy = async (_f: string, dest: string) => {
      await mkdir(dest, { recursive: true })
      await writeFile(join(dest, 'config.json'), 'half')
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    expect(await moveOldConfig({ from, to, copy, ...io() })).toBe('failed')
    expect(existsSync(to)).toBe(false)
    expect(await readdir(root)).toEqual(['pod-board'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^open-aflow: /)
    expect(errors[0]).toContain(from)
    expect(errors[0]).toContain(to)
    expect(errors[0]).toContain('EPERM')
    expect(logs).toEqual([])
    // The next start tries again, because nothing was kept.
    expect(await moveOldConfig({ from, to, ...io() })).toBe('copied')
  })

  test("a part copy left by a crash never merges in, and isn't removed: it may be another start's", async () => {
    await writeOld()
    const stale = `${to}.moving`
    await mkdir(stale)
    await writeFile(join(stale, 'stale.txt'), 'old crash')
    expect(await moveOldConfig({ from, to, ...io() })).toBe('copied')
    expect(await filesIn(to)).not.toContain('stale.txt')
    expect(existsSync(join(stale, 'stale.txt'))).toBe(true)
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
