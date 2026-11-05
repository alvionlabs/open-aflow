import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  claudeDir,
  createAgentFileCache,
  createSessionCwdCache,
  firstCwdOfFile,
  createClaimedSessionScan,
  listAgentFiles,
  projectDirName,
  readAgentFile,
  transcriptDays,
} from './transcript-files.ts'

const DAY = 24 * 60 * 60 * 1000

describe('transcript settings', () => {
  test('claudeDir: POD_BOARD_CLAUDE_DIR, else CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeDir({ POD_BOARD_CLAUDE_DIR: '/a', CLAUDE_CONFIG_DIR: '/b' }, '/home/me')).toBe('/a')
    expect(claudeDir({ CLAUDE_CONFIG_DIR: '/b' }, '/home/me')).toBe('/b')
    expect(claudeDir({ POD_BOARD_CLAUDE_DIR: '', CLAUDE_CONFIG_DIR: '' }, 'home')).toBe(join('home', '.claude'))
    expect(claudeDir({}, 'home')).toBe(join('home', '.claude'))
  })

  test('transcriptDays: POD_BOARD_TRANSCRIPT_DAYS, default 30, bad values throw', () => {
    expect(transcriptDays({})).toBe(30)
    expect(transcriptDays({ POD_BOARD_TRANSCRIPT_DAYS: '' })).toBe(30)
    expect(transcriptDays({ POD_BOARD_TRANSCRIPT_DAYS: '7' })).toBe(7)
    for (const bad of ['0', '-1', 'abc', '1.5', ' 7', '1e3']) {
      expect(() => transcriptDays({ POD_BOARD_TRANSCRIPT_DAYS: bad }), bad).toThrowError(/POD_BOARD_TRANSCRIPT_DAYS/)
    }
  })
})

