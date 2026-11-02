import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board, NewActionEntry } from '@pod-board/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createActionRoutes } from './action-routes.ts'
import { createTimelineSource } from './agent-timeline.ts'
import { createAnswerRoutes } from './answer-routes.ts'
import { createApp } from './app.ts'
import { createAutoContinue } from './auto-continue.ts'
import { createAutoContinueStore } from './auto-continue-store.ts'
import { createBoardService } from './board-service.ts'
import { createGhReader, type GhExec } from './gh.ts'
import { repoId } from './guard.ts'
import { createRemoveRepoRoutes } from './remove-repo-routes.ts'
import { removeRepo } from './repos-config.ts'
import { createResumeRoutes } from './resume-routes.ts'
import { createSessionToken } from './session-token.ts'
import { projectDirName } from './transcript-files.ts'

// Two repos whose paths differ only in a symbol, through the real routes, board service, and temp folders.
// Every test targets chess_web, which sorts second: a route that takes the first repo with the id hits chess-web.

const API = 3060
const WEB = 3061
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-pod-board-token': TOKEN }
const NOW = Date.parse('2026-11-02T12:00:00Z')
const platform = process.platform
const SHA = 'a'.repeat(40)
const SESSION = 'sess-1'

const ANSWER = '- `[2026-11-01 · PENDING · engineer → human · plan: alpha]` which colour? **Resolution:** pending'
const KEEP = '- `[2026-11-01 · PENDING · engineer → human · plan: alpha]` decision: badge colour? value in use: `white`. Answer to change. **Resolution:** pending'

const plan = (slug: string, rows: string[]) =>
  [`# Plan: ${slug}`, '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', ...rows, ''].join('\n')
const sprint = (slug: string, planSlug: string, rows: string[]) =>
  [`# Sprint: ${slug}`, '', `_From plan: pod-docs/plans/${planSlug}.md · Slug: ${slug} · Status: active · Generated: 2026-11-01_`, '', '## Status board', '', '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', '|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n')

let root: string
let cfgFile: string
let hyphen: string
let underscore: string

