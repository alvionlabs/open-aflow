import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseQueue, type Board, type NewActionEntry, type ResolveResult } from '@pod-board/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAnswerRoutes } from './answer-routes.ts'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import { createGhReader, type GhExec } from './gh.ts'
import { nodeQueueFs, type QueueFs } from './queue-writer.ts'
import { createSessionToken } from './session-token.ts'

// The Close and Keep route: POST /api/actions/resolve with { repoId, line, kind }. The server reads the
// reason or the value itself from the Board; the request never carries the text it writes.

const API = 3060
const WEB = 3061
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-pod-board-token': TOKEN }
const NOW = Date.parse('2026-10-31T12:00:00Z')
const TODAY = '2026-10-31'

const plan = (slug: string, status: string) =>
  [
    `# Plan: ${slug}`,
    '',
    `_Generated: 2026-10-21 · Status: ${status} · Grilled-with: grilling_`,
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    '| one | goal | active | — |',
    '',
  ].join('\n')

const GATE = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 1 (blocked-concern): A1 cannot pass verify. **Resolution:** pending'
const GATE_LIVE = '- `[2026-10-21 · BLOCKED · orchestrator → human · plan: live]` gate 1 (blocked-concern): B1 is stuck. **Resolution:** pending'
const VALUE = '- `[2026-10-21 · PENDING · engineer → human · plan: live]` decision: badge colour? value in use: `white`. Answer to change. **Resolution:** pending'
const BOTH = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: old]` gate 4 (wave-check-failed): wave 2. Value in use: skip it. **Resolution:** pending'
const PLAIN = '- `[2026-10-21 · PENDING · engineer → human · plan: live]` someday: tidy the logs. **Resolution:** pending'
const TO_POD = '- `[2026-10-20 · BLOCKED · engineer → orchestrator · plan: old]` gate 1 (blocked-concern): for pod. **Resolution:** pending'

let root: string
let repoPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pod-board-resolve-'))
  repoPath = join(root, 'repos', 'r')
  await mkdir(join(repoPath, 'pod-docs', 'plans', 'archive'), { recursive: true })
  await writeFile(join(repoPath, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  await writeFile(join(repoPath, 'pod-docs', 'plans', 'archive', 'old.md'), plan('old', 'archived'))
  await writeFile(join(repoPath, 'pod-docs', 'plans', 'live.md'), plan('live', 'active'))
  await writeFile(join(repoPath, 'pod-docs', 'handoff-queue.md'), ['# Handoff Queue', '', GATE, GATE_LIVE, VALUE, BOTH, PLAIN, TO_POD, ''].join('\n'))
  await mkdir(join(root, 'cfg'), { recursive: true })
  await writeFile(join(root, 'cfg', 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repoPath }] }))
  await mkdir(join(root, 'ports'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ghExec = (async (args: string[]) => (args[0] === 'auth' ? { status: 'ok', stdout: '' } : { status: 'ok', stdout: '[]' })) as GhExec

type SetupOpts = { fs?: QueueFs; token?: boolean; host?: string }

async function setup(opts: SetupOpts = {}) {
  const logged: NewActionEntry[] = []
  const events: string[] = []
  const service = createBoardService({
    configFile: join(root, 'cfg', 'config.json'),
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform: process.platform,
    gh: createGhReader({ exec: ghExec, now: () => NOW }),
    now: () => NOW,
  })
  let board: Board = await service.build()
  const source = {
    board: () => board,
    subscribe: () => () => {},
    rebuild: async () => {
      events.push('rebuild')
      board = await service.build()
    },
  }
  const routes = createAnswerRoutes({
    board: source.board,
    rebuild: source.rebuild,
    today: () => TODAY,
    log: {
      append: async (e) => {
        events.push('log')
        logged.unshift(e)
        return true
      },
    },
    ...(opts.fs ? { fs: opts.fs } : {}),
  })
  const app = createApp({ ports: [API, WEB], token: TOKEN, source, addRepo: async () => ({ error: 'not a directory' }), timeline: async () => undefined, actions: new Hono().route('/', routes) })
  let headers: Record<string, string> = opts.token === false ? { ...HEADERS, 'x-pod-board-token': '' } : HEADERS
  if (opts.host) headers = { ...headers, host: opts.host }
  const post = (body: unknown) => app.request('/api/actions/resolve', { method: 'POST', headers, body: JSON.stringify(body) })
  const repoId = board.repos[0]!.id
  return { post, logged, events, board: () => board, repoId }
}

const json = async <T>(res: Response) => (await res.json()) as T
const queueText = () => readFile(join(repoPath, 'pod-docs', 'handoff-queue.md'), 'utf8')
const lineOf = (text: string, part: string) => text.split('\n').find((l) => l.includes(part))!

describe('resolve route', () => {
  test('Close writes the dated resolution with the board’s reason, and the entry is no longer pending', async () => {
    const s = await setup()
    const before = await queueText()
    const res = await s.post({ repoId: s.repoId, line: GATE, kind: 'close' })
    expect(res.status).toBe(200)
    expect(await json<ResolveResult>(res)).toEqual({ outcome: 'closed', logged: true })
    const after = await queueText()
    const written = GATE.replace('**Resolution:** pending', `**Resolution:** ${TODAY} — closed from the board: plan old is archived`)
    expect(after).toBe(before.replace(GATE, written))
    expect(parseQueue(lineOf(after, 'A1 cannot pass'))[0]!.isPending).toBe(false)
    expect(s.logged[0]).toEqual({ action: 'resolve', repoId: s.repoId, repo: 'r', target: '2026-10-20 · BLOCKED · orchestrator → human', result: 'closed' })
    expect(s.events).toEqual(['log', 'rebuild'])
    // The Board no longer lists it as waiting on you.
    expect(s.board().repos[0]!.model.queue.find((e) => e.body.includes('A1 cannot pass'))!.needsYou).toBe(false)
    // Again: it isn't waiting on you any more.
    const again = await s.post({ repoId: s.repoId, line: GATE, kind: 'close' })
    expect(again.status).toBe(404)
    expect(await json(again)).toEqual({ error: 'not waiting on you' })
  })

  test('Keep writes the dated value in use as the resolution', async () => {
    const s = await setup()
    const before = await queueText()
    const res = await s.post({ repoId: s.repoId, line: VALUE, kind: 'keep' })
    expect(await json<ResolveResult>(res)).toEqual({ outcome: 'kept', logged: true })
    expect(await queueText()).toBe(before.replace(VALUE, VALUE.replace('**Resolution:** pending', `**Resolution:** ${TODAY} — kept: white`)))
    expect(s.logged[0]).toMatchObject({ action: 'resolve', result: 'kept' })
    // The log holds the header only, never the body or the value.
    expect(JSON.stringify(s.logged)).not.toContain('white')
  })

  test('only what the board reads: Done wins, a live gate or a plain entry has nothing to close or keep', async () => {
    const s = await setup()
    const before = await queueText()
    const refused: [unknown, number, string][] = [
      // A gate of a plan that isn't archived.
      [{ repoId: s.repoId, line: GATE_LIVE, kind: 'close' }, 409, 'The board no longer reads this entry as done.'],
      // Neither rule.
      [{ repoId: s.repoId, line: PLAIN, kind: 'close' }, 409, 'The board no longer reads this entry as done.'],
      [{ repoId: s.repoId, line: PLAIN, kind: 'keep' }, 409, 'This entry states no value in use.'],
      // Done and a value in use: Done wins, so Keep isn't offered.
      [{ repoId: s.repoId, line: BOTH, kind: 'keep' }, 409, 'This entry states no value in use.'],
      // Routed to pod.
      [{ repoId: s.repoId, line: TO_POD, kind: 'close' }, 404, 'not waiting on you'],
      [{ repoId: 'nope', line: GATE, kind: 'close' }, 404, 'not waiting on you'],
      // Bad shapes.
      [{ repoId: s.repoId, line: GATE }, 400, 'bad request'],
      [{ repoId: s.repoId, line: GATE, kind: 'delete' }, 400, 'bad request'],
      [{ repoId: s.repoId, line: GATE, kind: 'close', text: 'my reason' }, 200, ''],
    ]
    for (const [body, status, error] of refused.slice(0, -1)) {
      const res = await s.post(body)
      expect(res.status, JSON.stringify(body)).toBe(status)
      expect(await res.json()).toEqual({ error })
    }
    expect(s.logged).toEqual([])
    expect(await queueText()).toBe(before)
    // A text in the request counts for nothing: the reason is the board's own.
    const res = await s.post(refused.at(-1)![0])
    expect(res.status).toBe(200)
    expect(await queueText()).not.toContain('my reason')
    expect(await queueText()).toContain('closed from the board: plan old is archived')
    // BOTH can still be closed.
    expect(await json<ResolveResult>(await s.post({ repoId: s.repoId, line: BOTH, kind: 'close' }))).toMatchObject({ outcome: 'closed' })
  })

  test('the stale line: the entry changed in the file since the Board read it', async () => {
    const s = await setup()
    const file = join(repoPath, 'pod-docs', 'handoff-queue.md')
    // pod resolved it in the meantime: the line on disk is no longer the Board's line.
    const changedText = (await readFile(file, 'utf8')).replace(GATE, GATE.replace('pending', '2026-10-31 — fixed by pod'))
    await writeFile(file, changedText)
    const res = await s.post({ repoId: s.repoId, line: GATE, kind: 'close' })
    expect(await json<ResolveResult>(res)).toEqual({ outcome: 'changed', message: 'The entry changed since you looked.', logged: true })
    expect(await readFile(file, 'utf8')).toBe(changedText)
    expect(s.logged[0]).toMatchObject({ action: 'resolve', result: 'changed' })
  })

  test('a write failure comes back with its message', async () => {
    const s = await setup({ fs: { ...nodeQueueFs, rename: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) } })
    const before = await queueText()
    const res = await s.post({ repoId: s.repoId, line: GATE, kind: 'close' })
    expect(await json<ResolveResult>(res)).toEqual({ outcome: 'failed', message: "Couldn't write the queue (EACCES).", logged: true })
    expect(await queueText()).toBe(before)
  })

  test('the token and the Host guard', async () => {
    const before = await queueText()
    const noToken = await setup({ token: false })
    const res = await noToken.post({ repoId: noToken.repoId, line: GATE, kind: 'close' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'bad token' })
    const badHost = await setup({ host: 'evil.example' })
    const host = await badHost.post({ repoId: badHost.repoId, line: GATE, kind: 'close' })
    expect(host.status).toBe(403)
    expect(await host.json()).toEqual({ error: 'forbidden host' })
    expect(await queueText()).toBe(before)
    expect([...noToken.logged, ...badHost.logged]).toEqual([])
  })

  test('one write per repo at a time, shared with Answer', async () => {
    const held: (() => void)[] = []
    const fs: QueueFs = {
      ...nodeQueueFs,
      rename: async (from, to) => {
        await new Promise<void>((r) => held.push(r))
        return nodeQueueFs.rename(from, to)
      },
    }
    const s = await setup({ fs })
    const first = s.post({ repoId: s.repoId, line: GATE, kind: 'close' })
    while (held.length < 1) await new Promise((r) => setTimeout(r, 5))
    const second = await s.post({ repoId: s.repoId, line: VALUE, kind: 'keep' })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'answer in progress' })
    held[0]!()
    expect(await json<ResolveResult>(await first)).toMatchObject({ outcome: 'closed' })
  })
})