describe('finds agent transcripts', () => {
  let claude: string
  const repoPath = 'E:\\Projects\\chess-web'
  const now = Date.UTC(2026, 9, 18, 12)

  beforeEach(async () => {
    claude = await mkdtemp(join(tmpdir(), 'pod-board-d1-claude-'))
  })
  afterEach(async () => {
    await rm(claude, { recursive: true, force: true })
  })

  const projectDir = () => join(claude, 'projects', 'E--Projects-chess-web')

  /** Makes `<session>/subagents/` with the given files and dates both folders `changedAt`. */
  async function session(name: string, changedAt: number, files: Record<string, string>): Promise<void> {
    const sub = join(projectDir(), name, 'subagents')
    await mkdir(sub, { recursive: true })
    for (const [file, text] of Object.entries(files)) await writeFile(join(sub, file), text)
    const t = new Date(changedAt)
    await utimes(sub, t, t)
    await utimes(join(projectDir(), name), t, t)
  }

  test('projectDirName maps a Windows and a POSIX path', () => {
    expect(projectDirName('E:\\Projects\\chess-web')).toBe('E--Projects-chess-web')
    expect(projectDirName('E:/Projects/chess-web')).toBe('E--Projects-chess-web')
    expect(projectDirName('/home/me/my repo.v2')).toBe('-home-me-my-repo-v2')
  })

  test('missing folders give []', async () => {
    expect(await listAgentFiles(join(claude, 'nope'), repoPath, 30, now)).toEqual([])
    expect(await listAgentFiles(claude, repoPath, 30, now)).toEqual([])
    await mkdir(join(projectDir(), 's-empty'), { recursive: true })
    expect(await listAgentFiles(claude, repoPath, 30, now)).toEqual([])
  })

  test('lists agents of sessions changed within the window, sorted', async () => {
    await session('s-new', now - DAY, {
      'agent-b2.jsonl': '{}\n',
      'agent-b2.meta.json': '{"agentType":"pod:engineer"}',
      'agent-a1.jsonl': '{}\n',
      'agent-a1.meta.json': '{}',
      'agent-c3.jsonl': '{}\n', // no meta file
      'agent-d4.meta.json': '{}', // no transcript
      'notes.txt': 'x',
      'agent-.jsonl': '{}',
    })
    await session('s-edge', now - 29.9 * DAY, { 'agent-e5.jsonl': '{}\n' })
    await session('s-old', now - 30.1 * DAY, { 'agent-o1.jsonl': '{}\n', 'agent-o1.meta.json': '{}' })
    // The session folder is old but a new agent was added to subagents/ today.
    await session('s-mixed', now - 40 * DAY, { 'agent-m1.jsonl': '{}\n' })
    await utimes(join(projectDir(), 's-mixed', 'subagents'), new Date(now - DAY), new Date(now - DAY))
    // Another project's sessions are never listed.
    await mkdir(join(claude, 'projects', 'E--Projects-other', 's-x', 'subagents'), { recursive: true })
    await writeFile(join(claude, 'projects', 'E--Projects-other', 's-x', 'subagents', 'agent-x.jsonl'), '{}')

    const found = await listAgentFiles(claude, repoPath, 30, now)
    const sub = (s: string) => join(projectDir(), s, 'subagents')
    expect(found).toEqual([
      { id: 'e5', session: 's-edge', jsonlPath: join(sub('s-edge'), 'agent-e5.jsonl'), metaPath: join(sub('s-edge'), 'agent-e5.meta.json') },
      { id: 'm1', session: 's-mixed', jsonlPath: join(sub('s-mixed'), 'agent-m1.jsonl'), metaPath: join(sub('s-mixed'), 'agent-m1.meta.json') },
      { id: 'a1', session: 's-new', jsonlPath: join(sub('s-new'), 'agent-a1.jsonl'), metaPath: join(sub('s-new'), 'agent-a1.meta.json') },
      { id: 'b2', session: 's-new', jsonlPath: join(sub('s-new'), 'agent-b2.jsonl'), metaPath: join(sub('s-new'), 'agent-b2.meta.json') },
      { id: 'c3', session: 's-new', jsonlPath: join(sub('s-new'), 'agent-c3.jsonl'), metaPath: join(sub('s-new'), 'agent-c3.meta.json') },
    ])
    // A shorter window leaves out more.
    expect((await listAgentFiles(claude, repoPath, 2, now)).map((f) => f.id)).toEqual(['m1', 'a1', 'b2', 'c3'])
  })

  describe('a session past the window that a fix claim names', () => {
    const OLD = () => now - 40 * 24 * 60 * 60_000
    const agent = (branch: string) => ({ 'agent-e.jsonl': JSON.stringify({ type: 'user', message: { content: `- **branch name:** ${branch}\n` } }) + '\n', 'agent-r.jsonl': '{"type":"user"}\n' })
    const ids = async (names: string[], scan = createClaimedSessionScan()) => (await listAgentFiles(claude, repoPath, 30, now, { names, scan })).map((f) => `${f.session}/${f.id}`)

    test('comes back whole, and only that session', async () => {
      await session('s-claimed', OLD(), agent('fix-old'))
      await session('s-other', OLD(), agent('fix-older'))
      await session('s-plan', OLD(), { 'agent-p.jsonl': '{"type":"user"}\n' })
      expect(await ids(['fix-old'])).toEqual(['s-claimed/e', 's-claimed/r'])
      expect(await ids(['fix-older'])).toEqual(['s-other/e', 's-other/r'])
    })

    test('no claim, or a name no session holds: nothing past the window', async () => {
      await session('s-claimed', OLD(), agent('fix-old'))
      expect(await ids([])).toEqual([])
      expect(await ids(['fix-gone'])).toEqual([])
      expect(await listAgentFiles(claude, repoPath, 30, now)).toEqual([])
    })

    test('a longer name does not count', async () => {
      await session('s-claimed', OLD(), agent('fix-old-two'))
      expect(await ids(['fix-old'])).toEqual([])
      await session('s-prefix', OLD(), agent('my-fix-old'))
      expect(await ids(['fix-old'])).toEqual([])
    })

    test('each session is read once for each name while it stays unchanged', async () => {
      await session('s-claimed', OLD(), agent('fix-old'))
      const scan = createClaimedSessionScan()
      expect(await ids(['fix-old'], scan)).toHaveLength(2)
      // The text goes, and the dates stay: the answer comes from memory, with no read.
      await session('s-claimed', OLD(), { 'agent-e.jsonl': '{"type":"user"}\n' })
      expect(await ids(['fix-old'], scan)).toHaveLength(2)
      // A changed date reads it again.
      await session('s-claimed', OLD() + 1000, { 'agent-e.jsonl': '{"type":"user"}\n' })
      expect(await ids(['fix-old'], scan)).toEqual([])
    })

    test('reads only the head of each file', async () => {
      await session('s-late', OLD(), { 'agent-e.jsonl': `${'x'.repeat(200 * 1024)} fix-old\n` })
      expect(await ids(['fix-old'])).toEqual([])
    })
  })

  test('reads an agent, with "" for a missing meta file', async () => {
    await session('s1', now, {
      'agent-a1.jsonl': '{"type":"user"}\n',
      'agent-a1.meta.json': '{"agentType":"pod:engineer"}',
      'agent-c3.jsonl': '{"type":"user"}\n',
    })
    const [a1, c3] = await listAgentFiles(claude, repoPath, 30, now)
    expect(await readAgentFile(a1!)).toEqual({
      id: 'a1',
      session: 's1',
      meta: '{"agentType":"pod:engineer"}',
      jsonl: '{"type":"user"}\n',
    })
    expect(await readAgentFile(c3!)).toEqual({ id: 'c3', session: 's1', meta: '', jsonl: '{"type":"user"}\n' })
  })

  /** A cache whose parse keeps the text, and counts its calls. */
  function counting() {
    const calls: string[] = []
    const cache = createAgentFileCache((t) => {
      calls.push(t.id)
      return { jsonl: t.jsonl, meta: t.meta }
    })
    return { cache, calls }
  }

  test("the cache parses an unchanged file once, and a changed one again", async () => {
    await session('s1', now, { 'agent-a1.jsonl': 'line-1\n', 'agent-a1.meta.json': '{"v":1}' })
    const [file] = await listAgentFiles(claude, repoPath, 30, now)
    // A whole-second mtime, so setting it again gives the very same value (NTFS keeps 100 ns).
    const mtime = new Date(Math.floor(now / 1000) * 1000)
    await utimes(file!.jsonlPath, mtime, mtime)
    const { cache, calls } = counting()
    const first = await cache.read(file!)
    expect(first).toEqual({ jsonl: 'line-1\n', meta: '{"v":1}' })

    // Same size and same mtime: the cache answers, so the new bytes are not seen.
    expect((await stat(file!.jsonlPath)).mtimeMs).toBe(mtime.getTime())
    await writeFile(file!.jsonlPath, 'LINE-1\n')
    await utimes(file!.jsonlPath, mtime, mtime)
    expect(await cache.read(file!)).toBe(first)
    expect(calls).toEqual(['a1'])

    // The transcript grows: parsed again.
    await writeFile(file!.jsonlPath, 'line-1\nline-2\n')
    expect((await cache.read(file!)).jsonl).toBe('line-1\nline-2\n')

    // Only the meta file changes: parsed again.
    await writeFile(file!.metaPath, '{"v":22}')
    expect((await cache.read(file!)).meta).toBe('{"v":22}')

    // The meta file goes: parsed again, with "" for it.
    await rm(file!.metaPath)
    expect((await cache.read(file!)).meta).toBe('')
    expect(calls).toEqual(['a1', 'a1', 'a1', 'a1'])
  })

  test('retain forgets agents no longer listed', async () => {
    await session('s1', now, { 'agent-a1.jsonl': 'x\n' })
    const [file] = await listAgentFiles(claude, repoPath, 30, now)
    const { cache, calls } = counting()
    const first = await cache.read(file!)
    cache.retain([file!])
    expect(await cache.read(file!)).toBe(first)
    cache.retain([])
    const again = await cache.read(file!)
    expect(again).not.toBe(first)
    expect(again).toEqual(first)
    expect(calls).toEqual(['a1', 'a1'])
  })

  test('a transcript deleted after listing throws, and the files are left as they were', async () => {
    await session('s1', now, { 'agent-a1.jsonl': 'x\n' })
    const [file] = await listAgentFiles(claude, repoPath, 30, now)
    const { cache } = counting()
    await cache.read(file!)
    expect(await readFile(file!.jsonlPath, 'utf8')).toBe('x\n')
    await rm(file!.jsonlPath)
    await expect(cache.read(file!)).rejects.toThrow()
    await expect(readAgentFile(file!)).rejects.toThrow()
  })
})

