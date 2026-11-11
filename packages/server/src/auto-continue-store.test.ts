import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAutoContinueStore } from './auto-continue-store.ts'

let root: string
let file: string

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'openaflow-s1-store-')))
  file = join(root, 'cfg', 'auto-continue.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const saved = () => JSON.parse(readFileSync(file, 'utf8')) as unknown
const put = (text: string) => {
  mkdirSync(join(root, 'cfg'), { recursive: true })
  writeFileSync(file, text)
}

describe('auto-continue store', () => {
  test('forgetPath forgets every toggle of that path, saved, and keeps the rest', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/old', 'alpha', true)
    await store.set('/old', 'beta', true)
    await store.set('/keep', 'alpha', true)
    await store.forgetPath('/old')
    expect(store.list()).toEqual([{ path: '/keep', run: 'alpha' }])
    expect(saved()).toEqual({ runs: [{ path: '/keep', run: 'alpha' }] })
    expect(createAutoContinueStore({ file }).list()).toEqual([{ path: '/keep', run: 'alpha' }])
  })

  test('forgetPath with nothing to forget writes nothing, and a failed write changes nothing', async () => {
    let writes = 0
    put(JSON.stringify({ runs: [{ path: '/r1', run: 'alpha' }] }))
    const store = createAutoContinueStore({
      file,
      write: async () => {
        writes += 1
        throw new Error('disk full')
      },
    })
    await store.forgetPath('/none')
    expect(writes).toBe(0)
    await expect(store.forgetPath('/r1')).rejects.toThrow('disk full')
    expect(store.list()).toEqual([{ path: '/r1', run: 'alpha' }])
  })

  test('a toggle with no path reads off', () => {
    put(JSON.stringify({ runs: [{ repoId: 'old', run: 'alpha' }, { path: '/r', run: 'alpha' }, { path: 7, run: 'beta' }] }))
    expect(createAutoContinueStore({ file }).list()).toEqual([{ path: '/r', run: 'alpha' }])
  })

  test('reads fail closed and writes atomically', async () => {
    // Missing → all off.
    expect(createAutoContinueStore({ file }).list()).toEqual([])

    // Bad JSON, or the wrong shape → all off.
    for (const text of ['{', '', 'null', '[]', '{"runs":{}}', '{"runs":"x"}', '42']) {
      put(text)
      expect(createAutoContinueStore({ file }).list(), text).toEqual([])
    }

    // Bad entries are skipped; good ones kept, in order; a repeat of one run is dropped.
    put(
      JSON.stringify({
        runs: [
          { path: 'r1', run: 'alpha', lastKey: 'wave-merged:7' },
          null,
          'x',
          { path: 'r1' },
          { run: 'alpha' },
          { repoId: 7, run: 'alpha' },
          { path: 'r1', run: 'beta', lastKey: 9 },
          { path: 'r2', run: 'fix-scroll' },
          { path: 'r1', run: 'alpha', lastKey: 'other' },
        ],
      }),
    )
    const store = createAutoContinueStore({ file })
    expect(store.list()).toEqual([
      { path: 'r1', run: 'alpha', lastKey: 'wave-merged:7' },
      { path: 'r2', run: 'fix-scroll' },
    ])

    // The next write replaces the bad file with good JSON.
    await store.set('r3', 'gamma', true)
    expect(saved()).toEqual({
      runs: [
        { path: 'r1', run: 'alpha', lastKey: 'wave-merged:7' },
        { path: 'r2', run: 'fix-scroll' },
        { path: 'r3', run: 'gamma' },
      ],
    })

    // On again clears lastKey (how to retry a failed send); off removes.
    await store.set('r1', 'alpha', true)
    expect(store.list()).toContainEqual({ path: 'r1', run: 'alpha' })
    expect(store.list().find((t) => t.run === 'alpha')).not.toHaveProperty('lastKey')
    await store.set('r2', 'fix-scroll', false)
    expect(store.list().map((t) => t.run)).toEqual(['alpha', 'gamma'])
    // Off for a run that has no toggle is a no-op.
    await store.set('r9', 'nope', false)
    expect(store.list().map((t) => t.run)).toEqual(['alpha', 'gamma'])

    // saveKey sets the key of a toggle that exists, and does nothing for one that doesn't.
    expect(await store.saveKey('r3', 'gamma', 'sprint-done:one')).toBe(true)
    expect(await store.saveKey('r9', 'nope', 'x')).toBe(false)
    expect(store.list()).toContainEqual({ path: 'r3', run: 'gamma', lastKey: 'sprint-done:one' })

    // A new store on the same file (a restart) reads what was saved.
    expect(createAutoContinueStore({ file }).list()).toEqual(store.list())

    // Written atomically: no temp files are left beside it.
    expect(readdirSync(join(root, 'cfg'))).toEqual(['auto-continue.json'])
    // Owner-only on POSIX.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('remembers the answered keys it sent, bounded', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('r1', 'alpha', true)
    // An answered key is the lastKey and joins answeredKeys; another key moves lastKey only.
    expect(await store.saveKey('r1', 'alpha', 'answered:alpha:1:aaaaaaaa')).toBe(true)
    expect(await store.saveKey('r1', 'alpha', 'sprint-done:one')).toBe(true)
    expect(store.list()).toEqual([{ path: 'r1', run: 'alpha', lastKey: 'sprint-done:one', answeredKeys: ['answered:alpha:1:aaaaaaaa'] }])
    // The same answered key again isn't listed twice.
    await store.saveKey('r1', 'alpha', 'answered:alpha:1:aaaaaaaa')
    expect(store.list()[0]?.answeredKeys).toEqual(['answered:alpha:1:aaaaaaaa'])
    // A restart reads them back.
    expect(createAutoContinueStore({ file }).list()).toEqual(store.list())
    // At most 20, the newest kept.
    for (let i = 0; i < 25; i++) await store.saveKey('r1', 'alpha', `answered:alpha:1:${String(i).padStart(8, '0')}`)
    const keys = store.list()[0]?.answeredKeys ?? []
    expect(keys).toHaveLength(20)
    expect(keys.at(-1)).toBe('answered:alpha:1:00000024')
    expect(keys).not.toContain('answered:alpha:1:aaaaaaaa')
    // A bad answeredKeys in the file is dropped, the toggle kept.
    put(JSON.stringify({ runs: [{ path: 'r1', run: 'alpha', answeredKeys: 'x' }, { path: 'r2', run: 'beta', answeredKeys: ['ok', 7] }] }))
    expect(createAutoContinueStore({ file }).list()).toEqual([
      { path: 'r1', run: 'alpha' },
      { path: 'r2', run: 'beta', answeredKeys: ['ok'] },
    ])
  })

  test('marks a failed send of the last key, until a send starts', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('r1', 'alpha', true)
    // Nothing to mark with no key, or for another key, or for no toggle.
    expect(await store.saveFailed('r1', 'alpha', 'fix-merged:36')).toBe(false)
    await store.saveKey('r1', 'alpha', 'fix-merged:36')
    expect(await store.saveFailed('r1', 'alpha', 'fix-merged:99')).toBe(false)
    expect(await store.saveFailed('r9', 'nope', 'fix-merged:36')).toBe(false)
    expect(store.list()).toEqual([{ path: 'r1', run: 'alpha', lastKey: 'fix-merged:36' }])

    expect(await store.saveFailed('r1', 'alpha', 'fix-merged:36')).toBe(true)
    expect(store.list()).toEqual([{ path: 'r1', run: 'alpha', lastKey: 'fix-merged:36', lastFailed: true }])
    // A restart reads it back.
    expect(createAutoContinueStore({ file }).list()).toEqual(store.list())

    // A new send, of this key or another, clears it; so does turning the toggle on again.
    await store.saveKey('r1', 'alpha', 'fix-merged:36')
    expect(store.list()).toEqual([{ path: 'r1', run: 'alpha', lastKey: 'fix-merged:36' }])
    await store.saveFailed('r1', 'alpha', 'fix-merged:36')
    await store.set('r1', 'alpha', true)
    expect(store.list()).toEqual([{ path: 'r1', run: 'alpha' }])

    // In the file, only `true` with a key counts.
    put(JSON.stringify({ runs: [{ path: 'r1', run: 'alpha', lastFailed: true }, { path: 'r2', run: 'beta', lastKey: 'k', lastFailed: 'yes' }] }))
    expect(createAutoContinueStore({ file }).list()).toEqual([
      { path: 'r1', run: 'alpha' },
      { path: 'r2', run: 'beta', lastKey: 'k' },
    ])
  })

  test('a failed write keeps the file and the toggles', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('r1', 'alpha', true)
    const before = readFileSync(file, 'utf8')

    const failing = createAutoContinueStore({
      file,
      write: async () => {
        throw new Error('disk full')
      },
    })
    await expect(failing.set('r1', 'beta', true)).rejects.toThrow('disk full')
    await expect(failing.set('r1', 'alpha', false)).rejects.toThrow('disk full')
    await expect(failing.saveKey('r1', 'alpha', 'k')).rejects.toThrow('disk full')
    expect(failing.list()).toEqual([{ path: 'r1', run: 'alpha' }])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('a rename that fails leaves no temp file', async () => {
    // A folder where the file should be: reads fail closed, and the rename over it fails.
    mkdirSync(file, { recursive: true })
    const store = createAutoContinueStore({ file })
    expect(store.list()).toEqual([])
    await expect(store.set('r1', 'alpha', true)).rejects.toThrow()
    expect(store.list()).toEqual([])
    expect(readdirSync(join(root, 'cfg'))).toEqual(['auto-continue.json'])
  })

  test('writes run one at a time', async () => {
    const store = createAutoContinueStore({ file })
    await Promise.all([store.set('r1', 'a', true), store.set('r1', 'b', true), store.set('r1', 'c', true)])
    expect(store.list().map((t) => t.run)).toEqual(['a', 'b', 'c'])
    expect(saved()).toEqual({ runs: store.list() })
  })
})