/** Plan alpha stopped after sprint one (`continue` is sendable); plan beta with wave 2 waiting on PR #7; two open queue entries. */
async function makeRepo(path: string) {
  await mkdir(join(path, 'pod-docs', 'plans'), { recursive: true })
  await mkdir(join(path, 'pod-docs', 'sprints'), { recursive: true })
  await writeFile(join(path, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  await writeFile(join(path, 'pod-docs', 'plans', 'alpha.md'), plan('alpha', ['| one | goal | done | — |', '| two | goal | planned | — |']))
  await writeFile(join(path, 'pod-docs', 'plans', 'beta.md'), plan('beta', ['| b-one | goal | active | — |']))
  await writeFile(join(path, 'pod-docs', 'sprints', 'one.md'), sprint('one', 'alpha', ['| 1 | A1 | a | one-A1 | merged | done | high | — |']))
  await writeFile(
    join(path, 'pod-docs', 'sprints', 'b-one.md'),
    sprint('b-one', 'beta', ['| 1 | C1 | c | b-one-C1 | [#5](https://github.com/o/r/pull/5) merged | done | high | — |', '| 2 | D1 | d | b-one-D1 | [#7](https://github.com/o/r/pull/7) | pushed | high | — |']),
  )
  await writeFile(join(path, 'pod-docs', 'handoff-queue.md'), ['# Handoff Queue', '', ANSWER, KEEP, ''].join('\n'))
}

/** One stale engineer of sprint one, with a Read of `file`. Both repos list it: Claude's project folder name is the same for both. */
async function engineer(file: string) {
  const sub = join(root, 'claude', 'projects', projectDirName(hyphen), SESSION, 'subagents')
  await mkdir(sub, { recursive: true })
  await writeFile(join(sub, 'agent-eng1.meta.json'), JSON.stringify({ agentType: 'pod:engineer', description: 'Build A1' }))
  const at = (min: number) => new Date(NOW - 120 * 60_000 + min * 60_000).toISOString()
  const lines = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: '- **sprint slug:** one\n- **slice code:** A1\n- **branch name:** one-A1\n' } },
    { type: 'assistant', timestamp: at(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: file } }] } },
  ]
  await writeFile(join(sub, 'agent-eng1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const writeConfig = (...paths: string[]) => writeFile(cfgFile, JSON.stringify({ version: 1, repos: paths.map((path) => ({ path })) }))

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pod-board-clash-')))
  hyphen = join(root, 'repos', 'chess-web')
  underscore = join(root, 'repos', 'chess_web')
  await makeRepo(hyphen)
  await makeRepo(underscore)
  cfgFile = join(root, 'cfg', 'config.json')
  await mkdir(join(root, 'cfg'), { recursive: true })
  await mkdir(join(root, 'ports'))
  await writeConfig(hyphen, underscore)
  await engineer(join(underscore, 'src', 'deep', 'x.ts'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function setup() {
  const logged: NewActionEntry[] = []
  const log = {
    append: async (e: NewActionEntry) => {
      logged.push(e)
      return true
    },
  }
  const ghCwds: string[] = []
  const exec = (async (args: string[], cwd: string) => {
    if (args[0] === 'auth') return { status: 'ok', stdout: '' }
    if (args[1] === 'list') return { status: 'ok', stdout: '[]' }
    if (args[1] === 'view') {
      ghCwds.push(cwd)
      return {
        status: 'ok',
        stdout: JSON.stringify({ number: Number(args[2]), state: 'OPEN', url: `https://github.com/o/r/pull/${args[2]}`, title: 'PR', headRefOid: SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], autoMergeRequest: null }),
      }
    }
    return { status: 'failed', stdout: '', stderr: 'unexpected' }
  }) as GhExec
  const gh = createGhReader({ exec, now: () => NOW })
  const store = createAutoContinueStore({ file: join(root, 'cfg', 'auto-continue.json') })
  const service = createBoardService({
    configFile: cfgFile,
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform,
    gh,
    now: () => NOW,
    autoContinue: store.list,
    retireRepoIds: store.dropRepoIds,
  })
  let board: Board = await service.build()
  await service.refreshGh(board)
  board = await service.build()
  const rebuild = async () => {
    board = await service.build()
  }
  const source = { board: () => board, subscribe: () => () => {}, rebuild }
  const starts: { session: string; word: string; cwd: string }[] = []
  const runner = {
    start: async (r: { session: string; word: string; cwd: string }) => {
      starts.push(r)
      return { outcome: 'started' as const }
    },
    isRunning: () => false,
  }
  const resume = { board: source.board, rebuild, log, runner, store, idle: () => true, inFlight: new Set<string>(), now: () => NOW }
  const auto = createAutoContinue({ ...resume, subscribe: () => () => {} })
  const app = createApp({
    ports: [API, WEB],
    token: TOKEN,
    source,
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: createTimelineSource({ board: source.board, claudeDir: join(root, 'claude'), transcriptDays: 30, now: () => NOW }).timeline,
    actions: new Hono()
      .route('/', createActionRoutes({ board: source.board, gh, exec, refreshGh: (b) => service.refreshGh(b), rebuild, log, now: () => NOW }))
      .route('/', createAnswerRoutes({ board: source.board, rebuild, log }))
      .route('/', createResumeRoutes(resume))
      .route('/', createRemoveRepoRoutes({ board: source.board, removeRepo: (p) => removeRepo(cfgFile, p, platform), rebuild, log })),
  })
  const post = (path: string, body: unknown) => app.request(`/api/actions/${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  /** The id of the repo at `path` on the current Board. */
  const idOf = (path: string) => board.repos.find((r) => r.path === path)!.id
  return { app, post, idOf, board: () => board, rebuild, auto, store, starts, ghCwds, logged }
}

const queueOf = (path: string) => readFile(join(path, 'pod-docs', 'handoff-queue.md'), 'utf8')

describe('two repos whose paths differ only in a symbol', () => {
  test('merge-preview reads the targeted repo', async () => {
    const s = await setup()
    s.ghCwds.length = 0
    const res = await s.post('merge-preview', { repoId: s.idOf(underscore), number: 7 })
    expect(res.status).toBe(200)
    expect(s.ghCwds).toEqual([underscore])
  })

  test('answer writes only the targeted repo’s queue', async () => {
    const s = await setup()
    const untouched = await queueOf(hyphen)
    const res = await s.post('answer', { repoId: s.idOf(underscore), line: ANSWER, text: 'green' })
    expect(await res.json()).toMatchObject({ outcome: 'answered' })
    expect(await queueOf(underscore)).toContain('Answer (human)')
    expect(await queueOf(hyphen)).toBe(untouched)
  })

  test('resolve writes only the targeted repo’s queue', async () => {
    const s = await setup()
    const untouched = await queueOf(hyphen)
    const res = await s.post('resolve', { repoId: s.idOf(underscore), line: KEEP, kind: 'keep' })
    expect(await res.json()).toMatchObject({ outcome: 'kept' })
    expect(await queueOf(underscore)).not.toContain(KEEP)
    expect(await queueOf(hyphen)).toBe(untouched)
  })

  test('resume starts in the targeted repo', async () => {
    const s = await setup()
    const res = await s.post('resume', { repoId: s.idOf(underscore), run: 'alpha', reply: 'continue' })
    expect(await res.json()).toMatchObject({ outcome: 'started' })
    expect(s.starts.map((x) => x.cwd)).toEqual([underscore])
  })

  test('auto-continue turns on and sends for the targeted repo only', async () => {
    const s = await setup()
    const res = await s.post('auto-continue', { repoId: s.idOf(underscore), run: 'alpha', on: true })
    expect(await res.json()).toEqual({ on: true })
    expect(s.store.list().map((t) => t.repoId)).toEqual([s.idOf(underscore)])
    await s.auto.check()
    expect(s.starts.map((x) => x.cwd)).toEqual([underscore])
  })

  test('remove-repo with only the id removes the targeted repo', async () => {
    const s = await setup()
    const res = await s.post('remove-repo', { repoId: s.idOf(underscore) })
    expect(await res.json()).toMatchObject({ outcome: 'removed', path: underscore })
    expect(JSON.parse(await readFile(cfgFile, 'utf8')).repos).toEqual([{ path: hyphen }])
    expect(s.board().repos.map((r) => r.path)).toEqual([hyphen])
  })

  test('the timeline route reads with the targeted repo as root', async () => {
    const s = await setup()
    const get = async (id: string) => {
      const res = await s.app.request(`/api/agents/${id}/eng1/timeline`, { headers: HEADERS })
      expect(res.status).toBe(200)
      return ((await res.json()) as { events: { summary: string }[] }).events.map((e) => e.summary).join('\n')
    }
    // The file sits in chess_web: only that root gives its path inside the repo, not its bare name.
    expect(await get(s.idOf(underscore))).toContain('src/deep/x.ts')
    expect(await get(s.idOf(hyphen))).not.toContain('src/deep/x.ts')
  })
})

describe('a toggle stored under the plain id before a clash', () => {
  const plainId = () => repoId(hyphen, platform, platform === 'win32' || platform === 'darwin')

  test('never reaches the repo that takes the plain id after the clash ends', async () => {
    await writeConfig(hyphen)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    expect(s.store.list().map((t) => t.repoId)).toEqual([plainId()])

    // chess_web joins: a clash. Then chess-web, the repo that turned the toggle on, leaves.
    await writeConfig(hyphen, underscore)
    await s.rebuild()
    await s.post('remove-repo', { repoId: s.idOf(hyphen), path: hyphen })

    expect(s.idOf(underscore)).toBe(plainId())
    await s.auto.check()
    expect(s.starts).toEqual([])
    expect(s.board().autoContinue).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'cfg', 'auto-continue.json'), 'utf8')).runs).toEqual([])
  })

  test('stays off when the repo that turned it on is the one left', async () => {
    await writeConfig(hyphen)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    await writeConfig(hyphen, underscore)
    await s.rebuild()
    await s.post('remove-repo', { repoId: s.idOf(underscore), path: underscore })
    expect(s.idOf(hyphen)).toBe(plainId())
    await s.auto.check()
    expect(s.starts).toEqual([])
    expect(s.board().autoContinue).toEqual([])
  })

  test('a toggle under a suffixed id stays through a rebuild and a restart', async () => {
    const s = await setup()
    await s.post('auto-continue', { repoId: s.idOf(underscore), run: 'alpha', on: true })
    await s.rebuild()
    expect(s.store.list().map((t) => t.repoId)).toEqual([s.idOf(underscore)])
    const again = createAutoContinueStore({ file: join(root, 'cfg', 'auto-continue.json') })
    expect(again.list().map((t) => t.repoId)).toEqual([s.idOf(underscore)])
  })
})
