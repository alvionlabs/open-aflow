import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRun, Board, NewActionEntry } from '@openaflow/model'
import { listRuns } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import { createForgetRunRoutes, type ForgetRunRouteDeps } from './forget-run-routes.ts'
import { createGhReader, type GhExec } from './gh.ts'
import { createSessionToken } from './session-token.ts'

// Every folder is a fresh temp folder: never the real port claims folder.

const API = 3062
const WEB = 3063
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-openaflow-token': TOKEN }
const NOW = Date.parse('2026-11-12T12:00:00Z')
const MIN = 60_000
const platform = process.platform

const PLAN = ['# Plan: alpha', '', '_Generated: 2026-11-12 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | active | — |', ''].join('\n')

let root: string
let ports: string
let cfgFile: string
/** Registered: a live plan `alpha` (claim 3110) and a leftover fix run `fix-scroll` (claim 3100). */
let webPath: string
/** Registered, with no claims. */
let otherPath: string

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

const exists = (p: string) => access(p).then(() => true, () => false)

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openaflow-forget-')))
  webPath = join(root, 'repos', 'web')
  otherPath = join(root, 'repos', 'other')
  for (const p of [webPath, otherPath]) await makeRepo(p)
  cfgFile = join(root, 'cfg', 'config.json')
  await mkdir(join(root, 'cfg'), { recursive: true })
  await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: webPath }, { path: otherPath }] }))
  ports = join(root, 'ports')
  await mkdir(ports)
  await writeFile(join(ports, '3100'), `${webPath} fix-scroll\n`)
  await writeFile(join(ports, '3110'), `${webPath} alpha\n`)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ghExec = (async (args: string[]) => (args[0] === 'auth' ? { status: 'ok', stdout: '' } : { status: 'ok', stdout: '[]' })) as GhExec

type SetupOpts = { append?: (e: NewActionEntry) => Promise<boolean>; unlink?: ForgetRunRouteDeps['unlink']; mapBoard?: (b: Board) => Board }

