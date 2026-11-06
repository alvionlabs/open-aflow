import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board, NewActionEntry } from '@open-aflow/model'
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
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-open-aflow-token': TOKEN }
const NOW = Date.parse('2026-11-02T12:00:00Z')
const platform = process.platform
const SHA = 'a'.repeat(40)
const caseless = platform === 'win32' || platform === 'darwin'
/** How a toggle names a repo: its normalized path, case-folded where the file system ignores case. */
const keyOf = (p: string) => (caseless ? p.toLowerCase() : p)

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

/**
 * One stale engineer of sprint one in the Claude project folder both repos map to, as Claude writes it: every record
 * has a `cwd`. `cwd` is where the session started, in `<session>.jsonl` (undefined: its records have none;
 * `sessionFile: false`: no such file). `agentCwd` is where the agent started, by default the same.
 * `age` is how many minutes ago it last wrote.
 */
async function engineer(o: { session: string; cwd: string | undefined; agentCwd?: string; sessionFile?: boolean; id?: string; age?: number; file?: string }) {
  const id = o.id ?? 'eng1'
  const project = join(root, 'claude', 'projects', projectDirName(hyphen))
  const sub = join(project, o.session, 'subagents')
  await mkdir(sub, { recursive: true })
  await writeFile(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'pod:engineer', description: 'Build A1' }))
  const at = (min: number) => new Date(NOW - (o.age ?? 120) * 60_000 + min * 60_000).toISOString()
  const agentCwd = o.agentCwd ?? o.cwd
  const where = agentCwd === undefined ? {} : { cwd: agentCwd }
  if (o.sessionFile !== false) {
    // A first record with no cwd, as Claude's main chat can start.
    const main = [{ type: 'summary', summary: 's' }, { type: 'user', ...(o.cwd === undefined ? {} : { cwd: o.cwd }), message: { role: 'user', content: 'go' } }]
    await writeFile(join(project, `${o.session}.jsonl`), main.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  const lines = [
    { type: 'user', ...where, timestamp: at(-1), message: { role: 'user', content: '- **sprint slug:** one\n- **slice code:** A1\n- **branch name:** one-A1\n' } },
    { type: 'assistant', ...where, timestamp: at(0), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: o.file ?? 'x.ts' } }] } },
  ]
  await writeFile(join(sub, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const clearAgents = () => rm(join(root, 'claude'), { recursive: true, force: true })

const writeConfig = (...paths: string[]) => writeFile(cfgFile, JSON.stringify({ version: 1, repos: paths.map((path) => ({ path })) }))

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'open-aflow-clash-')))
  hyphen = join(root, 'repos', 'chess-web')
  underscore = join(root, 'repos', 'chess_web')
  await makeRepo(hyphen)
  await makeRepo(underscore)
  cfgFile = join(root, 'cfg', 'config.json')
  await mkdir(join(root, 'cfg'), { recursive: true })
  await mkdir(join(root, 'ports'))
  await writeConfig(hyphen, underscore)
  await engineer({ session: 'sess-u', cwd: underscore, file: join(underscore, 'src', 'deep', 'x.ts') })
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
      .route('/', createRemoveRepoRoutes({ board: source.board, removeRepo: (p) => removeRepo(cfgFile, p, platform), rebuild, log, forgetToggles: store.forgetPath })),
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
    expect(s.store.list().map((t) => t.path)).toEqual([keyOf(underscore)])
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

  test('the timeline route serves the targeted repo’s agent, and not to its sibling', async () => {
    const s = await setup()
    const get = (id: string) => s.app.request(`/api/agents/${id}/eng1/timeline`, { headers: HEADERS })
    const own = await get(s.idOf(underscore))
    expect(own.status).toBe(200)
    // The file sits in chess_web: only that root gives its path inside the repo, not its bare name.
    expect(((await own.json()) as { events: { summary: string }[] }).events.map((e) => e.summary).join('\n')).toContain('src/deep/x.ts')
    expect((await get(s.idOf(hyphen))).status).toBe(404)
  })
})

