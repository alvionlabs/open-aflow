import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { normalizeRepoPath } from './guard.ts'
import { addRepo, loadRepos, removeRepo } from './repos-config.ts'

const platform = process.platform
let root: string
let cfgDir: string
let file: string
let repoA: string
let repoB: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openaflow-d1-repos-'))
  cfgDir = join(root, 'cfg', 'nested')
  file = join(cfgDir, 'config.json')
  repoA = join(root, 'Repo A')
  repoB = join(root, 'repo-b')
  await mkdir(repoA)
  await mkdir(repoB)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('addRepo rules', () => {
  test('a missing config file reads as an empty list', async () => {
    expect(await loadRepos(file)).toEqual({ repos: [] })
  })

  test('adds, reloads, and creates the config folder', async () => {
    expect(await addRepo(file, repoA, platform)).toEqual({ path: normalizeRepoPath(repoA, platform) })
    expect(await addRepo(file, repoB + '/', platform)).toEqual({ path: normalizeRepoPath(repoB, platform) })
    expect(await loadRepos(file)).toEqual({
      repos: [normalizeRepoPath(repoA, platform), normalizeRepoPath(repoB, platform)],
    })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved).toEqual({
      version: 1,
      repos: [{ path: normalizeRepoPath(repoA, platform) }, { path: normalizeRepoPath(repoB, platform) }],
    })
    // The temp file used for the write is gone.
    expect(await readdir(cfgDir)).toEqual(['config.json'])
  })

  test('the same folder again is already registered, trailing slash or not', async () => {
    await addRepo(file, repoA, platform)
    const before = await readFile(file)
    expect(await addRepo(file, repoA, platform)).toEqual({ error: 'already registered' })
    expect(await addRepo(file, repoA + '/', platform)).toEqual({ error: 'already registered' })
    expect(await addRepo(file, join(repoA, '..', 'Repo A'), platform)).toEqual({ error: 'already registered' })
    expect(await readFile(file)).toEqual(before)
  })

  test.runIf(platform === 'win32')('on win32 another case or slash style is the same repo', async () => {
    await addRepo(file, repoA, 'win32')
    const before = await readFile(file)
    expect(await addRepo(file, repoA.toUpperCase(), 'win32')).toEqual({ error: 'already registered' })
    expect(await addRepo(file, repoA.toLowerCase().replaceAll('\\', '/') + '/', 'win32')).toEqual({
      error: 'already registered',
    })
    expect(await readFile(file)).toEqual(before)
    expect(await loadRepos(file)).toEqual({ repos: [normalizeRepoPath(repoA, 'win32')] })
  })

  test('another case is the same repo exactly where the real file system ignores case', async () => {
    await addRepo(file, repoB, platform)
    const other = join(root, 'REPO-B')
    // Independent check: does the other-case name reach the same folder?
    if (existsSync(other)) {
      expect(await addRepo(file, other, platform)).toEqual({ error: 'already registered' })
      expect(await loadRepos(file)).toEqual({ repos: [normalizeRepoPath(repoB, platform)] })
    } else {
      await mkdir(other)
      expect(await addRepo(file, other, platform)).toEqual({ path: normalizeRepoPath(other, platform) })
    }
  })

  test('a file system that keeps case makes another case another repo, whatever the OS', async () => {
    const other = join(root, 'REPO-B')
    if (!existsSync(other)) await mkdir(other)
    const asked: string[] = []
    const keepsCase = { ignoresCase: async (dir: string) => (asked.push(dir), false) }
    await addRepo(file, repoB, platform, keepsCase)
    expect(await addRepo(file, other, platform, keepsCase)).toEqual({ path: normalizeRepoPath(other, platform) })
    expect(asked).toContain(normalizeRepoPath(other, platform))
    // The exact same path is still the same repo.
    expect(await addRepo(file, repoB + '/', platform, keepsCase)).toEqual({ error: 'already registered' })
  })

  test('a file system that ignores case makes another case the same repo, whatever the OS', async () => {
    const other = join(root, 'REPO-B')
    if (!existsSync(other)) await mkdir(other)
    const ignores = { ignoresCase: async () => true }
    await addRepo(file, repoB, platform, ignores)
    const before = await readFile(file)
    expect(await addRepo(file, other, platform, ignores)).toEqual({ error: 'already registered' })
    expect(await readFile(file)).toEqual(before)
  })

  test('on win32 a network or device path is refused before the file system is asked', async () => {
    const asked: string[] = []
    const deps = {
      ignoresCase: async (dir: string) => (asked.push(`case ${dir}`), true),
      isDirectory: async (dir: string) => (asked.push(`stat ${dir}`), true),
    }
    const network = [
      '\\\\host\\share\\repo',
      '//host/share/repo',
      '\\/host/share',
      '/\\host\\share',
      '\\\\?\\C:\\repo',
      '\\\\.\\C:\\repo',
      '\\\\?\\UNC\\host\\share\\repo',
      '//?/C:/repo',
    ]
    for (const p of network) expect(await addRepo(file, p, 'win32', deps), p).toEqual({ error: 'not a local path' })
    expect(asked).toEqual([])
    expect(await readdir(root)).toEqual(expect.not.arrayContaining(['cfg']))
    // A drive path still goes on to the file system.
    const missing = { ...deps, isDirectory: async (d: string) => (asked.push(`stat ${d}`), false) }
    expect(await addRepo(file, 'C:\\repo', 'win32', missing)).toEqual({ error: 'not a directory' })
    expect(asked).toEqual(['stat C:\\repo'])
  })

  test('on POSIX any absolute path is local', async () => {
    const asked: string[] = []
    const deps = { ignoresCase: async () => false, isDirectory: async (d: string) => (asked.push(d), false) }
    expect(await addRepo(file, '/home/me/repo', 'linux', deps)).toEqual({ error: 'not a directory' })
    expect(asked).toEqual(['/home/me/repo'])
  })

  test('relative and missing paths are refused and nothing is written', async () => {
    expect(await addRepo(file, 'some/relative', platform)).toEqual({ error: 'not absolute' })
    expect(await addRepo(file, '.', platform)).toEqual({ error: 'not absolute' })
    expect(await addRepo(file, '', platform)).toEqual({ error: 'not absolute' })
    // On win32 a path needs a drive:`\x` and `C:x` hang off the current drive or folder.
    expect(await addRepo(file, '\\x', 'win32')).toEqual({ error: 'not absolute' })
    expect(await addRepo(file, '/x', 'win32')).toEqual({ error: 'not absolute' })
    expect(await addRepo(file, 'C:x', 'win32')).toEqual({ error: 'not absolute' })
    expect(await addRepo(file, join(root, 'gone'), platform)).toEqual({ error: 'not a directory' })
    const aFile = join(root, 'plain.txt')
    await writeFile(aFile, 'x')
    expect(await addRepo(file, aFile, platform)).toEqual({ error: 'not a directory' })
    // No config file and no config folder were created.
    expect(await readdir(root)).toEqual(expect.not.arrayContaining(['cfg']))

    await addRepo(file, repoA, platform)
    const before = await readFile(file)
    expect(await addRepo(file, 'rel', platform)).toEqual({ error: 'not absolute' })
    expect(await addRepo(file, join(root, 'gone'), platform)).toEqual({ error: 'not a directory' })
    expect(await readFile(file)).toEqual(before)
    expect(await readdir(cfgDir)).toEqual(['config.json'])
  })

  test('adds made at the same time all land', async () => {
    const dirs = await Promise.all(
      ['c1', 'c2', 'c3', 'c4', 'c5'].map(async (n) => {
        await mkdir(join(root, n))
        return join(root, n)
      }),
    )
    const results = await Promise.all([...dirs, dirs[0]!].map((d) => addRepo(file, d, platform)))
    expect(results.filter((r) => 'path' in r)).toHaveLength(5)
    expect(results.filter((r) => 'error' in r)).toEqual([{ error: 'already registered' }])
    const loaded = await loadRepos(file)
    expect('repos' in loaded && [...loaded.repos].sort()).toEqual(dirs.map((d) => normalizeRepoPath(d, platform)).sort())
  })
})