/** The forget route behind the real app and guard, over a real board service, claims folder, and temp repos. */
async function setup(opts: SetupOpts = {}) {
  const logged: NewActionEntry[] = []
  const events: string[] = []
  const service = createBoardService({
    configFile: cfgFile,
    portsDir: ports,
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
  const routes = createForgetRunRoutes({
    board: source.board,
    portsDir: ports,
    platform,
    now: () => NOW,
    rebuild: source.rebuild,
    log: {
      append: async (e) => {
        events.push('log')
        if (opts.append) return opts.append(e)
        logged.push(e)
        return true
      },
    },
    ...(opts.unlink ? { unlink: opts.unlink } : {}),
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
    app.request('/api/actions/forget-run', { method, headers, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const runs = () => listRuns(board, NOW).map((r) => r.plan)
  return { post, logged, events, board: () => board, idOf, runs }
}

const runningEngineer: AgentRun = { id: 'eng', session: 's', type: 'pod:engineer', tokens: 0, ended: false, branch: 'fix-scroll', startedAt: NOW - 10 * MIN, lastAt: NOW - MIN }
const withAgent = (b: Board): Board => ({ ...b, repos: b.repos.map((r) => (r.path === webPath ? { ...r, agents: [runningEngineer] } : r)) })

describe('forget-run route', () => {
  test('forgets one claim', async () => {
    const s = await setup()
    const repoId = s.idOf(webPath)
    expect(s.runs()).toContain('fix-scroll')
    const res = await s.post({ repoId, run: 'fix-scroll', portBase: 3100 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'removed', run: 'fix-scroll', portBase: 3100, logged: true })
    expect(await exists(join(ports, '3100'))).toBe(false)
    expect(s.logged).toEqual([{ action: 'forget-run', repoId, repo: 'web', target: 'fix-scroll · port base 3100', result: 'removed' }])
    // Logged, then the Board rebuilt without the run, before the reply.
    expect(s.events).toEqual(['log', 'rebuild'])
    expect(s.runs()).not.toContain('fix-scroll')
    expect(s.runs()).toContain('alpha')
  })

  test('touches nothing else', async () => {
    const s = await setup()
    const otherClaims = Object.fromEntries(Object.entries(await snapshot(ports)).filter(([name]) => !name.endsWith('3100')))
    expect(Object.keys(otherClaims)).toHaveLength(1)
    const repo = await snapshot(webPath)
    const other = await snapshot(otherPath)
    const cfg = await readFile(cfgFile)
    expect((await s.post({ repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 })).status).toBe(200)
    expect(await snapshot(ports)).toEqual(otherClaims)
    expect(await readFile(join(ports, '3110'), 'utf8')).toBe(`${webPath} alpha\n`)
    expect(await snapshot(webPath)).toEqual(repo)
    expect(await snapshot(otherPath)).toEqual(other)
    expect(await readFile(cfgFile)).toEqual(cfg)
  })

  test('bad requests', async () => {
    const s = await setup()
    const repoId = s.idOf(webPath)
    const before = await snapshot(ports)
    const bodies: unknown[] = [
      {},
      { repoId, run: 'fix-scroll' },
      { repoId, portBase: 3100 },
      { run: 'fix-scroll', portBase: 3100 },
      { repoId: 5, run: 'fix-scroll', portBase: 3100 },
      { repoId, run: ['fix-scroll'], portBase: 3100 },
      ...[0, 65536, 1.5, -3100, '../x', '3100', null, Number.NaN].map((portBase) => ({ repoId, run: 'fix-scroll', portBase })),
      [],
      null,
      'not json',
    ]
    for (const body of bodies) {
      const res = await s.post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad request' })
    }
    expect(await snapshot(ports)).toEqual(before)
    expect(s.logged).toEqual([])
  })

  test('claim changed', async () => {
    const s = await setup()
    const repoId = s.idOf(webPath)
    // Rewritten after the Board was built: another repo, another run, then text that isn't a claim.
    for (const text of [`${otherPath} fix-scroll\n`, `${webPath} fix-other\n`, 'not a claim']) {
      await writeFile(join(ports, '3100'), text)
      const res = await s.post({ repoId, run: 'fix-scroll', portBase: 3100 })
      expect(res.status, text).toBe(409)
      expect(await res.json()).toEqual({ error: 'claim changed' })
      expect(await readFile(join(ports, '3100'), 'utf8')).toBe(text)
    }
    expect(s.logged).toEqual([])
  })

  test('repeat', async () => {
    const s = await setup()
    const body = { repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 }
    expect((await s.post(body)).status).toBe(200)
    const res = await s.post(body)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not a run' })
    expect(s.logged).toHaveLength(1)
  })

  test('two quick forgets of the same claim: one removes, the other is 404', async () => {
    const s = await setup()
    const body = { repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 }
    const [a, b] = await Promise.all([s.post(body), s.post(body)])
    expect([a.status, b.status].sort()).toEqual([200, 404])
    expect(s.logged).toHaveLength(1)
  })

  test('a claim gone since the Board was built gives 404 no claim, then a rebuild', async () => {
    const s = await setup()
    await unlink(join(ports, '3100'))
    const res = await s.post({ repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no claim' })
    expect(s.events).toEqual(['rebuild'])
    expect(s.logged).toEqual([])
  })

  test('a port base that is not the run claim gives 404 no claim and deletes nothing', async () => {
    const s = await setup()
    const before = await snapshot(ports)
    const res = await s.post({ repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3110 })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no claim' })
    expect(await snapshot(ports)).toEqual(before)
    expect(s.logged).toEqual([])
  })

  test('refusals from the check, and repos not on the Board', async () => {
    const s = await setup()
    const repoId = s.idOf(webPath)
    const before = await snapshot(ports)
    const cases: [unknown, number, string][] = [
      [{ repoId: 'nope', run: 'fix-scroll', portBase: 3100 }, 404, 'not on the board'],
      [{ repoId, run: 'fix-nope', portBase: 3100 }, 404, 'not a run'],
      [{ repoId: s.idOf(otherPath), run: 'alpha', portBase: 3110 }, 404, 'no claim'],
      [{ repoId, run: 'alpha', portBase: 3110 }, 404, 'still listed'],
    ]
    for (const [body, status, error] of cases) {
      const res = await s.post(body)
      expect(res.status, error).toBe(status)
      expect(await res.json()).toEqual({ error })
    }
    expect(await snapshot(ports)).toEqual(before)
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
  })

  test('two repos with the same id give 409 ambiguous repo', async () => {
    const s = await setup({ mapBoard: (b) => ({ ...b, repos: b.repos.map((r) => ({ ...r, id: 'shared-id' })) }) })
    const res = await s.post({ repoId: 'shared-id', run: 'fix-scroll', portBase: 3100 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ambiguous repo' })
    expect(await exists(join(ports, '3100'))).toBe(true)
  })

  test('running run', async () => {
    const s = await setup({ mapBoard: withAgent })
    const res = await s.post({ repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'run is running' })
    expect(await exists(join(ports, '3100'))).toBe(true)
    expect(s.logged).toEqual([])
  })

  test('delete fails', async () => {
    const tried: string[] = []
    const s = await setup({
      unlink: async (file) => {
        tried.push(file)
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      },
    })
    const repoId = s.idOf(webPath)
    const res = await s.post({ repoId, run: 'fix-scroll', portBase: 3100 })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'claim unremovable' })
    expect(tried).toEqual([join(ports, '3100')])
    expect(s.logged).toEqual([{ action: 'forget-run', repoId, repo: 'web', target: 'fix-scroll · port base 3100', result: 'failed', message: 'EPERM' }])
    expect(await exists(join(ports, '3100'))).toBe(true)
  })

  test('a log that fails still answers removed, with logged false', async () => {
    const s = await setup({ append: async () => false })
    const res = await s.post({ repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'removed', logged: false })
  })

  test('behind the action guard', async () => {
    const s = await setup()
    const body = { repoId: s.idOf(webPath), run: 'fix-scroll', portBase: 3100 }
    const { 'x-openaflow-token': _t, ...noToken } = HEADERS
    const cases: [Record<string, string>, string, number, string][] = [
      [noToken, 'POST', 403, 'bad token'],
      [{ ...HEADERS, 'x-openaflow-token': 'wrong' }, 'POST', 403, 'bad token'],
      // The action guard answers any method but POST before a route is matched.
      [HEADERS, 'GET', 405, 'method not allowed'],
    ]
    for (const [headers, method, status, error] of cases) {
      const res = await s.post(body, headers, method)
      expect(res.status, `${method} ${error}`).toBe(status)
      expect(await res.json()).toEqual({ error })
    }
    expect(await exists(join(ports, '3100'))).toBe(true)
    expect(s.logged).toEqual([])
  })
})