describe('sessions in the Claude project folder two repos share', () => {
  beforeEach(clearAgents)

  test('resume and auto-continue pick the repo’s own session, not its sibling’s newer one', async () => {
    await engineer({ session: 'sess-u', cwd: underscore, age: 300 })
    await engineer({ session: 'sess-h', cwd: hyphen, age: 120, id: 'eng2' })
    const s = await setup()
    await s.post('auto-continue', { repoId: s.idOf(underscore), run: 'alpha', on: true })
    await s.auto.check()
    expect(s.starts).toEqual([{ session: 'sess-u', word: 'continue', cwd: underscore }])
    s.starts.length = 0
    await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })
    expect(s.starts).toEqual([{ session: 'sess-h', word: 'continue', cwd: hyphen }])
  })

  test('a sibling’s session never starts: the repo lists no such agent, and nothing is sent', async () => {
    await engineer({ session: 'sess-h', cwd: hyphen })
    const s = await setup()
    expect(s.board().repos.find((r) => r.path === underscore)!.agents).toEqual([])
    expect(s.board().repos.find((r) => r.path === hyphen)!.agents.map((a) => a.session)).toEqual(['sess-h'])
    await s.post('auto-continue', { repoId: s.idOf(underscore), run: 'alpha', on: true })
    await s.auto.check()
    const res = await s.post('resume', { repoId: s.idOf(underscore), run: 'alpha', reply: 'continue' })
    expect(res.status).toBe(404)
    expect(s.starts).toEqual([])
  })

  test('a sibling’s worktree session never starts either', async () => {
    await engineer({ session: 'sess-u', cwd: join(underscore, '.claude', 'worktrees', 'w') })
    const s = await setup()
    expect(s.board().repos.find((r) => r.path === hyphen)!.agents).toEqual([])
    expect(s.board().repos.find((r) => r.path === underscore)!.agents).toHaveLength(1)
  })

  test('a transcript with no cwd stays listed and fails closed: no send, by hand or automatic', async () => {
    await writeConfig(hyphen)
    await engineer({ session: 'sess-h', cwd: undefined })
    const s = await setup()
    expect(s.board().repos[0]!.agents.map((a) => a.session)).toEqual(['sess-h'])
    await s.post('auto-continue', { repoId: s.idOf(hyphen), run: 'alpha', on: true })
    await s.auto.check()
    const res = await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })
    expect(await res.json()).toEqual({ error: 'no session' })
    expect(s.starts).toEqual([])
  })

  test('an agent that started outside any sibling stays listed, and sends nothing', async () => {
    await writeConfig(hyphen)
    await engineer({ session: 'sess-h', cwd: join(root, 'elsewhere') })
    const s = await setup()
    expect(s.board().repos[0]!.agents).toHaveLength(1)
    const res = await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })
    expect(await res.json()).toEqual({ error: 'no session' })
  })

  test('sessions in the repo’s own worktrees and subfolders still belong to it', async () => {
    await writeConfig(hyphen)
    await engineer({ session: 'sess-w', cwd: join(hyphen, '.claude', 'worktrees', 'w', 'packages') })
    const s = await setup()
    expect(s.board().repos[0]!.agents).toHaveLength(1)
    await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })
    expect(s.starts).toEqual([{ session: 'sess-w', word: 'continue', cwd: hyphen }])
  })

  test('the Board carries no cwd', async () => {
    const s = await setup()
    expect(s.board().repos.flatMap((r) => r.agents).every((a) => !('cwd' in a))).toBe(true)
  })
})

