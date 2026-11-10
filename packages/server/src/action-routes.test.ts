import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionEntry, Board, GhStatus, MergePreview, MergeResult, NewActionEntry } from '@openaflow/model'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createActionRoutes } from './action-routes.ts'
import { createApp } from './app.ts'
import { createBoardService, type BoardService } from './board-service.ts'
import { VIEW_FIELDS } from './gh-actions.ts'
import { createGhReader, type ExecResult, type GhExec } from './gh.ts'
import { createSessionToken } from './session-token.ts'

const API = 3040
const WEB = 3041
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-openaflow-token': TOKEN }
const NOW = Date.parse('2026-10-21T12:00:00Z')
const SHA = 'a'.repeat(40)
const NEW_SHA = 'c'.repeat(40)
const url = (n: number) => `https://github.com/o/r/pull/${n}`

// ---- A repo on disk: plan alpha, sprint one; wave 2 handed back on PR #7, and the final PR #12 handed back. ----

const link = (n: number) => `[#${n}](${url(n)})`
const PLAN = [
  '# Plan: alpha',
  '',
  '_Generated: 2026-10-21 · Status: active · Grilled-with: grilling_',
  '',
  '## Sprint sequence',
  '',
  '| Sprint | Goal | Status | Depends on |',
  '|--------|------|--------|------------|',
  '| one | goal | active | — |',
  '',
].join('\n')
const SPRINT = [
  '# Sprint: one',
  '',
  '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-10-21_',
  '',
  '## Status board',
  '',
  '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
  '|------|-------|-------|--------|----|--------|------------|------------|',
  `| 1 | A1 | Title A1 | one-A1 | ${link(5)} merged | done | medium | — |`,
  `| 2 | B1 | Title B1 | one-B1 | ${link(7)} | pushed | medium | — |`,
  `| 2 | B2 | Title B2 | one-B2 | ${link(7)} | pushed | medium | — |`,
  '',
].join('\n')
const QUEUE = `- \`[2026-10-21 · PENDING · orchestrator → human · plan: alpha]\` Plan complete: merge ${url(12)} **Resolution:** pending\n`

