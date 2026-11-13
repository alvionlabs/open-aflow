import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTimeline, Board } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp, type AppDeps, type BoardSource } from './app.ts'
import { createBoardService } from './board-service.ts'
import { createSessionToken } from './session-token.ts'
import { createWebApp } from './web-app.ts'
import type { GhReader } from './gh.ts'
import { normalizeRepoPath } from './guard.ts'
import { addRepo } from './repos-config.ts'
import { createBoardWatcher, type BoardWatcher } from './watcher.ts'

const API = 3060
const WEB = 3061
const HOST = { host: `127.0.0.1:${API}` }
const POST_HEADERS = { ...HOST, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json' }
const platform = process.platform

const TOKEN = createSessionToken()
const ACTION_HEADERS = { ...POST_HEADERS, 'x-openaflow-token': TOKEN }
/** The largest request body the guarded routes take. */
const BODY_LIMIT = 64 * 1024

const BOARD: Board = { generatedAt: 1, gh: 'unknown', repos: [] }

/** A board source that holds one board and lets the test push new ones. */
function fakeSource(board: Board = BOARD) {
  const subs = new Set<(b: Board) => void>()
  let current = board
  const source: BoardSource = {
    board: () => current,
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    rebuild: async () => {},
  }
  const push = (b: Board) => {
    current = b
    for (const fn of subs) fn(b)
  }
  return { source, push, subs }
}

const TIMELINE: AgentTimeline = {
  agentId: 'a1',
  events: [{ at: 5, tool: 'Read', summary: 'Read src/a.ts', result: 'ok' }],
  total: 1,
  tests: { testFiles: 0, runs: 0, failedRuns: 0 },
}

type TimelineFn = AppDeps['timeline']
const noTimeline: TimelineFn = async () => undefined

function fakeApp(opts: { pingMs?: number; source?: BoardSource; timeline?: TimelineFn; actions?: Hono; web?: Hono } = {}): Hono {
  return createApp({
    ports: [API, WEB],
    token: TOKEN,
    ...(opts.actions === undefined ? {} : { actions: opts.actions }),
    ...(opts.web === undefined ? {} : { web: opts.web }),
    source: opts.source ?? fakeSource().source,
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: opts.timeline ?? noTimeline,
    ...(opts.pingMs === undefined ? {} : { pingMs: opts.pingMs }),
  })
}

/** Reads SSE text from a response until `until` matches the text so far. */
async function readUntil(res: Response, until: (text: string) => boolean, ms = 5000): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  try {
    while (!until(text)) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`stream did not match within ${ms} ms; got: ${text}`)
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stream did not match within ${ms} ms; got: ${text}`)), left)),
      ])
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel()
  }
  return text
}

/** The Boards in the `board` events of an SSE text. */
function boardEvents(text: string): Board[] {
  return text
    .split('\n\n')
    .filter((block) => /^event: board$/m.test(block))
    .map((block) => JSON.parse(block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')) as Board)
}

describe('board and events routes', () => {
  test('GET /api/board returns the board', async () => {
    const board: Board = { generatedAt: 5, gh: 'ok', ghCheckedAt: 4, repos: [] }
    const res = await fakeApp({ source: fakeSource(board).source }).request('/api/board', { headers: HOST })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual(board)
  })

  test('GET /api/events sends the board first, then each new board', async () => {
    const { source, push, subs } = fakeSource({ generatedAt: 5, gh: 'ok', repos: [] })
    const res = await fakeApp({ source }).request('/api/events', { headers: HOST })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    setTimeout(() => push({ generatedAt: 6, gh: 'missing', repos: [] }), 50)
    const text = await readUntil(res, (t) => boardEvents(t).length >= 2)
    expect(text.startsWith('event: board\n')).toBe(true)
    expect(boardEvents(text)).toEqual([
      { generatedAt: 5, gh: 'ok', repos: [] },
      { generatedAt: 6, gh: 'missing', repos: [] },
    ])
    // A client that leaves stops getting boards.
    await expect.poll(() => subs.size).toBe(0)
  })

  test('a ping comment is sent', async () => {
    const res = await fakeApp({ pingMs: 30 }).request('/api/events', { headers: HOST })
    const text = await readUntil(res, (t) => t.includes(': ping\n'))
    expect(text).toMatch(/^: ping$/m)
  })
})

describe('add repo route', () => {
  let root: string
  let configFile: string
  let watcher: BoardWatcher
  let app: Hono

  const gh: GhReader = { status: () => 'unknown', checkedAt: () => undefined, get: () => undefined, getBranch: () => undefined, refresh: async () => false }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openaflow-a1-app-'))
    configFile = join(root, 'config', 'config.json')
    const portsDir = join(root, 'ports')
    const claudeDir = join(root, 'claude')
    const service = createBoardService({ configFile, portsDir, claudeDir, transcriptDays: 30, platform, gh })
    watcher = createBoardWatcher({ service, configFile, portsDir, claudeDir })
    await watcher.start()
    app = createApp({ ports: [API, WEB], token: TOKEN, source: watcher, addRepo: (p) => addRepo(configFile, p, platform), timeline: noTimeline })
  })

  afterEach(async () => {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  })

  const post = (body: string, headers: Record<string, string> = ACTION_HEADERS) =>
    app.request('/api/repos', { method: 'POST', headers, body })

  test('201 with the normalized path, and a board event follows', async () => {
    const repo = join(root, 'repo-one')
    await mkdir(repo)
    const events = await app.request('/api/events', { headers: HOST })
    const res = await post(JSON.stringify({ path: repo + '/' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ path: normalizeRepoPath(repo, platform) })
    const text = await readUntil(events, (t) => boardEvents(t).some((b) => b.repos.length === 1))
    expect(boardEvents(text).at(-1)!.repos[0]!.path).toBe(normalizeRepoPath(repo, platform))
    // The board route has it at once too.
    const board = (await (await app.request('/api/board', { headers: HOST })).json()) as Board
    expect(board.repos.map((r) => r.source)).toEqual(['registered'])
  })

  test('a charset on the JSON content type is fine', async () => {
    const repo = join(root, 'repo-two')
    await mkdir(repo)
    const res = await post(JSON.stringify({ path: repo }), { ...ACTION_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    expect(res.status).toBe(201)
  })

  test('415 for another content type, or none', async () => {
    const body = JSON.stringify({ path: root })
    const res = await post(body, { ...ACTION_HEADERS, 'content-type': 'text/plain' })
    expect(res.status).toBe(415)
    const { 'content-type': _, ...noType } = ACTION_HEADERS
    expect((await app.request('/api/repos', { method: 'POST', headers: noType, body })).status).toBe(415)
  })

  test('413 for a body over 64 KB, and nothing is added', async () => {
    const big = JSON.stringify({ path: root, pad: 'a'.repeat(BODY_LIMIT) })
    const res = await post(big)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload too large' })
    const declared = await post(JSON.stringify({ path: root }), { ...ACTION_HEADERS, 'content-length': String(BODY_LIMIT + 1) })
    expect(declared.status).toBe(413)
    expect(await readFile(configFile, 'utf8').catch(() => 'none')).toBe('none')
  })

  test('400 for bad JSON, no string path, relative, and missing', async () => {
    for (const body of ['{ nope', '[]', 'null', '{}', '{"path": 5}']) {
      const res = await post(body)
      expect(res.status, body).toBe(400)
      expect(await res.json(), body).toEqual({ error: 'bad request' })
    }
    const relative = await post(JSON.stringify({ path: 'some/repo' }))
    expect(relative.status).toBe(400)
    expect(await relative.json()).toEqual({ error: 'not absolute' })
    const missing = await post(JSON.stringify({ path: join(root, 'nope') }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'not a directory' })
  })

  test('add repo needs the session token, and a refused add writes nothing', async () => {
    const repo = join(root, 'repo-five')
    await mkdir(repo)
    const body = JSON.stringify({ path: repo })
    const wrong = createSessionToken()
    for (const [why, headers] of [
      ['no token', POST_HEADERS],
      ['empty token', { ...POST_HEADERS, 'x-openaflow-token': '' }],
      ['wrong token', { ...POST_HEADERS, 'x-openaflow-token': wrong }],
      ['shorter token', { ...POST_HEADERS, 'x-openaflow-token': TOKEN.slice(1) }],
    ] as const) {
      const res = await post(body, headers)
      expect(res.status, why).toBe(403)
      expect(await res.json(), why).toEqual({ error: 'bad token' })
    }
    await expect(readFile(configFile, 'utf8')).rejects.toThrow()
    // A wrong Origin is still refused first, and a GET is not an add.
    const origin = await post(body, { ...ACTION_HEADERS, origin: 'http://evil.example' })
    expect(origin.status).toBe(403)
    expect(await origin.json()).toEqual({ error: 'forbidden origin' })
    expect((await app.request('/api/repos', { headers: { ...HOST, 'x-openaflow-token': TOKEN } })).status).toBe(405)
    expect((await post(body)).status).toBe(201)
    expect((await post(body)).status).toBe(409)
  })

  test.runIf(platform === 'win32')('400 for a network path, before the file system is asked', async () => {
    for (const p of ['\\\\host\\share\\repo', '//host/share/repo', '\\\\?\\C:\\x', '\\\\.\\C:\\x']) {
      const res = await post(JSON.stringify({ path: p }))
      expect(res.status, p).toBe(400)
      expect(await res.json(), p).toEqual({ error: 'not a local path' })
    }
  })

  test('409 for a repo already registered', async () => {
    const repo = join(root, 'repo-three')
    await mkdir(repo)
    expect((await post(JSON.stringify({ path: repo }))).status).toBe(201)
    const again = await post(JSON.stringify({ path: repo }))
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'already registered' })
  })

  test('500 when the config file is unreadable', async () => {
    const repo = join(root, 'repo-four')
    await mkdir(repo)
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(configFile, '{ corrupt')
    const res = await post(JSON.stringify({ path: repo }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'config unreadable' })
  })

  test('500 when the config file cannot be written', async () => {
    const res = await createApp({
      ports: [API, WEB],
      token: TOKEN,
      source: watcher,
      addRepo: () => Promise.reject(new Error('EACCES')),
      timeline: noTimeline,
    }).request('/api/repos', { method: 'POST', headers: ACTION_HEADERS, body: JSON.stringify({ path: root }) })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'config unwritable' })
  })
})

describe('timeline route', () => {
  const asked: [string, string][] = []
  const timeline: TimelineFn = async (repoId, agentId) => {
    asked.push([repoId, agentId])
    return repoId === 'r1' && agentId === 'a1' ? TIMELINE : undefined
  }
  const get = (path: string, headers: Record<string, string> = HOST) => fakeApp({ timeline }).request(path, { headers })

  test('200 with the timeline of a board agent', async () => {
    const res = await get('/api/agents/r1/a1/timeline')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual(TIMELINE)
  })

  test('404 for an unknown repo or agent, a bad id, or a gone transcript', async () => {
    asked.length = 0
    for (const path of ['/api/agents/nope/a1/timeline', '/api/agents/r1/nope/timeline', '/api/agents/r1/..%2Fx/timeline', `/api/agents/r1/${'x'.repeat(65)}/timeline`]) {
      const res = await get(path)
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toEqual({ error: 'not found' })
    }
    // A bad id never reaches the source.
    expect(asked).toEqual([
      ['nope', 'a1'],
      ['r1', 'nope'],
    ])
  })

  test('refuses a foreign Host', async () => {
    const res = await get('/api/agents/r1/a1/timeline', { host: `evil.example:${API}` })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden host' })
  })
})

describe('guard on every route', () => {
  const routes: [string, string][] = [
    ['GET', '/api/health'],
    ['GET', '/api/board'],
    ['GET', '/api/events'],
    ['POST', '/api/repos'],
    ['GET', '/api/agents/r1/a1/timeline'],
    ['GET', '/api/nope'],
  ]

  test('every route refuses a foreign Host', async () => {
    const app = fakeApp()
    for (const [method, path] of routes) {
      const res = await app.request(path, {
        method,
        headers: { ...POST_HEADERS, host: `evil.example:${API}` },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden host' })
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([])
    }
  })

  test('POST refuses a foreign or missing Origin', async () => {
    const app = fakeApp()
    for (const origin of ['http://evil.example', undefined]) {
      const { origin: _, ...headers } = POST_HEADERS
      const res = await app.request('/api/repos', {
        method: 'POST',
        headers: origin === undefined ? headers : { ...headers, origin },
        body: JSON.stringify({ path: '/x' }),
      })
      expect(res.status, String(origin)).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden origin' })
    }
  })

  test('GET /api/health returns ok', async () => {
    const res = await fakeApp().request('/api/health', { headers: HOST })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('unknown route returns 404', async () => {
    const app = fakeApp()
    expect((await app.request('/api/nope', { headers: HOST })).status).toBe(404)
    expect((await app.request('/', { headers: HOST })).status).toBe(404)
    // Only GET answers on the health route.
    expect((await app.request('/api/health', { method: 'POST', headers: POST_HEADERS })).status).toBe(404)
  })
})

/** Action routes that echo what they got, counting each call. */
function echoActions() {
  const calls: unknown[] = []
  const actions = new Hono()
  actions.post('/echo', async (c) => {
    const body: unknown = await c.req.json()
    calls.push(body)
    return c.json({ got: body })
  })
  return { actions, calls }
}

const noCorsHeaders = (res: Response) => expect([...res.headers.keys()].filter((k) => k.toLowerCase().startsWith('access-control-'))).toEqual([])

describe('action routes', () => {
  const setup = () => {
    const { actions, calls } = echoActions()
    const app = fakeApp({ actions })
    const send = (headers: Record<string, string>, opts: { method?: string; body?: string; path?: string } = {}) => {
      const method = opts.method ?? 'POST'
      return app.request(opts.path ?? '/api/actions/echo', {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: opts.body ?? '{"n":1}' }),
      })
    }
    return { app, calls, send }
  }
  const { 'x-openaflow-token': _token, ...noToken } = ACTION_HEADERS

  const refused = async (res: Response, status: number, error: string, label: string) => {
    expect(res.status, label).toBe(status)
    expect(await res.json(), label).toEqual({ error })
    noCorsHeaders(res)
  }

  test('action without token is refused', async () => {
    const { send, calls } = setup()
    await refused(await send(noToken), 403, 'bad token', 'no token')
    await refused(await send({ ...noToken, 'x-openaflow-token': '' }), 403, 'bad token', 'empty token')
    expect(calls).toEqual([])
  })

  test('action with wrong token is refused', async () => {
    const { send, calls } = setup()
    const wrong = createSessionToken()
    expect(wrong).toHaveLength(TOKEN.length)
    await refused(await send({ ...ACTION_HEADERS, 'x-openaflow-token': wrong }), 403, 'bad token', 'same length')
    await refused(await send({ ...ACTION_HEADERS, 'x-openaflow-token': TOKEN.slice(1) }), 403, 'bad token', 'shorter')
    await refused(await send({ ...ACTION_HEADERS, 'x-openaflow-token': TOKEN + 'x' }), 403, 'bad token', 'longer')
    expect(calls).toEqual([])
  })

  test('action with wrong host is refused', async () => {
    const { send, calls } = setup()
    await refused(await send({ ...ACTION_HEADERS, host: `evil.example:${API}` }), 403, 'forbidden host', 'foreign host')
    await refused(await send({ ...ACTION_HEADERS, host: '127.0.0.1:9' }), 403, 'forbidden host', 'other port')
    expect(calls).toEqual([])
  })

  test('action with missing or wrong origin is refused', async () => {
    const { send, calls } = setup()
    const { origin: _, ...noOrigin } = ACTION_HEADERS
    await refused(await send(noOrigin), 403, 'forbidden origin', 'missing')
    await refused(await send({ ...ACTION_HEADERS, origin: 'http://evil.example' }), 403, 'forbidden origin', 'foreign')
    await refused(await send({ ...ACTION_HEADERS, origin: 'null' }), 403, 'forbidden origin', 'null')
    expect(calls).toEqual([])
  })

  test('action with non-JSON body is refused', async () => {
    const { send, calls } = setup()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      await refused(await send({ ...ACTION_HEADERS, 'content-type': type }), 415, 'unsupported media type', type)
    }
    const { 'content-type': _, ...noType } = ACTION_HEADERS
    await refused(await send(noType), 415, 'unsupported media type', 'no type')
    expect(calls).toEqual([])
  })

  test('action method and body are checked', async () => {
    const { send, calls } = setup()
    await refused(await send({ host: HOST.host, 'x-openaflow-token': TOKEN }, { method: 'GET' }), 405, 'method not allowed', 'GET')
    await refused(await send(ACTION_HEADERS, { method: 'PUT' }), 405, 'method not allowed', 'PUT')
    for (const body of ['{ nope', '[]', 'null', '']) {
      await refused(await send(ACTION_HEADERS, { body }), 400, 'bad request', JSON.stringify(body))
    }
    expect(calls).toEqual([])
  })

  test('action checks run in order and fail closed', async () => {
    const { send, calls } = setup()
    // A wrong Origin and no token: the Origin check answers.
    await refused(await send({ ...noToken, origin: 'http://evil.example' }), 403, 'forbidden origin', 'origin before token')
    // GET with no token: the method check answers.
    await refused(await send({ host: HOST.host }, { method: 'GET' }), 405, 'method not allowed', 'method before token')
    // A form post with no token: the type check answers.
    await refused(await send({ ...noToken, 'content-type': 'text/plain' }, { body: 'a=1' }), 415, 'unsupported media type', 'type before token')
    // No token and a bad body: the token check answers.
    await refused(await send(noToken, { body: '[]' }), 403, 'bad token', 'token before body')
    // The bare /api/actions path is guarded too.
    await refused(await send(noToken, { path: '/api/actions' }), 403, 'bad token', 'bare path')
    expect(calls).toEqual([])
  })

  test('valid action reaches its route', async () => {
    const { send, calls } = setup()
    const res = await send(ACTION_HEADERS, { body: '{"n":1}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: { n: 1 } })
    expect(calls).toEqual([{ n: 1 }])
    noCorsHeaders(res)
    // The web port's origin and a charset are fine too.
    const charset = await send({ ...ACTION_HEADERS, origin: `http://localhost:${WEB}`, host: `localhost:${WEB}`, 'content-type': 'application/json; charset=utf-8' })
    expect(charset.status).toBe(200)
    // An unknown action path past the guard is a 404.
    expect((await send(ACTION_HEADERS, { path: '/api/actions/nope' })).status).toBe(404)
  })

  test('an action body over 64 KB is refused with 413 before the route runs', async () => {
    const { send, calls } = setup()
    // A JSON object of exactly `size` bytes.
    const sized = (size: number) => `{"p":"${'a'.repeat(size - 8)}"}`
    expect(sized(BODY_LIMIT)).toHaveLength(64 * 1024)
    await refused(await send(ACTION_HEADERS, { body: sized(BODY_LIMIT + 1) }), 413, 'payload too large', 'one byte over')
    await refused(await send(ACTION_HEADERS, { body: sized(1024 * 1024) }), 413, 'payload too large', '1 MB')
    // A Content-Length over the limit is refused before the body is read.
    await refused(await send({ ...ACTION_HEADERS, 'content-length': String(BODY_LIMIT + 1) }, { body: '{}' }), 413, 'payload too large', 'declared length')
    expect(calls).toEqual([])
    // Exactly at the limit reaches the route.
    const atLimit = await send(ACTION_HEADERS, { body: sized(BODY_LIMIT) })
    expect(atLimit.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  test('with no action routes, a request past the guard gets 404', async () => {
    const app = fakeApp()
    const ok = await app.request('/api/actions/echo', { method: 'POST', headers: ACTION_HEADERS, body: '{}' })
    expect(ok.status).toBe(404)
    // The guard still runs first.
    const res = await app.request('/api/actions/echo', { method: 'POST', headers: noToken, body: '{}' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'bad token' })
  })
})

describe('folder route is gone', () => {
  const READ = { ...HOST, 'x-openaflow-token': TOKEN }
  const urls = ['/api/fs/folders', `/api/fs/folders?${new URLSearchParams({ path: tmpdir() })}`, '/api/fs']

  /** Every folder URL, with and without the token, is a 404 with a JSON body. */
  async function allGone(app: Hono) {
    for (const url of urls) {
      for (const [name, headers] of [['token', READ], ['no token', HOST]] as const) {
        const res = await app.request(url, { headers })
        expect(res.status, `${url} ${name}`).toBe(404)
        expect(res.headers.get('content-type') ?? '', `${url} ${name}`).toMatch(/^application\/json/)
        expect(await res.json(), `${url} ${name}`).toEqual({ error: 'not found' })
        noCorsHeaders(res)
      }
    }
  }

  test('GET /api/fs/folders is 404 JSON in dev, with and without the token', async () => {
    await allGone(fakeApp())
  })

  test('GET /api/fs/folders is 404 JSON with the web app mounted, with and without the token', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'openaflow-app-web-')))
    try {
      await writeFile(join(root, 'index.html'), '<html><head></head><body>page</body></html>')
      await allGone(fakeApp({ web: await createWebApp({ dir: root, token: TOKEN }) }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('picker code is gone', () => {
  const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const GONE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*\/(?:folder-list|FolderPicker|folder-picker)(?:\.tsx?)?['"]/

  /** Every source file under packages/<name>/{src,scripts,test}, never node_modules or a build. */
  async function sources(): Promise<string[]> {
    const out: string[] = []
    for (const pkg of await readdir(packagesDir)) {
      for (const sub of ['src', 'scripts', 'test']) {
        const dir = join(packagesDir, pkg, sub)
        const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
        for (const e of entries) {
          if (/(^|[\\/])(node_modules|dist)([\\/]|$)/.test(e)) continue
          if (/\.(ts|tsx|mts|mjs|js)$/.test(e)) out.push(join(dir, e))
        }
      }
    }
    return out
  }

  test('no source imports folder-list, FolderPicker, or folder-picker', async () => {
    const files = await sources()
    expect(files.length).toBeGreaterThan(100)
    const importers: string[] = []
    for (const f of files) if (GONE.test(await readFile(f, 'utf8'))) importers.push(f)
    expect(importers).toEqual([])
  })

  test('the files are deleted', async () => {
    const gone = ['server/src/folder-list.ts', 'web/src/screens/runs/FolderPicker.tsx', 'web/src/screens/runs/folder-picker.ts', 'web/src/screens/runs/picker.css']
    for (const f of gone) await expect(readFile(join(packagesDir, f)), f).rejects.toThrow()
  })
})

describe('tool routes seam', () => {
  const tools: NonNullable<AppDeps['tools']> = {
    check: async () => [{ tool: 'git', state: 'missing' }],
    setPath: async () => ({ tools: [] }),
  }
  const withDeps = (extra: Partial<AppDeps>) =>
    createApp({
      ports: [API, WEB],
      token: TOKEN,
      source: fakeSource().source,
      addRepo: async () => ({ error: 'not a directory' }),
      timeline: noTimeline,
      ...extra,
    })
  const read = (app: Hono) => app.request('/api/tools', { headers: { ...HOST, 'x-openaflow-token': TOKEN } })
  const write = (app: Hono) =>
    app.request('/api/actions/tool-path', { method: 'POST', headers: ACTION_HEADERS, body: JSON.stringify({ tool: 'gh', path: null }) })

  test('dev has no tool routes', async () => {
    const dev = fakeApp()
    expect((await read(dev)).status).toBe(404)
    expect((await write(dev)).status).toBe(404)

    // The same requests reach the routes once a finder is given.
    const production = withDeps({ tools })
    expect((await read(production)).status).toBe(200)
    expect((await write(production)).status).toBe(200)
  })

  test('tool routes answer before the web app', async () => {
    const web = new Hono().all('*', (c) => c.text('page'))
    const res = await read(withDeps({ tools, web }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tools: [{ tool: 'git', state: 'missing' }] })
  })
})

describe('web seam', () => {
  /** A web app that answers everything, to show what reaches it. */
  const catchAll = () => new Hono().all('*', (c) => c.text('from web'))

  test('web app mounts after the API', async () => {
    const seen = new Hono().post('/merge', (c) => c.json({ merged: true }))
    const app = fakeApp({
      web: catchAll(),
      actions: seen,
      timeline: async () => TIMELINE,
    })
    const get = (path: string, headers: Record<string, string> = HOST) => app.request(path, { headers })

    expect(await (await get('/api/health')).json()).toEqual({ ok: true })
    expect(await (await get('/api/board')).json()).toEqual(BOARD)
    expect(await (await get('/api/agents/r/a1/timeline')).json()).toEqual(TIMELINE)
    const merged = await app.request('/api/actions/merge', { method: 'POST', headers: ACTION_HEADERS, body: '{}' })
    expect(await merged.json()).toEqual({ merged: true })
    // A guard refuses before the web app can answer.
    const noToken = await app.request('/api/repos', { method: 'POST', headers: POST_HEADERS, body: '{}' })
    expect(noToken.status).toBe(403)

    for (const path of ['/', '/some/page', '/sw.js', '/api/nope']) {
      expect(await (await get(path)).text(), path).toBe('from web')
    }
  })

  test('with no web app, a page route stays 404', async () => {
    const res = await fakeApp().request('/', { headers: HOST })
    expect(res.status).toBe(404)
  })

  test('the web app sits behind the request guard', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'openaflow-app-web-')))
    try {
      await writeFile(join(root, 'index.html'), '<html><head></head><body>page</body></html>')
      const web = await createWebApp({ dir: root, token: TOKEN })
      const app = fakeApp({ web })

      const foreign = await app.request('/', { headers: { host: 'evil.example' } })
      expect(foreign.status).toBe(403)
      const body = await foreign.text()
      expect(body).toContain('forbidden host')
      expect(body).not.toContain(TOKEN)

      const noOrigin = await app.request('/', { method: 'POST', headers: HOST })
      expect(noOrigin.status).toBe(403)
      expect(await noOrigin.json()).toEqual({ error: 'forbidden origin' })
      const withOrigin = await app.request('/', { method: 'POST', headers: { ...HOST, origin: `http://127.0.0.1:${API}` } })
      expect(withOrigin.status).toBe(404)
      expect(await withOrigin.json()).toEqual({ error: 'not found' })

      const page = await app.request('/', { headers: HOST })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain(TOKEN)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