describe('a session belongs to the folder it started in, not to where its agents work', () => {
  beforeEach(clearAgents)
  const agentsOf = (s: Awaited<ReturnType<typeof setup>>, path: string) => s.board().repos.find((r) => r.path === path)!.agents

  test('a session of chess-web with its engineer in chess_web is chess-web’s', async () => {
    await engineer({ session: 'sess-h', cwd: hyphen, agentCwd: underscore })
    const s = await setup()
    expect(agentsOf(s, underscore)).toEqual([])
    expect(agentsOf(s, hyphen).map((a) => a.session)).toEqual(['sess-h'])
    expect((await s.post('resume', { repoId: s.idOf(underscore), run: 'alpha', reply: 'continue' })).status).toBe(404)
    const res = await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })
    expect(res.status).toBe(200)
    expect(s.starts).toEqual([{ session: 'sess-h', word: 'continue', cwd: hyphen }])
  })

  test('every agent of a session is placed the same way', async () => {
    await engineer({ session: 'sess-h', cwd: hyphen, agentCwd: hyphen, id: 'eng1' })
    await engineer({ session: 'sess-h', cwd: hyphen, agentCwd: underscore, id: 'eng2' })
    await engineer({ session: 'sess-h', cwd: hyphen, agentCwd: join(root, 'elsewhere'), id: 'eng3' })
    const s = await setup()
    expect(agentsOf(s, hyphen).map((a) => a.id).sort()).toEqual(['eng1', 'eng2', 'eng3'])
    expect(agentsOf(s, hyphen).every((a) => a.sessionUnproven === undefined)).toBe(true)
    expect(agentsOf(s, underscore)).toEqual([])
  })

  test('the repo’s own engineers in its worktrees and next-door folders stay listed, and their session can be sent to', async () => {
    await writeConfig(hyphen)
    for (const agentCwd of [join(hyphen, '.claude', 'worktrees', 'one-A1'), `${hyphen}-A1`, join(`${hyphen}-worktrees`, 'one-A1')]) {
      await clearAgents()
      await engineer({ session: 'sess-h', cwd: hyphen, agentCwd })
      const s = await setup()
      expect(s.board().repos[0]!.agents.map((a) => a.sessionUnproven), agentCwd).toEqual([undefined])
      expect((await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })).status, agentCwd).toBe(200)
    }
  })

  test('a session that started in a folder with a longer name stays listed, and sends nothing', async () => {
    await writeConfig(hyphen)
    for (const cwd of [`${hyphen}-A1`, join(`${hyphen}-worktrees`, 'one-A1')]) {
      await clearAgents()
      await engineer({ session: 'sess-h', cwd })
      const s = await setup()
      expect(s.board().repos[0]!.agents.map((a) => a.sessionUnproven), cwd).toEqual([true])
      expect(await (await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })).json(), cwd).toEqual({ error: 'no session' })
    }
  })

  test('a session file with no cwd, or no session file, fails closed whatever the agent recorded', async () => {
    await writeConfig(hyphen)
    for (const o of [{ cwd: undefined, agentCwd: hyphen }, { cwd: hyphen, sessionFile: false }]) {
      await clearAgents()
      await engineer({ session: 'sess-h', ...o })
      const s = await setup()
      expect(s.board().repos[0]!.agents.map((a) => a.sessionUnproven)).toEqual([true])
      await s.post('auto-continue', { repoId: s.idOf(hyphen), run: 'alpha', on: true })
      await s.auto.check()
      expect(await (await s.post('resume', { repoId: s.idOf(hyphen), run: 'alpha', reply: 'continue' })).json()).toEqual({ error: 'no session' })
      expect(s.starts).toEqual([])
    }
  })
})

