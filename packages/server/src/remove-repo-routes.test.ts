import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board, NewActionEntry } from '@open-aflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import { createGhReader, type GhExec } from './gh.ts'
import { createRemoveRepoRoutes, type RemoveRepoRouteDeps } from './remove-repo-routes.ts'
import { removeRepo } from './repos-config.ts'
import { createSessionToken } from './session-token.ts'

const API = 3060
const WEB = 3061
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-open-aflow-token': TOKEN }
const NOW = Date.parse('2026-11-01T12:00:00Z')
const platform = process.platform

const PLAN = ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | active | — |', ''].join('\n')

let root: string
let cfgFile: string
/** Registered only. */
let regPath: string
/** Registered, and also named by a port claim. */
let bothPath: string
/** Named only by a port claim. */
let claimPath: string

async function makeRepo(path: string) {
  await mkdir(join(path, 'pod-docs', 'plans'), { recursive: true })
  await writeFile(join(path, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  await writeFile(join(path, 'pod-docs', 'plans', 'alpha.md'), PLAN)
  await writeFile(join(path, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
}

/** Every file under a folder with its bytes, so a test can show nothing in it changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue
    const full = join(name.parentPath, name.name)
    out[full.slice(dir.length)] = await readFile(full, 'utf8')
  }
  return out
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'open-aflow-remove-')))
  regPath = join(root, 'repos', 'reg')
  bothPath = join(root, 'repos', 'both')
  claimPath = join(root, 'repos', 'claim')
  for (const p of [regPath, bothPath, claimPath]) await makeRepo(p)
  cfgFile = join(root, 'cfg', 'config.json')
  await mkdir(join(root, 'cfg'), { recursive: true })
  await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: regPath }, { path: bothPath }] }))
  await mkdir(join(root, 'ports'))
  await writeFile(join(root, 'ports', '3100'), `${claimPath} alpha`)
  await writeFile(join(root, 'ports', '3110'), `${bothPath} alpha`)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ghExec = (async (args: string[]) => (args[0] === 'auth' ? { status: 'ok', stdout: '' } : { status: 'ok', stdout: '[]' })) as GhExec

type SetupOpts = { append?: (e: NewActionEntry) => Promise<boolean>; removeRepo?: RemoveRepoRouteDeps['removeRepo']; forgetToggles?: RemoveRepoRouteDeps['forgetToggles']; mapBoard?: (b: Board) => Board }

/** The remove route behind the real app and guard, over a real board service, config file, and temp repos. */
async function setup(opts: SetupOpts = {}) {
  const logged: NewActionEntry[] = []
  const events: string[] = []
  const service = createBoardService({
    configFile: cfgFile,
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform,
    gh: createGhReader({ exec: ghExec, now: () => NOW }),
    now: () => NOW,
  })
  const build = async () => (opts.mapBoard ?? ((b: Board) => b))(await service.build())
  let board: Board = await build()
  const source = {
    board: () => board,
    subscribe: () => () => {},
    rebuild: async () => {
      events.push('rebuild')
      board = await build()
    },
  }
  const routes = createRemoveRepoRoutes({
    board: source.board,
    removeRepo: opts.removeRepo ?? ((p) => removeRepo(cfgFile, p, platform)),
    rebuild: source.rebuild,
    forgetToggles: opts.forgetToggles ?? (async () => {}),
    log: {
      append: async (e) => {
        events.push('log')
        if (opts.append) return opts.append(e)
        logged.push(e)
        return true
      },
    },
  })
  const app = createApp({
    ports: [API, WEB],
    token: TOKEN,
    source,
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: async () => undefined,
    actions: new Hono().route('/', routes),
  })
  const idOf = (path: string) => board.repos.find((r) => r.path === path)!.id
  const post = (body: unknown, headers: Record<string, string> = HEADERS, method = 'POST') =>
    app.request('/api/actions/remove-repo', { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
  return { post, logged, events, board: () => board, idOf }
}

const config = async () => JSON.parse(await readFile(cfgFile, 'utf8')) as { version: number; repos: { path: string }[] }

describe('remove-repo route', () => {
  test('a failed toggle clear still removes the repo, and the log says so', async () => {
    const s = await setup({
      forgetToggles: async () => {
        throw new Error('disk full')
      },
    })
    const res = await s.post({ repoId: s.idOf(regPath) })
    expect(await res.json()).toMatchObject({ outcome: 'removed' })
    expect(s.logged[0]).toMatchObject({ result: 'removed', message: "Couldn't clear its auto-continue toggle." })
  })

  test('removes a registered repo from the config and the Board, logs it, and leaves its folder alone', async () => {
    const s = await setup()
    const id = s.idOf(regPath)
    const before = await snapshot(regPath)
    const res = await s.post({ repoId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'removed', path: regPath, logged: true })
    expect((await config()).repos).toEqual([{ path: bothPath }])
    expect(s.board().repos.map((r) => r.path)).not.toContain(regPath)
    expect(await snapshot(regPath)).toEqual(before)
    expect(s.logged).toEqual([{ action: 'remove-repo', repoId: id, repo: 'reg', target: regPath, result: 'removed' }])
    // The Board carries the change and the log entry before the response.
    expect(s.events).toEqual(['log', 'rebuild'])
  })

  test('the last registered repo: the config keeps an empty list', async () => {
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: regPath }] }))
    await rm(join(root, 'ports'), { recursive: true })
    const s = await setup()
    expect((await s.post({ repoId: s.idOf(regPath) })).status).toBe(200)
    expect(await config()).toEqual({ version: 1, repos: [] })
    expect(s.board().repos).toEqual([])
  })

  test('a repo listed only through a port claim is not registered, and nothing changes', async () => {
    const s = await setup()
    const id = s.idOf(claimPath)
    const before = await readFile(cfgFile)
    const res = await s.post({ repoId: id })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not registered' })
    expect(await readFile(cfgFile)).toEqual(before)
    expect(s.logged).toEqual([])
  })

  test('a repo in the config and a claim leaves the config but stays on the Board through its claim', async () => {
    const s = await setup()
    const res = await s.post({ repoId: s.idOf(bothPath) })
    expect(res.status).toBe(200)
    expect((await config()).repos).toEqual([{ path: regPath }])
    expect(s.board().repos.find((r) => r.path === bothPath)?.source).toBe('claim')
  })

  test('a repo already gone from the Board or the file is refused, with no write and no log', async () => {
    const s = await setup()
    const id = s.idOf(regPath)
    for (const body of [{ repoId: 'nope' }]) {
      const res = await s.post(body)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not on the board' })
    }
    // Hand-edited out after the Board was built.
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: bothPath }] }))
    const before = await readFile(cfgFile)
    const res = await s.post({ repoId: id })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not registered' })
    expect(await readFile(cfgFile)).toEqual(before)
    expect(s.logged).toEqual([])
  })

  test('the config changed on disk since load: removes from the current file, never writes back a stale list', async () => {
    const s = await setup()
    const extra = join(root, 'repos', 'added-by-hand')
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: regPath }, { path: extra }] }))
    expect((await s.post({ repoId: s.idOf(regPath) })).status).toBe(200)
    // bothPath was in the loaded list, but the file no longer had it; it doesn't come back.
    expect((await config()).repos).toEqual([{ path: extra }])
  })

  test('an unreadable config is refused with the error Add repo uses and stays byte for byte', async () => {
    const s = await setup()
    await writeFile(cfgFile, '{not json')
    const res = await s.post({ repoId: s.idOf(regPath) })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'config unreadable' })
    expect(await readFile(cfgFile, 'utf8')).toBe('{not json')
    expect(s.logged).toEqual([])
  })

  test('a write that throws is 500 config unwritable and logged as failed', async () => {
    const s = await setup({ removeRepo: () => Promise.reject(new Error('EACCES')) })
    const id = s.idOf(regPath)
    const res = await s.post({ repoId: id })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'config unwritable' })
    expect(s.logged).toEqual([{ action: 'remove-repo', repoId: id, repo: 'reg', target: regPath, result: 'failed', message: 'config unwritable' }])
  })

  test('two quick removes of the same repo: one removes, the other is refused', async () => {
    const s = await setup()
    const id = s.idOf(regPath)
    const [a, b] = await Promise.all([s.post({ repoId: id }), s.post({ repoId: id })])
    expect([a.status, b.status].sort()).toEqual([200, 404])
    expect((await config()).repos).toEqual([{ path: bothPath }])
    expect(s.logged).toHaveLength(1)
  })

  test('two quick removes of two repos both land', async () => {
    const s = await setup()
    const [a, b] = await Promise.all([s.post({ repoId: s.idOf(regPath) }), s.post({ repoId: s.idOf(bothPath) })])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await config()).repos).toEqual([])
  })

  test('a log that fails still answers removed, with logged false', async () => {
    const s = await setup({ append: async () => false })
    const res = await s.post({ repoId: s.idOf(regPath) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'removed', path: regPath, logged: false })
  })

  test('validates the body', async () => {
    const s = await setup()
    const before = await readFile(cfgFile)
    for (const body of [{}, { repoId: 7 }, { repoId: null }, { repoId: ['x'] }]) {
      const res = await s.post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad request' })
    }
    expect(await readFile(cfgFile)).toEqual(before)
  })

  test('the action guard: bad token, foreign Host, foreign or missing Origin, and GET are refused before anything is written', async () => {
    const s = await setup()
    const body = { repoId: s.idOf(regPath) }
    const before = await readFile(cfgFile)
    const { origin: _o, ...noOrigin } = HEADERS
    const cases: [Record<string, string>, string, number, string][] = [
      [{ ...HEADERS, 'x-open-aflow-token': 'wrong' }, 'POST', 403, 'bad token'],
      [{ ...HEADERS, 'x-open-aflow-token': '' }, 'POST', 403, 'bad token'],
      [{ ...HEADERS, host: `evil.example:${API}` }, 'POST', 403, 'forbidden host'],
      [{ ...HEADERS, origin: 'http://evil.example' }, 'POST', 403, 'forbidden origin'],
      [noOrigin, 'POST', 403, 'forbidden origin'],
      [HEADERS, 'GET', 405, 'method not allowed'],
      [HEADERS, 'DELETE', 405, 'method not allowed'],
    ]
    for (const [headers, method, status, error] of cases) {
      const res = await s.post(body, headers, method)
      expect(res.status, `${method} ${error}`).toBe(status)
      expect(await res.json()).toEqual({ error })
    }
    expect(await readFile(cfgFile)).toEqual(before)
    expect(s.logged).toEqual([])
  })
})

