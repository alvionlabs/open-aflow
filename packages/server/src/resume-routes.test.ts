import { realpathSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepoModel, type AgentRun, type Board, type BoardRepo, type NewActionEntry, type PrStatus, type RepoFiles, type ResumeResult } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createAutoContinueStore, type AutoContinueStore } from './auto-continue-store.ts'
import type { StartResult } from './claude-runner.ts'
import { createResumeRoutes } from './resume-routes.ts'
import { createSessionToken } from './session-token.ts'

const API = 3060
const WEB = 3061
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-openaflow-token': TOKEN }

let root: string
let file: string

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'openaflow-s1-routes-')))
  file = join(root, 'cfg', 'auto-continue.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

type Start = { session: string; word: string; cwd: string }

type SetupOpts = {
  board: Board
  result?: () => Promise<StartResult> | StartResult
  idle?: boolean
  append?: (e: NewActionEntry) => Promise<boolean>
  store?: AutoContinueStore
  inFlight?: Set<string>
  token?: boolean
}

/** The resume routes behind the real app and guard, with a fake runner (never a real claude) and a fake clock. */
function setup(o: SetupOpts) {
  let board = o.board
  const events: string[] = []
  const logged: NewActionEntry[] = []
  const starts: Start[] = []
  const running = new Set<string>()
  const idleAsked: string[] = []
  const store = o.store ?? createAutoContinueStore({ file })
  const inFlight = o.inFlight ?? new Set<string>()
  const runner = {
    start: async (r: Start) => {
      events.push('start')
      starts.push(r)
      return (o.result ?? (() => ({ outcome: 'started' }) as StartResult))()
    },
    isRunning: (s: string) => running.has(s),
  }
  // The rebuild fills autoContinue from the store, as the board service does.
  const rebuild = async () => {
    events.push('rebuild')
    board = { ...board, autoContinue: store.list().flatMap(({ path, run }) => board.repos.filter((r) => r.path === path).map((r) => ({ repoId: r.id, run }))) }
  }
  const routes = createResumeRoutes({
    board: () => board,
    rebuild,
    log: {
      append: async (e) => {
        events.push('log')
        if (o.append) return o.append(e)
        logged.push(e)
        return true
      },
    },
    runner,
    store,
    idle: (_repo, session) => {
      idleAsked.push(session)
      return o.idle ?? true
    },
    inFlight,
    now: () => NOW,
  })
  const source = { board: () => board, subscribe: () => () => {}, rebuild }
  const app = createApp({ ports: [API, WEB], token: TOKEN, source, addRepo: async () => ({ error: 'not a directory' }), timeline: async () => undefined, actions: new Hono().route('/', routes) })
  const headers = o.token === false ? { ...HEADERS, 'x-openaflow-token': '' } : HEADERS
  const post = (path: string, body: unknown) => app.request(`/api/actions/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return {
    resume: (body: unknown) => post('resume', body),
    toggle: (body: unknown) => post('auto-continue', body),
    events,
    logged,
    starts,
    running,
    idleAsked,
    store,
    inFlight,
    board: () => board,
  }
}

const json = async <T = unknown>(res: Response) => (await res.json()) as T
const expectRes = async (res: Response, status: number, body: unknown, label = '') => {
  expect(res.status, label).toBe(status)
  expect(await res.json(), label).toEqual(body)
}

describe('resume route', () => {
  test('refuses in order and runs nothing', async () => {
    // 1. Shape wrong, or a reply that isn't continue or go → 400.
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)) })
    const shapes: unknown[] = [
      {},
      { repoId: 'id-r', run: 'alpha' },
      { repoId: 'id-r', reply: 'continue' },
      { run: 'alpha', reply: 'continue' },
      { repoId: 7, run: 'alpha', reply: 'continue' },
      { repoId: 'id-r', run: ['alpha'], reply: 'continue' },
      { repoId: 'id-r', run: 'alpha', reply: 'Continue' },
      { repoId: 'id-r', run: 'alpha', reply: 'try' },
      { repoId: 'id-r', run: 'alpha', reply: null },
    ]
    for (const body of shapes) await expectRes(await s.resume(body), 400, { error: 'bad request' }, JSON.stringify(body))

    // 2. Repo not on the Board, or nothing sendable → 404 not waiting on you. Checked before busy.
    const busy = setup({ board: boardOf(planRepo(SPRINT_DONE), planRepo(WORKING, { id: 'id-w' })), idle: false })
    await expectRes(await busy.resume({ repoId: 'id-gone', run: 'alpha', reply: 'continue' }), 404, { error: 'not waiting on you' })
    await expectRes(await busy.resume({ repoId: 'id-w', run: 'alpha', reply: 'continue' }), 404, { error: 'not waiting on you' })
    await expectRes(await busy.resume({ repoId: 'id-r', run: 'beta', reply: 'continue' }), 404, { error: 'not waiting on you' })

    // 3. No session, or one with an unsafe id → 404 no session. Checked before busy.
    const noSession = setup({ board: boardOf(planRepo(SPRINT_DONE, { session: '' }), planRepo(SPRINT_DONE, { id: 'id-u', session: 'bad id;rm' })), idle: false })
    await expectRes(await noSession.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 404, { error: 'no session' })
    await expectRes(await noSession.resume({ repoId: 'id-u', run: 'alpha', reply: 'continue' }), 404, { error: 'no session' })
    // idle is only asked about a safe session, after the checks before it.
    expect([...busy.idleAsked, ...noSession.idleAsked]).toEqual([])

    // 4. Not idle → 409 busy, even with a resume in flight.
    const inFlight = new Set(['sess-1'])
    const both = setup({ board: boardOf(planRepo(SPRINT_DONE)), idle: false, inFlight })
    await expectRes(await both.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 409, { error: 'session is busy' })

    // 5. A request in flight, or a running child → 409 resume in progress.
    const held = setup({ board: boardOf(planRepo(SPRINT_DONE)), inFlight })
    await expectRes(await held.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 409, { error: 'resume in progress' })
    const live = setup({ board: boardOf(planRepo(SPRINT_DONE)) })
    live.running.add('sess-1')
    await expectRes(await live.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 409, { error: 'resume in progress' })

    // Nothing ran, nothing was logged, and nothing was rebuilt.
    for (const x of [s, busy, noSession, both, held, live]) {
      expect(x.starts).toEqual([])
      expect(x.logged).toEqual([])
      expect(x.events).toEqual([])
    }
  })

  test('sends only sendable replies', async () => {
    const s = setup({ board: boardOf(planRepo(WAVE_WAITING), planRepo(SPRINT_DONE, { id: 'id-d' }), planRepo(FRESH, { id: 'id-f' })) })
    // continue on a run waiting on your merge.
    await expectRes(await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 404, { error: 'not waiting on you' })
    // go on a plan with a started sprint.
    await expectRes(await s.resume({ repoId: 'id-d', run: 'alpha', reply: 'go' }), 404, { error: 'not waiting on you' })
    // continue on a fresh plan.
    await expectRes(await s.resume({ repoId: 'id-f', run: 'alpha', reply: 'continue' }), 404, { error: 'not waiting on you' })
    // try is never a send.
    await expectRes(await s.resume({ repoId: 'id-f', run: 'alpha', reply: 'try' }), 400, { error: 'bad request' })
    expect(s.starts).toEqual([])

    // go on a fresh plan is sent.
    const res = await s.resume({ repoId: 'id-f', run: 'alpha', reply: 'go' })
    expect(res.status).toBe(200)
    expect(s.starts).toEqual([{ session: 'sess-1', word: 'go', cwd: '/id-f' }])
  })

  test('sends continue on an answered stop, only when idle', async () => {
    // Not answered yet: nothing to send.
    const halted = setup({ board: boardOf(planRepo(HALTED)) })
    await expectRes(await halted.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 404, { error: 'not waiting on you' })
    // Answered, session busy: 409, nothing ran.
    const busy = setup({ board: boardOf(planRepo(ANSWERED)), idle: false })
    await expectRes(await busy.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 409, { error: 'session is busy' })
    expect(busy.starts).toEqual([])
    // Answered and idle: sent, and the toggle's lastKey is the answered key.
    const s = setup({ board: boardOf(planRepo(ANSWERED)) })
    await s.store.set('/r', 'alpha', true)
    await expectRes(await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 200, { outcome: 'started', logged: true })
    expect(s.starts).toEqual([{ session: 'sess-1', word: 'continue', cwd: '/r' }])
    expect(s.store.list()[0]?.lastKey).toMatch(/^answered:alpha:1:[0-9a-f]{8}$/)
    // go is never sent on it.
    await expectRes(await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'go' }), 404, { error: 'not waiting on you' })
  })

  test('starts and logs a resume', async () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)) })
    await s.store.set('/r', 'alpha', true)
    const res = await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })
    expect(res.status).toBe(200)
    expect(await json<ResumeResult>(res)).toEqual({ outcome: 'started', logged: true })
    expect(s.starts).toEqual([{ session: 'sess-1', word: 'continue', cwd: '/r' }])
    expect(s.logged).toEqual([{ action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'started', reply: 'continue', auto: false }])
    // The Board was rebuilt (with the new entry) before the response.
    expect(s.events).toEqual(['start', 'log', 'rebuild'])
    // A continue sets the toggle's lastKey, so the automatic check won't send this stop again.
    expect(s.store.list()).toEqual([{ path: '/r', run: 'alpha', lastKey: 'sprint-done:one' }])
    // The session is free again.
    expect(s.inFlight.size).toBe(0)

    // No toggle → none is added. go never sets a lastKey.
    const t = setup({ board: boardOf(planRepo(SPRINT_DONE), planRepo(FRESH, { id: 'id-f', session: 'sess-2' })), store: createAutoContinueStore({ file: join(root, 'other.json') }) })
    await t.store.set('/id-f', 'alpha', true)
    expect((await t.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })).status).toBe(200)
    expect((await t.resume({ repoId: 'id-f', run: 'alpha', reply: 'go' })).status).toBe(200)
    expect(t.store.list()).toEqual([{ path: '/id-f', run: 'alpha' }])
    expect(t.logged.map((e) => e.target)).toEqual(['alpha · continue', 'alpha · go'])
  })

  test('logs a failed start', async () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), result: () => ({ outcome: 'failed', message: 'claude not found' }) })
    const res = await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ outcome: 'failed', message: 'claude not found', logged: true })
    expect(s.logged).toEqual([
      { action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'failed', message: 'claude not found', reply: 'continue', auto: false },
    ])

    // A runner that throws is a failed start too.
    const t = setup({
      board: boardOf(planRepo(SPRINT_DONE)),
      result: () => {
        throw new Error('spawn EPERM')
      },
    })
    const thrown = await t.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })
    expect(await json(thrown)).toEqual({ outcome: 'failed', message: 'spawn EPERM', logged: true })
    expect(t.inFlight.size).toBe(0)
  })

  test('one resume per session', async () => {
    let release!: (r: StartResult) => void
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), result: () => new Promise<StartResult>((r) => (release = r)) })
    const first = s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })
    await new Promise((r) => setTimeout(r, 0))
    await expectRes(await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 409, { error: 'resume in progress' })
    release({ outcome: 'started' })
    expect((await first).status).toBe(200)
    expect(s.starts).toHaveLength(1)
    expect(s.logged).toHaveLength(1)
  })

  test('reports an unlogged resume', async () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), append: async () => false })
    const res = await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ outcome: 'started', logged: false })

    const t = setup({
      board: boardOf(planRepo(SPRINT_DONE)),
      append: async () => {
        throw new Error('EACCES')
      },
    })
    expect(await json(await t.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }))).toEqual({ outcome: 'started', logged: false })
    expect(t.events).toEqual(['start', 'log', 'rebuild'])
  })

  test('a lastKey that fails to save still sends the resume', async () => {
    const real = createAutoContinueStore({ file })
    await real.set('/r', 'alpha', true)
    const store: AutoContinueStore = {
      list: () => real.list(),
      set: (...a) => real.set(...a),
      forgetPath: (...a) => real.forgetPath(...a),
      saveKey: async () => {
        throw new Error('disk full')
      },
    }
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store })
    const res = await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })
    expect(await json(res)).toEqual({ outcome: 'started', logged: true })
    expect(s.starts).toHaveLength(1)
    expect(real.list()).toEqual([{ path: '/r', run: 'alpha' }])
  })

  test('sits behind the action guard', async () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), token: false })
    await expectRes(await s.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' }), 403, { error: 'bad token' })
    await expectRes(await s.toggle({ repoId: 'id-r', run: 'alpha', on: true }), 403, { error: 'bad token' })
    expect(s.starts).toEqual([])
    expect(s.store.list()).toEqual([])
    // The same requests with the token pass: the guard, not a missing route, refused them.
    const ok = setup({ board: boardOf(planRepo(SPRINT_DONE)), store: createAutoContinueStore({ file: join(root, 'ok.json') }) })
    expect((await ok.resume({ repoId: 'id-r', run: 'alpha', reply: 'continue' })).status).toBe(200)
    expect(ok.starts).toHaveLength(1)
    await expectRes(await ok.toggle({ repoId: 'id-r', run: 'alpha', on: true }), 200, { on: true })
  })
})

describe('auto-continue route', () => {
  test('toggles auto-continue', async () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE), fixRepo('merged')) })
    expect(s.board().autoContinue).toBeUndefined()

    await expectRes(await s.toggle({ repoId: 'id-r', run: 'alpha', on: true }), 200, { on: true })
    expect(s.store.list()).toEqual([{ path: '/r', run: 'alpha' }])
    expect(createAutoContinueStore({ file }).list()).toEqual([{ path: '/r', run: 'alpha' }])
    expect(s.board().autoContinue).toEqual([{ repoId: 'id-r', run: 'alpha' }])

    // A fix run is a run too.
    await expectRes(await s.toggle({ repoId: 'id-x', run: FIX, on: true }), 200, { on: true })
    expect(s.board().autoContinue).toEqual([
      { repoId: 'id-r', run: 'alpha' },
      { repoId: 'id-x', run: FIX },
    ])

    await expectRes(await s.toggle({ repoId: 'id-r', run: 'alpha', on: false }), 200, { on: false })
    expect(s.board().autoContinue).toEqual([{ repoId: 'id-x', run: FIX }])
    expect(s.events).toEqual(['rebuild', 'rebuild', 'rebuild'])

    // Not a listed run of that repo → 404.
    await expectRes(await s.toggle({ repoId: 'id-r', run: 'beta', on: true }), 404, { error: 'not a run' })
    await expectRes(await s.toggle({ repoId: 'id-gone', run: 'alpha', on: true }), 404, { error: 'not a run' })
    await expectRes(await s.toggle({ repoId: 'id-r', run: FIX, on: true }), 404, { error: 'not a run' })

    // Shape wrong → 400.
    for (const body of [{}, { repoId: 'id-r', run: 'alpha' }, { repoId: 'id-r', run: 'alpha', on: 'true' }, { repoId: 1, run: 'alpha', on: true }, { repoId: 'id-r', on: true }]) {
      await expectRes(await s.toggle(body), 400, { error: 'bad request' }, JSON.stringify(body))
    }
    expect(s.store.list()).toEqual([{ path: '/x', run: FIX }])
  })

  test('keeps the toggle when saving fails', async () => {
    const real = createAutoContinueStore({ file })
    await real.set('/r', 'alpha', true)
    const failing = createAutoContinueStore({
      file,
      write: async () => {
        throw new Error('disk full')
      },
    })
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store: failing })
    await expectRes(await s.toggle({ repoId: 'id-r', run: 'alpha', on: false }), 500, { error: "Couldn't save the toggle." })
    expect(failing.list()).toEqual([{ path: '/r', run: 'alpha' }])
    expect(createAutoContinueStore({ file }).list()).toEqual([{ path: '/r', run: 'alpha' }])
    await expectRes(await s.toggle({ repoId: 'id-r', run: 'alpha', on: true }), 500, { error: "Couldn't save the toggle." })
    expect(s.events).toEqual([])
  })
})

// ---- Inline Boards: plan and fix runs at a chosen stop, built with the model's own parser. ----

const FIX = 'fix-scroll'
/** A fix run whose reviewed PR is `state`, repo id `id-x`. */
function fixRepo(state: PrStatus['state']): BoardRepo {
  const eng = agent({ branch: FIX, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
  const rev = agent({ type: 'pod:reviewer', kind: 'fix', branch: FIX, startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })
  return {
    id: 'id-x',
    name: 'x',
    path: '/x',
    source: 'registered',
    model: buildRepoModel({ 'pod-docs/README.md': README }),
    agents: [eng, rev],
    prs: [gh(36, state, { branch: FIX })],
    claims: [{ portBase: 3100, repoPath: '/x', plan: FIX }],
  }
}



const NOW = Date.UTC(2026, 9, 22, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string]

function planDoc(slug: string, sprints: SprintRow[]): string {
  return [
    `# Plan: ${slug}`,
    '',
    '_Generated: 2026-10-22 · Status: active · Grilled-with: grilling_',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, st]) => `| ${s} | goal of ${s} | ${st} | — |`),
    '',
  ].join('\n')
}

