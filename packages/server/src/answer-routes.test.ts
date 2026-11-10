import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnswerResult, Board, NewActionEntry } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAnswerRoutes } from './answer-routes.ts'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import { createGhReader, type GhExec } from './gh.ts'
import { nodeQueueFs, type QueueFs } from './queue-writer.ts'
import { createSessionToken } from './session-token.ts'

const API = 3050
const WEB = 3051
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-openaflow-token': TOKEN }
const NOW = Date.parse('2026-10-21T12:00:00Z')

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

const ASK = '- `[2026-10-21 · PENDING · engineer → human · plan: alpha · slice: A1]` Pick a name for the ladder **Resolution:** pending'
const HALT = '- `[2026-10-20 · BLOCKED · orchestrator → human · plan: alpha]` Gate 2 stopped the run: secret body text **Resolution:** pending'
const NOTE = '- `[2026-10-20 · NOTE · engineer → human · plan: alpha]` a note for you **Resolution:** pending'
const DONE = '- `[2026-10-19 · PENDING · engineer → human · plan: alpha]` resolved one **Resolution:** 2026-10-20 — fixed'
const ANSWERED = '- `[2026-10-19 · PENDING · engineer → human · plan: alpha]` asked before **Resolution:** pending **Answer (human):** yes'
const TO_POD = '- `[2026-10-19 · PENDING · engineer → orchestrator · plan: alpha]` for pod **Resolution:** pending'
const TO_POD_BLOCKED = '- `[2026-10-19 · BLOCKED · engineer → orchestrator · plan: alpha]` stuck for pod **Resolution:** pending'
const CLAIMED_ASK = '- `[2026-10-21 · PENDING · orchestrator → human · plan: beta]` Which port? **Resolution:** pending'

let root: string
let repoPath: string
let claimedPath: string

async function makeRepo(path: string, plan: string, queue: string[]) {
  await mkdir(join(path, 'pod-docs', 'plans'), { recursive: true })
  await writeFile(join(path, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  await writeFile(join(path, 'pod-docs', 'plans', `${plan}.md`), PLAN.replace('# Plan: alpha', `# Plan: ${plan}`))
  await writeFile(join(path, 'pod-docs', 'handoff-queue.md'), ['# Handoff Queue', '', ...queue, ''].join('\n'))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openaflow-a1-routes-'))
  repoPath = join(root, 'repos', 'r')
  claimedPath = join(root, 'repos', 'c')
  await makeRepo(repoPath, 'alpha', [HALT, NOTE, DONE, ANSWERED, TO_POD, TO_POD_BLOCKED, ASK])
  await makeRepo(claimedPath, 'beta', [CLAIMED_ASK])
  await mkdir(join(root, 'cfg'), { recursive: true })
  await writeFile(join(root, 'cfg', 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repoPath }] }))
  // The second repo is on the Board only through pod's port claim.
  await mkdir(join(root, 'ports'))
  await writeFile(join(root, 'ports', '3100'), `${claimedPath} beta`)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ghExec = (async (args: string[]) => (args[0] === 'auth' ? { status: 'ok', stdout: '' } : { status: 'ok', stdout: '[]' })) as GhExec

type SetupOpts = { append?: (e: NewActionEntry) => Promise<boolean>; fs?: QueueFs; token?: boolean }

/** The answer routes behind the real app and guard, over a real board service and temp repos. */
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
    actions: () => logged.map((e) => ({ at: NOW, ...e })),
  })
  let board: Board = await service.build()
  let rebuilds = 0
  const source = {
    board: () => board,
    subscribe: () => () => {},
    rebuild: async () => {
      rebuilds += 1
      events.push('rebuild')
      board = await service.build()
    },
  }
  const routes = createAnswerRoutes({
    board: source.board,
    rebuild: source.rebuild,
    log: {
      append: async (e) => {
        events.push('log')
        if (opts.append) return opts.append(e)
        logged.unshift(e)
        return true
      },
    },
    ...(opts.fs ? { fs: opts.fs } : {}),
  })
  const app = createApp({ ports: [API, WEB], token: TOKEN, source, addRepo: async () => ({ error: 'not a directory' }), timeline: async () => undefined, actions: new Hono().route('/', routes) })
  const repoOf = (path: string) => board.repos.find((r) => r.path === path)!
  const headers = opts.token === false ? { ...HEADERS, 'x-openaflow-token': '' } : HEADERS
  const post = (body: unknown) => app.request('/api/actions/answer', { method: 'POST', headers, body: JSON.stringify(body) })
  return { post, logged, events, rebuilds: () => rebuilds, board: () => board, repoId: repoOf(repoPath).id, claimedId: repoOf(claimedPath).id, repoOf }
}

const json = async <T>(res: Response) => (await res.json()) as T
const queueText = (path = repoPath) => readFile(join(path, 'pod-docs', 'handoff-queue.md'), 'utf8')