describe('the cwd of a session file', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pod-board-session-cwd-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const file = () => join(dir, 's.jsonl')

  test('is the first readable one, past records with none and a line that is not JSON', async () => {
    await writeFile(file(), ['not json', '{"type":"summary"}', '{"cwd":7}', '{"cwd":""}', '{"cwd":"E:/a"}', '{"cwd":"E:/b"}'].join('\n'))
    expect(await firstCwdOfFile(file())).toBe('E:/a')
  })

  test('a file with none, a missing file, or a half-written last line gives none', async () => {
    await writeFile(file(), '{"type":"summary"}\n')
    expect(await firstCwdOfFile(file())).toBeUndefined()
    expect(await firstCwdOfFile(join(dir, 'none.jsonl'))).toBeUndefined()
    await writeFile(file(), '{"cwd":"E:/a"')
    expect(await firstCwdOfFile(file())).toBeUndefined()
  })

  test('a long first line still gives its cwd, across read chunks', async () => {
    await writeFile(file(), JSON.stringify({ text: 'x'.repeat(300_000), cwd: 'E:/a' }) + '\n')
    expect(await firstCwdOfFile(file())).toBe('E:/a')
  })

  test('reads only the head: a cwd past the limit gives none', async () => {
    await writeFile(file(), JSON.stringify({ text: 'x'.repeat(2_000_000) }) + '\n' + JSON.stringify({ cwd: 'E:/a' }) + '\n')
    expect(await firstCwdOfFile(file())).toBeUndefined()
  })

  test('a file it can open but not read rejects, so "could not read" stays apart from "no cwd"', async () => {
    await expect(firstCwdOfFile(dir)).rejects.toThrow()
  })

  test('a failed read reads as no cwd and is not cached: the next call tries again and gets the cwd', async () => {
    let reads = 0
    const cache = createSessionCwdCache(async () => {
      reads += 1
      if (reads === 1) throw new Error('locked')
      return 'E:/a'
    })
    await writeFile(file(), 'one')
    await expect(cache.read(file())).resolves.toBeUndefined()
    await expect(cache.read(file())).resolves.toBe('E:/a')
    expect(reads).toBe(2)
    await cache.read(file())
    expect(reads).toBe(2)
  })

  test('a file read with no cwd stays cached', async () => {
    let reads = 0
    const cache = createSessionCwdCache(async () => {
      reads += 1
      return undefined
    })
    await writeFile(file(), 'one')
    await cache.read(file())
    await cache.read(file())
    expect(reads).toBe(1)
  })

  test('the cache reads a file once until its size or mtime changes, and forgets what it does not retain', async () => {
    let reads = 0
    const cache = createSessionCwdCache(async () => {
      reads += 1
      return 'E:/a'
    })
    await writeFile(file(), 'one')
    expect(await cache.read(file())).toBe('E:/a')
    expect(await cache.read(file())).toBe('E:/a')
    expect(reads).toBe(1)
    await writeFile(file(), 'three')
    await cache.read(file())
    expect(reads).toBe(2)
    cache.retain([])
    await cache.read(file())
    expect(reads).toBe(3)
    expect(await cache.read(join(dir, 'none.jsonl'))).toBeUndefined()
    expect(reads).toBe(3)
  })
})