let root: string
let repoPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openaflow-m1-routes-'))
  repoPath = join(root, 'repos', 'r')
  await mkdir(join(repoPath, 'pod-docs', 'plans'), { recursive: true })
  await mkdir(join(repoPath, 'pod-docs', 'sprints'), { recursive: true })
  await writeFile(join(repoPath, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  await writeFile(join(repoPath, 'pod-docs', 'plans', 'alpha.md'), PLAN)
  await writeFile(join(repoPath, 'pod-docs', 'sprints', 'one.md'), SPRINT)
  await writeFile(join(repoPath, 'pod-docs', 'handoff-queue.md'), QUEUE)
  await mkdir(join(root, 'cfg'), { recursive: true })
  await writeFile(join(root, 'cfg', 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repoPath }] }))
  await mkdir(join(root, 'ports'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// ---- A fake gh: the board's cache reads, the action reads, and the merge call. ----

type GhState = { state: 'OPEN' | 'MERGED' | 'CLOSED'; head: string; autoMerge?: boolean }

type FakeGh = {
  calls: string[][]
  prs: Map<number, GhState>
  auth: ExecResult['status']
  onMerge: (n: number) => ExecResult
  hold: Set<number>
  release: (n: number) => void
  merges: () => string[][]
  exec: GhExec
}

function fakeGh(): FakeGh {
  const calls: string[][] = []
  const prs = new Map<number, GhState>([
    [7, { state: 'OPEN', head: SHA }],
    [12, { state: 'OPEN', head: SHA }],
  ])
  const holds = new Map<number, () => void>()
  const gh: FakeGh = {
    calls,
    prs,
    auth: 'ok',
    /** What `pr merge` does to the PR before it answers. */
    onMerge: (n: number): ExecResult => {
      prs.get(n)!.state = 'MERGED'
      return { status: 'ok', stdout: '' }
    },
    /** When set for a number, its `pr merge` waits until `release(n)`. */
    hold: new Set<number>(),
    release: (n: number) => holds.get(n)?.(),
    merges: () => calls.filter((a) => a[1] === 'merge'),
    exec: (async (args) => {
      calls.push(args)
      if (args[0] === 'auth') return { status: gh.auth, stdout: '' }
      if (args[1] === 'list') return { status: 'ok', stdout: '[]' }
      const n = Number(args[1] === 'merge' ? args[2]!.split('/').pop() : args[2])
      if (args[1] === 'merge') {
        if (gh.hold.has(n)) await new Promise<void>((r) => holds.set(n, r))
        return gh.onMerge(n)
      }
      const pr = prs.get(n)
      if (!pr) return { status: 'failed', stdout: '', stderr: 'no pull requests found' }
      return {
        status: 'ok',
        stdout: JSON.stringify({
          number: n,
          state: pr.state,
          url: url(n),
          title: `PR ${n}`,
          headRefOid: pr.head,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [],
          autoMergeRequest: pr.autoMerge ? { mergeMethod: 'MERGE' } : null,
        }),
      }
    }) as GhExec,
  }
  return gh
}

/** The routes behind the real app and guard, over a real board service, gh reader, and a fake gh. */
async function setup(opts: { status?: GhStatus; append?: (e: Omit<ActionEntry, 'at'>) => Promise<boolean> } = {}) {
  const gh = fakeGh()
  const reader = createGhReader({ exec: gh.exec, now: () => NOW })
  const logged: NewActionEntry[] = []
  const service: BoardService = createBoardService({
    configFile: join(root, 'cfg', 'config.json'),
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform: process.platform,
    gh: reader,
    now: () => NOW,
    actions: () => logged.map((e) => ({ at: NOW, ...e })),
  })
  let board = await service.build()
  await service.refreshGh(board)
  board = await service.build()
  let rebuilds = 0
  const source = {
    board: () => board,
    subscribe: () => () => {},
    rebuild: async () => {
      rebuilds += 1
      board = await service.build()
    },
  }
  const ghReader = opts.status === undefined ? reader : { status: () => opts.status!, forget: reader.forget }
  const actions = createActionRoutes({
    board: source.board,
    gh: ghReader,
    exec: gh.exec,
    refreshGh: (b) => service.refreshGh(b),
    rebuild: source.rebuild,
    log: {
      append:
        opts.append ??
        (async (e) => {
          logged.unshift(e)
          return true
        }),
    },
    now: () => NOW,
  })
  const app = createApp({ ports: [API, WEB], token: TOKEN, source, addRepo: async () => ({ error: 'not a directory' }), timeline: async () => undefined, actions })
  const repoId = board.repos[0]!.id
  const post = (path: string, body: unknown) => app.request(`/api/actions/${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  gh.calls.length = 0
  return { gh, reader, logged, post, repoId, board: () => board, rebuilds: () => rebuilds }
}

const json = async <T>(res: Response) => (await res.json()) as T

describe('merge routes', () => {
  test('refuses a PR not waiting on you', async () => {
    const s = await setup()
    const cases: [string, unknown][] = [
      ['merge-preview', { repoId: 'nope', number: 7 }],
      ['merge-preview', { repoId: s.repoId, number: 5 }], // merged wave 1's PR
      ['merge-preview', { repoId: s.repoId, number: 99 }],
      ['merge', { repoId: 'nope', number: 7, headSha: SHA }],
      ['merge', { repoId: s.repoId, number: 99, headSha: SHA }],
    ]
    for (const [path, body] of cases) {
      const res = await s.post(path, body)
      expect(res.status, JSON.stringify(body)).toBe(404)
      expect(await res.json()).toEqual({ error: 'not waiting on you' })
    }
    // A repo path in the body counts for nothing.
    const byPath = await s.post('merge-preview', { repoId: 'nope', number: 7, path: repoPath })
    expect(byPath.status).toBe(404)
    expect(s.gh.calls).toEqual([])
    expect(s.logged).toEqual([])

    // The waiting ones answer.
    const preview = await s.post('merge-preview', { repoId: s.repoId, number: 7 })
    expect(preview.status).toBe(200)
    expect(await json<MergePreview>(preview)).toEqual({
      number: 7,
      url: url(7),
      title: 'PR 7',
      headSha: SHA,
      state: 'open',
      checks: 'none',
      mergeable: 'mergeable',
      mergeState: 'CLEAN',
    })
    expect((await s.post('merge-preview', { repoId: s.repoId, number: 12 })).status).toBe(200)
    // Previews aren't logged.
    expect(s.logged).toEqual([])
  })

  test('validates before running gh', async () => {
    const s = await setup()
    const bad: unknown[] = [
      { repoId: s.repoId, number: 7, headSha: 'abc' },
      { repoId: s.repoId, number: 7, headSha: SHA.toUpperCase() },
      { repoId: s.repoId, number: 7, headSha: SHA + 'a' },
      { repoId: s.repoId, number: 7 },
      { repoId: s.repoId, number: 0, headSha: SHA },
      { repoId: s.repoId, number: -7, headSha: SHA },
      { repoId: s.repoId, number: 7.5, headSha: SHA },
      { repoId: s.repoId, number: '7', headSha: SHA },
      { number: 7, headSha: SHA },
    ]
    for (const body of bad) {
      const res = await s.post('merge', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad request' })
    }
    for (const body of [{ repoId: s.repoId, number: '7' }, { repoId: s.repoId }, { number: 7 }]) {
      expect((await s.post('merge-preview', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(s.gh.calls).toEqual([])
    expect(s.logged).toEqual([])

    // gh missing, logged out, or not checked yet: 503 before any exec, for both routes.
    for (const status of ['missing', 'logged-out', 'unknown'] as const) {
      const off = await setup({ status })
      for (const [path, body] of [
        ['merge-preview', { repoId: off.repoId, number: 7 }],
        ['merge', { repoId: off.repoId, number: 7, headSha: SHA }],
      ] as const) {
        const res = await off.post(path, body)
        expect(res.status, `${status} ${path}`).toBe(503)
        expect(await res.json()).toEqual({ error: 'gh unavailable' })
      }
      expect(off.gh.calls).toEqual([])
      expect(off.logged).toEqual([])
    }
  })

  test('preview read failure is 502 with gh\'s text', async () => {
    const s = await setup()
    s.gh.prs.delete(7)
    const res = await s.post('merge-preview', { repoId: s.repoId, number: 7 })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'no pull requests found' })
  })

  test('stale head is refused', async () => {
    const s = await setup()
    s.gh.prs.get(7)!.head = NEW_SHA
    const res = await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    expect(res.status).toBe(200)
    expect(await json<MergeResult>(res)).toEqual({ outcome: 'stale', number: 7, headSha: NEW_SHA, logged: true })
    expect(s.gh.merges()).toEqual([])
  })

  test('one merge per PR at a time', async () => {
    const s = await setup()
    s.gh.hold.add(7)
    const first = s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    // Wait until the first one is parked in its merge call.
    while (s.gh.merges().length === 0) await new Promise((r) => setTimeout(r, 1))
    const second = await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'merge in progress' })
    // Another PR merges at once, while #7 is still held.
    const other = await s.post('merge', { repoId: s.repoId, number: 12, headSha: SHA })
    expect(await json<MergeResult>(other)).toMatchObject({ outcome: 'merged', number: 12 })
    s.gh.release(7)
    expect(await json<MergeResult>(await first)).toMatchObject({ outcome: 'merged', number: 7 })
    expect(s.gh.merges()).toHaveLength(2)
    // The 409 isn't logged; the two merges are.
    expect(s.logged.map((e) => e.target)).toEqual(['PR #7', 'PR #12'])
    // Once it's done, the same PR can be asked again (and is no longer waiting).
    expect((await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })).status).toBe(404)
  })

  test('a 409 slot is freed after a failure too', async () => {
    const s = await setup()
    s.gh.onMerge = () => {
      throw new Error('spawn')
    }
    expect(await json<MergeResult>(await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA }))).toMatchObject({ outcome: 'failed', message: 'gh pr merge failed' })
    s.gh.onMerge = () => ({ status: 'failed', stdout: '', stderr: 'nope' })
    expect(await json<MergeResult>(await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA }))).toMatchObject({ outcome: 'failed', message: 'nope' })
  })

  test('board shows the new PR state after merge', async () => {
    const s = await setup()
    const prOf = (n: number) => s.board().repos[0]!.prs.find((p) => p.number === n)
    expect(prOf(7)?.state).toBe('open')
    const res = await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    expect(await json<MergeResult>(res)).toEqual({ outcome: 'merged', number: 7, logged: true })
    // By the response, the cache fetched #7 again (inside its 30 s, so only because it was dropped) and the Board was rebuilt.
    expect(s.gh.calls.filter((a) => a[1] === 'view' && a[2] === '7' && a[4] !== VIEW_FIELDS)).toHaveLength(1)
    expect(prOf(7)?.state).toBe('merged')
    expect(s.rebuilds()).toBe(1)
    expect(s.board().actions?.[0]).toMatchObject({ target: 'PR #7', result: 'merged' })

    // gh reports a failure but the PR merged anyway: still re-read, still fresh.
    s.gh.onMerge = (n) => {
      s.gh.prs.get(n)!.state = 'MERGED'
      return { status: 'failed', stdout: '', stderr: 'timed out' }
    }
    expect(await json<MergeResult>(await s.post('merge', { repoId: s.repoId, number: 12, headSha: SHA }))).toMatchObject({ outcome: 'merged' })
    expect(prOf(12)?.state).toBe('merged')
  })

  test('every merge is logged', async () => {
    const s = await setup()
    // stale
    s.gh.prs.get(7)!.head = NEW_SHA
    await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    // failed
    s.gh.prs.get(7)!.head = SHA
    s.gh.onMerge = () => ({ status: 'failed', stdout: '', stderr: 'not mergeable' })
    await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    // a preview, a 400, and a 404 add nothing
    await s.post('merge-preview', { repoId: s.repoId, number: 7 })
    await s.post('merge', { repoId: s.repoId, number: 7, headSha: 'x' })
    await s.post('merge', { repoId: s.repoId, number: 99, headSha: SHA })
    expect(s.logged).toEqual([
      { action: 'merge', repoId: s.repoId, repo: 'r', target: 'PR #7', result: 'failed', message: 'not mergeable' },
      { action: 'merge', repoId: s.repoId, repo: 'r', target: 'PR #7', result: 'stale', message: `head now ${NEW_SHA.slice(0, 7)}` },
    ])
    // The Board's log was rebuilt after each one.
    expect(s.board().actions).toHaveLength(2)

    // An append that fails: the same outcome, logged false.
    const broken = await setup({ append: async () => false })
    const res = await broken.post('merge', { repoId: broken.repoId, number: 7, headSha: SHA })
    expect(await json<MergeResult>(res)).toEqual({ outcome: 'merged', number: 7, logged: false })
    const throws = await setup({
      append: async () => {
        throw new Error('disk full')
      },
    })
    expect(await json<MergeResult>(await throws.post('merge', { repoId: throws.repoId, number: 7, headSha: SHA }))).toEqual({
      outcome: 'merged',
      number: 7,
      logged: false,
    })
  })

  test('a read that fails before the merge is logged as failed and runs no merge', async () => {
    const s = await setup()
    // #7 is waiting on the Board, but gh can't read it now.
    s.gh.prs.delete(7)
    const res = await s.post('merge', { repoId: s.repoId, number: 7, headSha: SHA })
    expect(res.status).toBe(200)
    expect(await json<MergeResult>(res)).toEqual({ outcome: 'failed', number: 7, message: 'no pull requests found', logged: true })
    expect(s.gh.merges()).toEqual([])
    expect(s.logged).toHaveLength(1)
  })
})