describe('answer route', () => {
  test('validates the answer', async () => {
    const s = await setup()
    const before = await queueText()
    const shapes: unknown[] = [
      {},
      { repoId: s.repoId, line: ASK },
      { repoId: s.repoId, text: 'x' },
      { line: ASK, text: 'x' },
      { repoId: 7, line: ASK, text: 'x' },
      { repoId: s.repoId, line: ['x'], text: 'x' },
      { repoId: s.repoId, line: ASK, text: 42 },
      { repoId: s.repoId, line: ASK, text: null },
    ]
    for (const body of shapes) {
      const res = await s.post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad request' })
    }
    const texts: [string, string][] = [
      ['', 'Write an answer first.'],
      [' \n\t', 'Write an answer first.'],
      ['x'.repeat(2001), 'Keep the answer under 2000 characters.'],
      ['ok **Resolution:** done', "The answer can't contain **Resolution:** or **Answer (…):**."],
      ['ok **answer (human):** more', "The answer can't contain **Resolution:** or **Answer (…):**."],
    ]
    for (const [text, error] of texts) {
      // The text is checked before the entry is looked up, so a bad text on any line gets its error.
      for (const line of [ASK, 'not a line']) {
        const res = await s.post({ repoId: s.repoId, line, text })
        expect(res.status, text.slice(0, 20)).toBe(400)
        expect(await res.json()).toEqual({ error })
      }
    }
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
    expect(await queueText()).toBe(before)
  })

  test('answers only entries waiting on you', async () => {
    const s = await setup()
    const before = await queueText()
    const cases: unknown[] = [
      { repoId: 'nope', line: ASK, text: 'x' },
      // The line belongs to the other repo.
      { repoId: s.repoId, line: CLAIMED_ASK, text: 'x' },
      { repoId: s.repoId, line: ASK.replace('Pick', 'Choose'), text: 'x' },
      // Only the whole line counts, not a part of it or the body.
      { repoId: s.repoId, line: ASK.slice(0, 40), text: 'x' },
      { repoId: s.repoId, line: 'Pick a name for the ladder', text: 'x' },
      // On the queue but not answerable: a NOTE, resolved, answered, and two for pod.
      { repoId: s.repoId, line: NOTE, text: 'x' },
      { repoId: s.repoId, line: DONE, text: 'x' },
      { repoId: s.repoId, line: ANSWERED, text: 'x' },
      { repoId: s.repoId, line: TO_POD, text: 'x' },
      { repoId: s.repoId, line: TO_POD_BLOCKED, text: 'x' },
      // A repo path in the body counts for nothing.
      { repoId: 'nope', line: ASK, text: 'x', path: repoPath },
    ]
    for (const body of cases) {
      const res = await s.post(body)
      expect(res.status, JSON.stringify(body)).toBe(404)
      expect(await res.json()).toEqual({ error: 'not waiting on you' })
    }
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
    expect(await queueText()).toBe(before)

    // The orchestrator's BLOCKED is answered.
    const halt = await s.post({ repoId: s.repoId, line: HALT, text: 'fixed the test' })
    expect(halt.status).toBe(200)
    expect(await json<AnswerResult>(halt)).toEqual({ outcome: 'answered', logged: true })
    expect(await queueText()).toBe(before.replace(HALT, `${HALT} **Answer (human):** fixed the test`))

    // A claim-only repo is answered.
    const claimed = await s.post({ repoId: s.claimedId, line: CLAIMED_ASK, text: '  use\n3200  ' })
    expect(await json<AnswerResult>(claimed)).toEqual({ outcome: 'answered', logged: true })
    expect(s.repoOf(claimedPath).source).toBe('claim')
    expect(await queueText(claimedPath)).toContain(`${CLAIMED_ASK} **Answer (human):** use 3200\n`)

    // Once answered it's not waiting on you any more: a repeat is 404.
    const again = await s.post({ repoId: s.repoId, line: HALT, text: 'again' })
    expect(again.status).toBe(404)
  })

  test('one answer per repo at a time', async () => {
    // Renames wait until released, so a write stays in flight.
    const held: (() => void)[] = []
    const fs: QueueFs = {
      ...nodeQueueFs,
      rename: async (from, to) => {
        await new Promise<void>((r) => held.push(r))
        return nodeQueueFs.rename(from, to)
      },
    }
    const s = await setup({ fs })
    const first = s.post({ repoId: s.repoId, line: ASK, text: 'first' })
    while (held.length < 1) await new Promise((r) => setTimeout(r, 5))

    // The same repo, even another entry: 409, nothing logged for it.
    const second = await s.post({ repoId: s.repoId, line: HALT, text: 'second' })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'answer in progress' })
    expect(s.logged).toEqual([])

    // Another repo writes at once.
    const other = s.post({ repoId: s.claimedId, line: CLAIMED_ASK, text: 'other' })
    while (held.length < 2) await new Promise((r) => setTimeout(r, 5))
    held[1]!()
    expect(await json<AnswerResult>(await other)).toEqual({ outcome: 'answered', logged: true })
    held[0]!()
    expect(await json<AnswerResult>(await first)).toEqual({ outcome: 'answered', logged: true })

    // The slot is free again once the first is done.
    const third = s.post({ repoId: s.repoId, line: HALT, text: 'third' })
    while (held.length < 3) await new Promise((r) => setTimeout(r, 5))
    held[2]!()
    expect((await third).status).toBe(200)
    const text = await queueText()
    expect(text).toContain(`${ASK} **Answer (human):** first`)
    expect(text).toContain(`${HALT} **Answer (human):** third`)

    // A failed write frees the slot too.
    await writeFile(join(claimedPath, 'pod-docs', 'handoff-queue.md'), `${CLAIMED_ASK}\n`)
    const failing = await setup({ fs: { ...nodeQueueFs, rename: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) } })
    for (let i = 0; i < 2; i++) {
      const res = await failing.post({ repoId: failing.claimedId, line: CLAIMED_ASK, text: 'x' })
      expect(await json<AnswerResult>(res)).toMatchObject({ outcome: 'failed' })
    }
  })

  test('every answer is logged', async () => {
    const s = await setup()
    // answered
    const ok = await s.post({ repoId: s.repoId, line: ASK, text: 'call it Ladder' })
    expect(await json<AnswerResult>(ok)).toEqual({ outcome: 'answered', logged: true })
    expect(s.logged[0]).toEqual({ action: 'answer', repoId: s.repoId, repo: 'r', target: '2026-10-21 · PENDING · engineer → human', result: 'answered' })
    // The Board was rebuilt after the log and before the response: it shows the answer and the entry.
    expect(s.events).toEqual(['log', 'rebuild'])
    const item = s.board().repos.find((r) => r.id === s.repoId)!.model.queue.find((e) => e.line.startsWith(ASK))!
    expect(item.answer).toBe('call it Ladder')
    expect(s.board().actions?.[0]).toMatchObject({ action: 'answer', result: 'answered' })

    // changed: the entry is still on the Board, but the file moved on.
    const file = join(repoPath, 'pod-docs', 'handoff-queue.md')
    await writeFile(file, (await readFile(file, 'utf8')).replace(HALT, HALT.replace('Gate 2', 'Gate 3')))
    const changed = await s.post({ repoId: s.repoId, line: HALT, text: 'x' })
    expect(changed.status).toBe(200)
    expect(await json<AnswerResult>(changed)).toEqual({ outcome: 'changed', message: 'The entry changed since you looked.', logged: true })
    expect(s.logged[0]).toEqual({ action: 'answer', repoId: s.repoId, repo: 'r', target: '2026-10-20 · BLOCKED · orchestrator → human', result: 'changed', message: 'The entry changed since you looked.' })
    expect(s.events).toEqual(['log', 'rebuild', 'log', 'rebuild'])

    // failed: the rename keeps failing.
    const f = await setup({ fs: { ...nodeQueueFs, rename: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) } })
    const failed = await f.post({ repoId: f.repoId, line: HALT.replace('Gate 2', 'Gate 3'), text: 'x' })
    expect(await json<AnswerResult>(failed)).toEqual({ outcome: 'failed', message: "Couldn't write the queue (EACCES).", logged: true })
    expect(f.logged[0]).toMatchObject({ action: 'answer', result: 'failed', message: "Couldn't write the queue (EACCES)." })
    expect(f.events).toEqual(['log', 'rebuild'])
    expect((await readdir(join(repoPath, 'pod-docs'))).sort()).toEqual(['README.md', 'handoff-queue.md', 'plans'])

    // No log entry holds the answer text or the body.
    for (const e of [...s.logged, ...f.logged]) {
      const flat = JSON.stringify(e)
      expect(flat).not.toContain('Ladder')
      expect(flat).not.toContain('secret body')
      expect(flat).not.toContain('Pick a name')
    }

    // A failed append: logged false, and the Board is still rebuilt before the response.
    const noLog = await setup({ append: async () => false })
    const lost = await noLog.post({ repoId: noLog.repoId, line: HALT.replace('Gate 2', 'Gate 3'), text: 'x' })
    expect(await json<AnswerResult>(lost)).toEqual({ outcome: 'answered', logged: false })
    expect(noLog.events).toEqual(['log', 'rebuild'])
    // An append that throws is the same.
    const throws = await setup({ append: async () => Promise.reject(new Error('disk')) })
    const thrown = await throws.post({ repoId: throws.claimedId, line: CLAIMED_ASK, text: 'x' })
    expect(await json<AnswerResult>(thrown)).toEqual({ outcome: 'answered', logged: false })
    expect(throws.events).toEqual(['log', 'rebuild'])
  })

  test('answer needs the token', async () => {
    const s = await setup({ token: false })
    const before = await queueText()
    const res = await s.post({ repoId: s.repoId, line: ASK, text: 'x' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'bad token' })
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
    expect(await queueText()).toBe(before)

    // The same request with the token goes through.
    const ok = await (await setup()).post({ repoId: s.repoId, line: ASK, text: 'x' })
    expect(await json<AnswerResult>(ok)).toEqual({ outcome: 'answered', logged: true })
  })
})