describe('remove-repo route: two repos with the same id', () => {
  // A real Board gives these two distinct ids (`repoIds`); the Board is forced here, because the route keeps its
  // path check and its 409 as a safety check.
  const share = (b: Board): Board => ({ ...b, repos: b.repos.map((r) => (r.name.startsWith('chess') ? { ...r, id: 'shared-id' } : r)) })
  let dash: string
  let under: string
  beforeEach(async () => {
    dash = join(root, 'repos', 'chess-web')
    under = join(root, 'repos', 'chess_web')
    await makeRepo(dash)
    await makeRepo(under)
    await rm(join(root, 'ports'), { recursive: true })
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: dash }, { path: under }] }))
  })

  test('a real Board gives the two repos distinct ids, and needs no path', async () => {
    const s = await setup()
    expect(s.idOf(dash)).not.toBe(s.idOf(under))
    expect(s.board().repos).toHaveLength(2)
  })

  test('without a path the id is ambiguous: 409, and nothing changes', async () => {
    const s = await setup({ mapBoard: share })
    const before = await readFile(cfgFile)
    const res = await s.post({ repoId: s.idOf(dash) })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ambiguous repo' })
    expect(await readFile(cfgFile)).toEqual(before)
    expect(s.logged).toEqual([])
  })

  test('with its path each one is removed, and only that one', async () => {
    const s = await setup({ mapBoard: share })
    const id = s.idOf(under)
    const res = await s.post({ repoId: id, path: under })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'removed', path: under, logged: true })
    expect((await config()).repos).toEqual([{ path: dash }])
    expect(s.board().repos.map((r) => r.path)).toEqual([dash])
    expect(s.logged).toEqual([{ action: 'remove-repo', repoId: id, repo: 'chess_web', target: under, result: 'removed' }])
    expect((await s.post({ repoId: id, path: dash })).status).toBe(200)
    expect((await config()).repos).toEqual([])
  })

  test('a path that is not the Board repo with that id is not on the board', async () => {
    const s = await setup({ mapBoard: share })
    const before = await readFile(cfgFile)
    for (const path of [join(root, 'repos', 'chess.web'), regPath]) {
      const res = await s.post({ repoId: s.idOf(dash), path })
      expect(res.status, path).toBe(404)
      expect(await res.json()).toEqual({ error: 'not on the board' })
    }
    expect(await readFile(cfgFile)).toEqual(before)
  })

  test('a path that is not a string is a bad request', async () => {
    const s = await setup({ mapBoard: share })
    const res = await s.post({ repoId: s.idOf(dash), path: 7 })
    expect(res.status).toBe(400)
  })
})