describe('never overwrites an unreadable config', () => {
  const bad = [
    '{not json',
    '',
    'null',
    '[]',
    '{"version":1}',
    '{"version":1,"repos":"x"}',
    '{"version":1,"repos":[{"path":3}]}',
    '{"version":1,"repos":[null]}',
    '{"version":2,"repos":[]}',
  ]

  for (const text of bad) {
    test(`a config of ${JSON.stringify(text)} is unreadable and stays byte for byte`, async () => {
      await mkdir(cfgDir, { recursive: true })
      await writeFile(file, text)
      const before = await readFile(file)
      expect(await loadRepos(file)).toEqual({ error: 'config unreadable' })
      expect(await addRepo(file, repoA, platform)).toEqual({ error: 'config unreadable' })
      expect(await readFile(file)).toEqual(before)
      expect(await readdir(cfgDir)).toEqual(['config.json'])
    })
  }

  test('a config path that is a folder is unreadable', async () => {
    await mkdir(file, { recursive: true })
    expect(await loadRepos(file)).toEqual({ error: 'config unreadable' })
    expect(await addRepo(file, repoA, platform)).toEqual({ error: 'config unreadable' })
    expect(await readdir(file)).toEqual([])
  })
})

describe('removeRepo', () => {
  const saved = async () => JSON.parse(await readFile(file, 'utf8')) as unknown
  const writeConfig = async (paths: string[]) => {
    await mkdir(cfgDir, { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, repos: paths.map((p) => ({ path: p })) }))
  }

  test('removes one of two, keeps the other, and leaves no temp file', async () => {
    await addRepo(file, repoA, platform)
    await addRepo(file, repoB, platform)
    expect(await removeRepo(file, repoA, platform)).toEqual({ path: normalizeRepoPath(repoA, platform) })
    expect(await saved()).toEqual({ version: 1, repos: [{ path: normalizeRepoPath(repoB, platform) }] })
    expect(await loadRepos(file)).toEqual({ repos: [normalizeRepoPath(repoB, platform)] })
    expect(await readdir(cfgDir)).toEqual(['config.json'])
  })

  test('removing the last repo leaves an empty list, not a missing file', async () => {
    await addRepo(file, repoA, platform)
    expect(await removeRepo(file, repoA, platform)).toEqual({ path: normalizeRepoPath(repoA, platform) })
    expect(await saved()).toEqual({ version: 1, repos: [] })
  })

  test('never touches the repo folder', async () => {
    await writeFile(join(repoA, 'keep.md'), 'mine')
    await addRepo(file, repoA, platform)
    await removeRepo(file, repoA, platform)
    expect(await readdir(repoA)).toEqual(['keep.md'])
    expect(await readFile(join(repoA, 'keep.md'), 'utf8')).toBe('mine')
  })

  test('matches by normalized path: a trailing slash or a .. part is the same repo', async () => {
    await addRepo(file, repoA, platform)
    await addRepo(file, repoB, platform)
    expect(await removeRepo(file, repoA + '/', platform)).toEqual({ path: normalizeRepoPath(repoA, platform) })
    expect(await removeRepo(file, join(repoB, '..', 'repo-b'), platform)).toEqual({ path: normalizeRepoPath(repoB, platform) })
    expect(await saved()).toEqual({ version: 1, repos: [] })
  })

  test('a file system that ignores case removes another spelling; one that keeps case does not', async () => {
    await writeConfig([normalizeRepoPath(repoB, platform)])
    const other = join(root, 'REPO-B')
    const before = await readFile(file)
    expect(await removeRepo(file, other, platform, { ignoresCase: async () => false })).toEqual({ error: 'not registered' })
    expect(await readFile(file)).toEqual(before)
    expect(await removeRepo(file, other, platform, { ignoresCase: async () => true })).toEqual({ path: normalizeRepoPath(other, platform) })
    expect(await saved()).toEqual({ version: 1, repos: [] })
  })

  test.runIf(platform === 'win32')('on win32 another case or slash style is the same repo', async () => {
    await addRepo(file, repoA, 'win32')
    expect(await removeRepo(file, repoA.toLowerCase().replaceAll('\\', '/') + '/', 'win32')).toEqual({
      path: normalizeRepoPath(repoA.toLowerCase(), 'win32'),
    })
    expect(await saved()).toEqual({ version: 1, repos: [] })
  })

  test('removes every hand-edited spelling of the same repo', async () => {
    await writeConfig([repoA, repoA + '/', normalizeRepoPath(repoB, platform)])
    await removeRepo(file, repoA, platform)
    expect(await saved()).toEqual({ version: 1, repos: [{ path: normalizeRepoPath(repoB, platform) }] })
  })

  test('removes an entry whose folder is gone', async () => {
    const gone = join(root, 'gone')
    await writeConfig([gone, normalizeRepoPath(repoA, platform)])
    expect(await removeRepo(file, gone, platform)).toEqual({ path: normalizeRepoPath(gone, platform) })
    expect(await saved()).toEqual({ version: 1, repos: [{ path: normalizeRepoPath(repoA, platform) }] })
  })

  test('a repo not in the list is not registered, and nothing is written', async () => {
    expect(await removeRepo(file, repoA, platform)).toEqual({ error: 'not registered' })
    expect(await readdir(root)).toEqual(expect.not.arrayContaining(['cfg']))
    await addRepo(file, repoB, platform)
    const before = await readFile(file)
    expect(await removeRepo(file, repoA, platform)).toEqual({ error: 'not registered' })
    expect(await readFile(file)).toEqual(before)
    expect(await readdir(cfgDir)).toEqual(['config.json'])
  })

  test('removes by path from the file as it is now, not as it was loaded', async () => {
    await addRepo(file, repoA, platform)
    await addRepo(file, repoB, platform)
    expect(await loadRepos(file)).toEqual({ repos: [normalizeRepoPath(repoA, platform), normalizeRepoPath(repoB, platform)] })
    // Someone edits the file by hand after the board read it.
    const added = join(root, 'repo-c')
    await writeConfig([normalizeRepoPath(repoB, platform), added])
    expect(await removeRepo(file, repoB, platform)).toEqual({ path: normalizeRepoPath(repoB, platform) })
    expect(await saved()).toEqual({ version: 1, repos: [{ path: added }] })
    // A repo the hand edit already took out is not registered.
    expect(await removeRepo(file, repoA, platform)).toEqual({ error: 'not registered' })
  })

  test('two removes of the same repo at once: one removes, the other finds it gone', async () => {
    await addRepo(file, repoA, platform)
    await addRepo(file, repoB, platform)
    const results = await Promise.all([removeRepo(file, repoA, platform), removeRepo(file, repoA, platform)])
    expect(results).toEqual([{ path: normalizeRepoPath(repoA, platform) }, { error: 'not registered' }])
    expect(await saved()).toEqual({ version: 1, repos: [{ path: normalizeRepoPath(repoB, platform) }] })
  })

  test('removes of two repos at once both land', async () => {
    await addRepo(file, repoA, platform)
    await addRepo(file, repoB, platform)
    await Promise.all([removeRepo(file, repoA, platform), removeRepo(file, repoB, platform)])
    expect(await saved()).toEqual({ version: 1, repos: [] })
  })

  test('adds and removes made at the same time share one queue, so none is lost', async () => {
    await addRepo(file, repoA, platform)
    const c = join(root, 'repo-c')
    await mkdir(c)
    await Promise.all([addRepo(file, repoB, platform), removeRepo(file, repoA, platform), addRepo(file, c, platform)])
    expect(await saved()).toEqual({ version: 1, repos: [{ path: normalizeRepoPath(repoB, platform) }, { path: normalizeRepoPath(c, platform) }] })
  })

  for (const text of ['{not json', '', '[]', '{"version":2,"repos":[]}']) {
    test(`a config of ${JSON.stringify(text)} is unreadable and stays byte for byte`, async () => {
      await mkdir(cfgDir, { recursive: true })
      await writeFile(file, text)
      const before = await readFile(file)
      expect(await removeRepo(file, repoA, platform)).toEqual({ error: 'config unreadable' })
      expect(await readFile(file)).toEqual(before)
      expect(await readdir(cfgDir)).toEqual(['config.json'])
    })
  }
})
