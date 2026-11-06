import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board } from '@open-aflow/model'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './app.ts'
import { createToolFinder } from './tool-finder.ts'

// A disk that fails on demand: the one thing a test can't make Windows do on cue.
const disk = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (disk.failRename) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return real.rename(from, to)
    },
  }
})

const WIN = process.platform === 'win32'
const PORT = 3070
const TOKEN = 'test-token'
const HOST = { host: `127.0.0.1:${PORT}` }
const POST = { ...HOST, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' }
const BOARD: Board = { generatedAt: 1, gh: 'unknown', repos: [] }

let root: string
let bin: string
let settingsFile: string

const appOf = () =>
  createApp({
    ports: [PORT],
    token: TOKEN,
    source: { board: () => BOARD, subscribe: () => () => {}, rebuild: async () => {} },
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: async () => undefined,
    tools: createToolFinder({ env: { Path: bin }, platform: 'win32', settingsFile, readRegistryPath: async () => '' }),
  })

const save = (app: ReturnType<typeof appOf>, body: unknown, token = TOKEN) =>
  app.request('/api/actions/tool-path', { method: 'POST', headers: { ...POST, 'x-open-aflow-token': token }, body: JSON.stringify(body) })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tool-routes-')))
  bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'cfg'))
  settingsFile = join(root, 'cfg', 'tool-paths.json')
  disk.failRename = false
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.runIf(WIN)('tool routes', () => {
  test('tool states sit behind the guards', async () => {
    writeFileSync(join(bin, 'gh.exe'), '')
    writeFileSync(settingsFile, JSON.stringify({ claude: join(root, 'gone', 'claude.exe') }))
    const app = appOf()

    const ok = await app.request('/api/tools', { headers: { ...HOST, 'x-open-aflow-token': TOKEN } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({
      tools: [
        { tool: 'git', state: 'missing' },
        { tool: 'gh', state: 'found', path: join(bin, 'gh.exe'), source: 'path' },
        { tool: 'claude', state: 'bad-path', path: join(root, 'gone', 'claude.exe'), source: 'settings' },
      ],
    })

    const noToken = await app.request('/api/tools', { headers: HOST })
    expect(noToken.status).toBe(403)
    expect(await noToken.json()).toEqual({ error: 'bad token' })

    const wrongToken = await app.request('/api/tools', { headers: { ...HOST, 'x-open-aflow-token': 'nope' } })
    expect(wrongToken.status).toBe(403)

    const foreign = await app.request('/api/tools', { headers: { host: 'evil.example', 'x-open-aflow-token': TOKEN } })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toEqual({ error: 'forbidden host' })
  })

  test('each GET runs a new check', async () => {
    const app = appOf()
    const ghState = async () => {
      const res = await app.request('/api/tools', { headers: { ...HOST, 'x-open-aflow-token': TOKEN } })
      expect(res.status).toBe(200)
      return ((await res.json()) as { tools: { tool: string; state: string }[] }).tools.find((t) => t.tool === 'gh')?.state
    }
    expect(await ghState()).toBe('missing')
    writeFileSync(join(bin, 'gh.exe'), '')
    expect(await ghState()).toBe('found')
  })

  test('sets and clears a path', async () => {
    const chosen = join(root, 'chosen')
    mkdirSync(chosen)
    writeFileSync(join(chosen, 'gh.exe'), '')
    writeFileSync(join(bin, 'gh.exe'), '')
    const app = appOf()

    const set = await save(app, { tool: 'gh', path: join(chosen, 'gh.exe') })
    expect(set.status).toBe(200)
    expect(((await set.json()) as { tools: unknown[] }).tools[1]).toEqual({ tool: 'gh', state: 'found', path: join(chosen, 'gh.exe'), source: 'settings' })
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ gh: join(chosen, 'gh.exe') })

    const cleared = await save(app, { tool: 'gh', path: null })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { tools: unknown[] }).tools[1]).toEqual({ tool: 'gh', state: 'found', path: join(bin, 'gh.exe'), source: 'path' })
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({})
  })

  test('a claude shim may be saved, in any case', async () => {
    writeFileSync(join(bin, 'CLAUDE.CMD'), '')
    expect((await save(appOf(), { tool: 'claude', path: join(bin, 'CLAUDE.CMD') })).status).toBe(200)
  })

  test('refuses bad paths', async () => {
    writeFileSync(join(bin, 'other.exe'), '')
    writeFileSync(join(bin, 'gh.cmd'), '')
    writeFileSync(join(bin, 'gh.exe'), '')
    const app = appOf()
    const cases: [unknown, string][] = [
      [{ tool: 'gh', path: 'gh.exe' }, 'not absolute'],
      [{ tool: 'gh', path: '' }, 'not absolute'],
      [{ tool: 'gh', path: 'C:gh.exe' }, 'not absolute'],
      [{ tool: 'gh', path: '\\gh.exe' }, 'not absolute'],
      [{ tool: 'gh', path: '\\\\host\\share\\gh.exe' }, 'not a local path'],
      [{ tool: 'gh', path: '//host/share/gh.exe' }, 'not a local path'],
      [{ tool: 'gh', path: '\\\\?\\C:\\x\\gh.exe' }, 'not a local path'],
      [{ tool: 'gh', path: bin }, 'not a file'],
      [{ tool: 'gh', path: join(root, 'no-such', 'gh.exe') }, 'not a file'],
      [{ tool: 'gh', path: join(bin, 'other.exe') }, 'wrong tool'],
      [{ tool: 'gh', path: join(bin, 'gh.cmd') }, 'wrong tool'],
      [{ tool: 'gh', path: `${join(bin, 'gh.exe')}\u0000.txt` }, 'bad request'],
      [{ tool: 'pod', path: join(bin, 'gh.exe') }, 'bad request'],
      [{ tool: 'constructor', path: join(bin, 'gh.exe') }, 'bad request'],
      [{ path: join(bin, 'gh.exe') }, 'bad request'],
      [{ tool: 'gh' }, 'bad request'],
      [{ tool: 'gh', path: 5 }, 'bad request'],
      [{ tool: 'gh', path: ['x'] }, 'bad request'],
    ]
    for (const [body, word] of cases) {
      const res = await save(app, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json(), JSON.stringify(body)).toEqual({ error: word })
    }
    expect(readdirSync(join(root, 'cfg'))).toEqual([])
  })

  test('guarded and atomic', async () => {
    writeFileSync(join(bin, 'gh.exe'), '')
    const app = appOf()
    const body = { tool: 'gh', path: join(bin, 'gh.exe') }

    const noToken = await save(app, body, 'nope')
    expect(noToken.status).toBe(403)
    expect(await noToken.json()).toEqual({ error: 'bad token' })
    expect(readdirSync(join(root, 'cfg'))).toEqual([])

    const old = JSON.stringify({ git: 'old value' })
    writeFileSync(settingsFile, old)
    disk.failRename = true
    const failed = await save(app, body)
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'settings unwritable' })
    expect(readFileSync(settingsFile, 'utf8')).toBe(old)
    expect(readdirSync(join(root, 'cfg'))).toEqual(['tool-paths.json']) // no temp file left

    // A failed save stops no later save.
    disk.failRename = false
    expect((await save(app, body)).status).toBe(200)
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ git: 'old value', gh: join(bin, 'gh.exe') })
  })
})