describe('an auto-continue toggle belongs to the repo at its path', () => {
  beforeEach(async () => {
    await clearAgents()
    // Both repos have a sendable stop and their own session, so a wrong toggle would send.
    await engineer({ session: 'sess-h', cwd: hyphen, id: 'eng1' })
    await engineer({ session: 'sess-u', cwd: underscore, id: 'eng2' })
  })
  const plainId = () => repoId(hyphen, platform, caseless)
  const saved = async () => JSON.parse(await readFile(join(root, 'cfg', 'auto-continue.json'), 'utf8')) as { runs: unknown[] }

  test('a same-id repo registered after the toggled one left never sends, with no clash between them', async () => {
    await writeConfig(hyphen)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    await s.post('remove-repo', { repoId: plainId(), path: hyphen })
    await writeConfig(underscore)
    await s.rebuild()
    expect(s.idOf(underscore)).toBe(plainId())
    await s.auto.check()
    expect(s.starts).toEqual([])
    expect(s.board().autoContinue).toEqual([])
  })

  test('a clash forming and ending does not touch the toggle, and it never moves to the sibling', async () => {
    await writeConfig(hyphen)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })

    await writeConfig(hyphen, underscore)
    await s.rebuild()
    expect(s.idOf(hyphen)).not.toBe(plainId())
    expect(s.board().autoContinue).toEqual([{ repoId: s.idOf(hyphen), run: 'alpha' }])

    await s.post('remove-repo', { repoId: s.idOf(underscore), path: underscore })
    expect(s.board().autoContinue).toEqual([{ repoId: plainId(), run: 'alpha' }])
    await s.auto.check()
    expect(s.starts).toEqual([{ session: 'sess-h', word: 'continue', cwd: hyphen }])
  })

  test('when the toggled repo leaves a clash, the sibling that takes the plain id gets nothing', async () => {
    const s = await setup()
    await s.post('auto-continue', { repoId: s.idOf(hyphen), run: 'alpha', on: true })
    await s.post('remove-repo', { repoId: s.idOf(hyphen), path: hyphen })
    expect(s.idOf(underscore)).toBe(plainId())
    await s.auto.check()
    expect(s.starts).toEqual([])
    expect(s.board().autoContinue).toEqual([])
  })

  test('a toggle that reads off stays off when a clash comes back', async () => {
    const s = await setup()
    await s.post('auto-continue', { repoId: s.idOf(hyphen), run: 'alpha', on: true })
    await writeConfig(hyphen)
    await s.rebuild()
    await s.post('auto-continue', { repoId: s.idOf(hyphen), run: 'alpha', on: false })
    await writeConfig(hyphen, underscore)
    await s.rebuild()
    expect(s.board().autoContinue).toEqual([])
    await s.auto.check()
    expect(s.starts).toEqual([])
  })

  test('a toggle stored with no path reads off and sends nothing, and pressing the switch saves a path', async () => {
    await writeConfig(hyphen)
    await writeFile(join(root, 'cfg', 'auto-continue.json'), JSON.stringify({ runs: [{ repoId: plainId(), run: 'alpha' }] }))
    const s = await setup()
    expect(s.board().autoContinue).toEqual([])
    await s.auto.check()
    expect(s.starts).toEqual([])
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    expect((await saved()).runs).toEqual([{ path: keyOf(hyphen), run: 'alpha' }])
    expect(s.board().autoContinue).toEqual([{ repoId: plainId(), run: 'alpha' }])
  })

  test('Remove forgets the toggle, so adding the same folder again sends nothing', async () => {
    await writeConfig(hyphen)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    await s.post('remove-repo', { repoId: plainId(), path: hyphen })
    expect((await saved()).runs).toEqual([])
    await writeConfig(hyphen)
    await s.rebuild()
    expect(s.board().autoContinue).toEqual([])
    await s.auto.check()
    expect(s.starts).toEqual([])
  })

  test('Remove forgets the toggle of a repo a port claim still lists too, so it stays off when the claim ends and the folder returns', async () => {
    await writeConfig(hyphen)
    await writeFile(join(root, 'ports', '3100'), `${hyphen} alpha`)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    await s.post('remove-repo', { repoId: plainId(), path: hyphen })
    expect(s.board().repos.map((r) => r.source)).toEqual(['claim'])
    expect(s.board().autoContinue).toEqual([])
    await rm(join(root, 'ports', '3100'))
    await writeConfig(hyphen)
    await s.rebuild()
    expect(s.board().autoContinue).toEqual([])
    await s.auto.check()
    expect(s.starts).toEqual([])
  })

  test('a repo whose claim ends and comes back keeps its toggle', async () => {
    await writeConfig()
    await writeFile(join(root, 'ports', '3100'), `${hyphen} alpha`)
    const s = await setup()
    await s.post('auto-continue', { repoId: plainId(), run: 'alpha', on: true })
    await rm(join(root, 'ports', '3100'))
    await s.rebuild()
    expect(s.board().autoContinue).toEqual([])
    await writeFile(join(root, 'ports', '3100'), `${hyphen} alpha`)
    await s.rebuild()
    expect(s.board().autoContinue).toEqual([{ repoId: plainId(), run: 'alpha' }])
  })
})