function sprintDoc(slug: string, plan: string, rows: BoardRow[]): string {
  return [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-10-22_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    ...rows.map(([w, code, pr, status]) => `| ${w} | ${code} | Title ${code} | ${slug}-${code} | ${pr} | ${status} | medium | — |`),
    '',
  ].join('\n')
}

type Stop = { sprints: SprintRow[]; docs?: Record<string, BoardRow[]>; prs?: PrStatus[]; queue?: string[] }

const link = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })

const PUSHED: BoardRow[] = [
  [1, 'A1', `${link(5)} merged`, 'done'],
  [2, 'B1', link(7), 'pushed'],
]

/** Sprint one done, two not drafted yet: `continue`, key `sprint-done:one`. */
const SPRINT_DONE: Stop = { sprints: [['one', 'done'], ['two', 'planned']], docs: { one: [[1, 'A1', 'merged', 'done']] } }
/** Sprints one and two done, three next: `continue`, key `sprint-done:two`. */
const NEXT_SPRINT_DONE: Stop = {
  sprints: [['one', 'done'], ['two', 'done'], ['three', 'planned']],
  docs: { one: [[1, 'A1', 'merged', 'done']], two: [[1, 'B1', 'merged', 'done']] },
}
/** Wave 2's PR open: `continue` after your merge (not sendable). */
const WAVE_WAITING: Stop = { sprints: [['one', 'active']], docs: { one: PUSHED }, prs: [gh(7, 'open')] }
/** Wave 2's PR merged: `continue`, key `wave-merged:7`. */
const WAVE_MERGED: Stop = { sprints: [['one', 'active']], docs: { one: PUSHED }, prs: [gh(7, 'merged')] }
/** No sprint started: `go`, key `not-started:alpha`. */
const FRESH: Stop = { sprints: [['one', 'planned'], ['two', 'planned']] }
const HALT = '- `[2026-10-22 · BLOCKED · orchestrator → human · plan: alpha]` Halted at gate 1. **Resolution:** pending'
/** Halted, the halt answered on the board: `continue`, key `answered:alpha:1:<hash>`. */
const ANSWERED: Stop = { sprints: [['one', 'active']], docs: { one: [[1, 'A1', '', 'in progress']] }, queue: [`${HALT} **Answer (human):** retry`] }
/** Halted, not answered yet: no reply. */
const HALTED: Stop = { ...ANSWERED, queue: [HALT] }
/** Sprint one in progress with work left: no reply at all. */
const WORKING: Stop = { sprints: [['one', 'active']], docs: { one: [[1, 'A1', '', 'in progress']] } }

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: true, startedAt: NOW - 60 * MIN, lastAt: NOW - 40 * MIN, ...over }
}

/** A repo whose plan `alpha` is at `stop`, with one ended agent in `session` (none when `session` is empty). */
function planRepo(stop: Stop, o: { session?: string; id?: string; path?: string } = {}): BoardRepo {
  const files: RepoFiles = {
    'pod-docs/README.md': README,
    'pod-docs/plans/alpha.md': planDoc('alpha', stop.sprints),
    'pod-docs/handoff-queue.md': (stop.queue ?? []).join('\n'),
  }
  for (const [s, rows] of Object.entries(stop.docs ?? {})) files[`pod-docs/sprints/${s}.md`] = sprintDoc(s, 'alpha', rows)
  const session = o.session ?? 'sess-1'
  return {
    id: o.id ?? 'id-r',
    name: 'r',
    path: o.path ?? (o.id === undefined || o.id === 'id-r' ? '/r' : `/${o.id}`),
    source: 'registered',
    model: buildRepoModel(files),
    agents: session === '' ? [] : [agent({ plan: 'alpha', session })],
    prs: stop.prs ?? [],
    claims: [],
  }
}

const boardOf = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos })
