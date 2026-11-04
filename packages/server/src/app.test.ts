import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { AgentTimeline, Board } from '@pod-board/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp, type AppDeps, type BoardSource } from './app.ts'
import { createBoardService } from './board-service.ts'
import { listFolders, nodeFolderFs, type FolderFs } from './folder-list.ts'
import { createSessionToken } from './session-token.ts'
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
const ACTION_HEADERS = { ...POST_HEADERS, 'x-pod-board-token': TOKEN }
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

function fakeApp(opts: { pingMs?: number; source?: BoardSource; timeline?: TimelineFn; actions?: Hono; folders?: AppDeps['folders'] } = {}): Hono {
  return createApp({
    ports: [API, WEB],
    token: TOKEN,
    ...(opts.folders === undefined ? {} : { folders: opts.folders }),
    ...(opts.actions === undefined ? {} : { actions: opts.actions }),
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
    root = await mkdtemp(join(tmpdir(), 'pod-board-a1-app-'))
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
      ['empty token', { ...POST_HEADERS, 'x-pod-board-token': '' }],
      ['wrong token', { ...POST_HEADERS, 'x-pod-board-token': wrong }],
      ['shorter token', { ...POST_HEADERS, 'x-pod-board-token': TOKEN.slice(1) }],
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
    expect((await app.request('/api/repos', { headers: { ...HOST, 'x-pod-board-token': TOKEN } })).status).toBe(405)
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
  const { 'x-pod-board-token': _token, ...noToken } = ACTION_HEADERS

  const refused = async (res: Response, status: number, error: string, label: string) => {
    expect(res.status, label).toBe(status)
    expect(await res.json(), label).toEqual({ error })
    noCorsHeaders(res)
  }

  test('action without token is refused', async () => {
    const { send, calls } = setup()
    await refused(await send(noToken), 403, 'bad token', 'no token')
    await refused(await send({ ...noToken, 'x-pod-board-token': '' }), 403, 'bad token', 'empty token')
    expect(calls).toEqual([])
  })

  test('action with wrong token is refused', async () => {
    const { send, calls } = setup()
    const wrong = createSessionToken()
    expect(wrong).toHaveLength(TOKEN.length)
    await refused(await send({ ...ACTION_HEADERS, 'x-pod-board-token': wrong }), 403, 'bad token', 'same length')
    await refused(await send({ ...ACTION_HEADERS, 'x-pod-board-token': TOKEN.slice(1) }), 403, 'bad token', 'shorter')
    await refused(await send({ ...ACTION_HEADERS, 'x-pod-board-token': TOKEN + 'x' }), 403, 'bad token', 'longer')
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
    await refused(await send({ host: HOST.host, 'x-pod-board-token': TOKEN }, { method: 'GET' }), 405, 'method not allowed', 'GET')
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

describe('folder listing route', () => {
  const READ = { ...HOST, 'x-pod-board-token': TOKEN }
  let root: string
  let seen: (string | undefined)[]
  let app: Hono
  const url = (dir?: string) => (dir === undefined ? '/api/fs/folders' : `/api/fs/folders?${new URLSearchParams({ path: dir })}`)

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pod-board-folders-')))
    await mkdir(join(root, 'b-repo', 'pod-docs'), { recursive: true })
    await mkdir(join(root, 'A plus+space'))
    await writeFile(join(root, 'f.txt'), 'secret')
    seen = []
    app = fakeApp({
      folders: (dir) => {
        seen.push(dir)
        return listFolders(dir, { fs: nodeFolderFs, platform, home: root })
      },
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('200 with the subfolders of a real folder', async () => {
    const res = await app.request(url(root), { headers: READ })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: root,
      parent: dirname(root),
      locked: false,
      truncated: false,
      folders: [
        { name: 'A plus+space', path: join(root, 'A plus+space'), podDocs: false },
        { name: 'b-repo', path: join(root, 'b-repo'), podDocs: true },
      ],
    })
    noCorsHeaders(res)
  })

  test('200 with the roots when no path is given', async () => {
    const res = await app.request(url(), { headers: READ })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: unknown; parent: unknown; folders: { path: string }[] }
    expect([body.path, body.parent]).toEqual([null, null])
    expect(body.folders.length).toBeGreaterThan(0)
    for (const f of body.folders) expect(isAbsolute(f.path), f.path).toBe(true)
    expect(seen).toEqual([undefined])
  })

  test('every error code and body', async () => {
    const cases: [string, Record<string, string>, string, number, string][] = [
      ['no token', HOST, url(root), 403, 'bad token'],
      ['wrong token', { ...HOST, 'x-pod-board-token': 'k'.repeat(43) }, url(root), 403, 'bad token'],
      ['token in the URL', HOST, `${url(root)}&token=${TOKEN}`, 403, 'bad token'],
      ['foreign host', { ...READ, host: `evil.example:${API}` }, url(root), 403, 'forbidden host'],
      ['relative', READ, url('some/folder'), 400, 'not absolute'],
      ['empty', READ, url(''), 400, 'not absolute'],
      ['NUL', READ, url(`${root}\0x`), 400, 'bad request'],
      ['missing', READ, url(join(root, 'nope')), 404, 'not a directory'],
      ['a file', READ, url(join(root, 'f.txt')), 404, 'not a directory'],
    ]
    for (const [name, headers, target, status, error] of cases) {
      const res = await app.request(target, { headers })
      expect(res.status, name).toBe(status)
      expect(await res.json(), name).toEqual({ error })
      noCorsHeaders(res)
    }
    // The guard's refusals never reached the listing.
    expect(seen).toEqual(['some/folder', '', `${root}\0x`, join(root, 'nope'), join(root, 'f.txt')])
  })

  test('a network path is refused before any file system call', async () => {
    const calls: string[] = []
    const record = (op: string) => async (p: string) => {
      calls.push(`${op} ${p}`)
      throw new Error('no file system in this test')
    }
    const fs: FolderFs = { readdir: record('readdir'), stat: record('stat'), lstat: record('lstat'), readlink: record('readlink') }
    const win = fakeApp({ folders: (dir) => listFolders(dir, { fs, platform: 'win32', home: 'C:\\Users\\u' }) })
    for (const dir of ['\\\\host\\share', '//host/share', '\\\\?\\C:\\x', '\\\\.\\C:']) {
      const res = await win.request(url(dir), { headers: READ })
      expect(res.status, dir).toBe(400)
      expect(await res.json()).toEqual({ error: 'not a local path' })
    }
    const res = await win.request(url('C:x'), { headers: READ })
    expect([res.status, await res.json()]).toEqual([400, { error: 'not absolute' }])
    expect(calls).toEqual([])
  })

  test('only GET answers, and with no listing the route gets 404 behind the guard', async () => {
    expect((await app.request(url(root), { method: 'POST', headers: { ...ACTION_HEADERS }, body: '{}' })).status).toBe(404)
    const bare = fakeApp()
    expect((await bare.request(url(root), { headers: READ })).status).toBe(404)
    const refused = await bare.request(url(root), { headers: HOST })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'bad token' })
  })
})
