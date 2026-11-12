import { describe, expect, test } from 'vitest'
import { buildRepoModel, listRuns, type AgentRun, type Board, type BoardRepo, type Claim, type PrStatus } from '@openaflow/model'
import { hashFor } from '@openaflow/web/selection'
import { loadFixture } from '../../model/test/load-fixture.ts'
import { attentionItems } from './attention.ts'

// Boards from the chess-web fixture: plan sparring-ladder, on wave 3 of sprint ladder (T1 pending).

const NOW = Date.UTC(2026, 9, 20, 12)
const MIN = 60_000
const PLAN = 'sparring-ladder'
const QUEUE = 'pod-docs/handoff-queue.md'
const LADDER = 'pod-docs/sprints/ladder.md'

type Files = Record<string, string>
type Edit = (files: Files) => void

const entry = (type: string, route: string, fields: string, body: string) => `- \`[2026-10-19 · ${type} · ${route}${fields ? ` · ${fields}` : ''}]\` ${body} **Resolution:** pending`
const BLOCKED = entry('BLOCKED', 'engineer → human', 'sprint: ladder · slice: T1', "T1 can't reach the rates file.")
const PENDING = entry('PENDING', 'engineer → human', 'sprint: ladder · slice: T1', 'Pick the step size.')
const TO_ORCHESTRATOR = entry('BLOCKED', 'engineer → orchestrator', 'sprint: ladder · slice: T1', 'Tool missing.')
const UNJOINED = entry('BLOCKED', 'orchestrator → human', '', 'Check the npm cache.')

const onlyQueue = (...lines: string[]): Edit => (f) => {
  f[QUEUE] = ['# Handoff Queue', '', ...lines, ''].join('\n')
}
/** Started with /pod:code: no autopilot line in the plan doc or the sprint doc. */
const manual: Edit = (f) => {
  for (const doc of ['pod-docs/plans/sparring-ladder.md', LADDER]) f[doc] = f[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
}
/** T1 handed back on this PR. */
const pushed = (pr: number): Edit => (f) => {
  f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', `| ladder-T1 | #${pr} | pushed | medium |`)
}

const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })
const engineer = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'e1',
  session: 'sess-1',
  type: 'pod:engineer',
  tokens: 0,
  ended: true,
  plan: PLAN,
  sprint: 'ladder',
  slice: 'T1',
  startedAt: NOW - 60 * MIN,
  lastAt: NOW - 40 * MIN,
  ...over,
})

function chess(edits: Edit[] = [], extra: Partial<BoardRepo> = {}): BoardRepo {
  const files = loadFixture('chess-web')
  for (const e of edits) e(files)
  return { id: 'chess', name: 'chess-web', path: '/c', source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}
const boardOf = (repos: BoardRepo[], extra: Partial<Board> = {}): Board => ({ generatedAt: NOW, gh: 'ok', repos, ...extra })
const items = (...repos: BoardRepo[]) => attentionItems(boardOf(repos), NOW)
const ids = (...repos: BoardRepo[]) => items(...repos).map((i) => i.id)
/** Wave PR #78 merged, with a session: pod waits for a `continue` the board can send. */
const sendable = () => chess([manual, pushed(78), onlyQueue()], { prs: [gh(78, 'merged')], agents: [engineer()] })

const FIX = 'fix-scroll'
const fixClaim: Claim = { portBase: 3100, repoPath: '/c', plan: FIX }
const fixEngineer = engineer({ id: 'f1', plan: undefined, sprint: undefined, slice: undefined, branch: FIX, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
const fixReviewer = engineer({ id: 'f2', plan: undefined, sprint: undefined, slice: undefined, type: 'pod:reviewer', kind: 'fix', branch: FIX, startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })

describe('attention items', () => {
  test('only three tiers count', () => {
    expect(items(chess([manual, onlyQueue(BLOCKED)]))).toMatchObject([{ id: `chess\nentry:${BLOCKED}`, tier: 'blocked' }])
    expect(items(chess([manual, pushed(78), onlyQueue()], { prs: [gh(78, 'open')] }))).toMatchObject([{ id: 'chess\npr:78', tier: 'merge' }])
    expect(items(sendable())).toMatchObject([{ id: 'chess\nwave-merged:78', tier: 'reply' }])

    expect(ids(chess([manual, onlyQueue(PENDING, TO_ORCHESTRATOR)]))).toEqual([])
    // Beside a BLOCKED → human, they still don't count.
    expect(ids(chess([manual, onlyQueue(PENDING, BLOCKED, TO_ORCHESTRATOR)]))).toEqual([`chess\nentry:${BLOCKED}`])
  })

  test('items come from the card and the rest', () => {
    const repo = chess([manual, pushed(78), onlyQueue(BLOCKED)], { prs: [gh(78, 'open')] })
    expect(ids(repo)).toEqual([`chess\nentry:${BLOCKED}`, 'chess\npr:78'])
  })

  test("autopilot's own merges don't count", () => {
    expect(ids(chess([pushed(78), onlyQueue()], { prs: [gh(78, 'open')] }))).toEqual([])
    // The same wave on a /pod:code run is yours to merge.
    expect(ids(chess([manual, pushed(78), onlyQueue()], { prs: [gh(78, 'open')] }))).toEqual(['chess\npr:78'])
  })

  test('one merge is one item', () => {
    // The panel asks for a reply here: "Merge PR #78, then reply continue."
    const repo = chess([manual, pushed(78), onlyQueue()], { prs: [gh(78, 'open')], agents: [engineer()] })
    expect(items(repo)).toMatchObject([{ id: 'chess\npr:78', tier: 'merge', title: 'Merge PR #78' }])
  })

  test('a reply is keyed by its stop', () => {
    const later = chess([manual, pushed(79), onlyQueue()], { prs: [gh(79, 'merged')], agents: [engineer()] })
    expect(ids(sendable())).toEqual(['chess\nwave-merged:78'])
    expect(ids(later)).toEqual(['chess\nwave-merged:79'])
    // The same stop on a later Board has the same identity.
    expect(attentionItems(boardOf([sendable()]), NOW + 5 * MIN).map((i) => i.id)).toEqual(['chess\nwave-merged:78'])
  })

  test('identity spans repos', () => {
    const a = chess([manual, onlyQueue(BLOCKED)])
    const b = chess([manual, onlyQueue(BLOCKED)], { id: 'chess-2', name: 'chess-web-2', path: '/d' })
    expect(ids(a, b)).toEqual([`chess\nentry:${BLOCKED}`, `chess-2\nentry:${BLOCKED}`])

    // A fix run and the plan run both list an entry that joins no plan: one item, and the first run in list order opens.
    const board = boardOf([chess([manual, onlyQueue(UNJOINED)], { claims: [fixClaim], agents: [fixEngineer, fixReviewer] })])
    const runs = listRuns(board, NOW)
    expect(runs.map((r) => r.plan).sort()).toEqual([FIX, PLAN].sort())
    expect(attentionItems(board, NOW)).toMatchObject([{ id: `chess\nentry:${UNJOINED}`, hash: hashFor(runs[0]!) }])
  })

  test('auto-continue needs no human', () => {
    const on = { autoContinue: [{ repoId: 'chess', run: PLAN }] }
    expect(attentionItems(boardOf([sendable()], on), NOW)).toEqual([])
    // Off, or on for another repo or run: it waits for you.
    expect(attentionItems(boardOf([sendable()], { autoContinue: [] }), NOW).map((i) => i.id)).toEqual(['chess\nwave-merged:78'])
    expect(attentionItems(boardOf([sendable()], { autoContinue: [{ repoId: 'other', run: PLAN }] }), NOW)).toHaveLength(1)
    expect(attentionItems(boardOf([sendable()], { autoContinue: [{ repoId: 'chess', run: 'other' }] }), NOW)).toHaveLength(1)

    // A toggled run with no session can't send by itself, so it waits for you too.
    const noSession = chess([manual, pushed(78), onlyQueue()], { prs: [gh(78, 'merged')] })
    expect(attentionItems(boardOf([noSession], on), NOW)).toHaveLength(1)

    // A go reply is never sent for you: a plan with no sprint started waits for it, toggled or not.
    const fresh = chess([manual, onlyQueue(), (f) => {
      f['pod-docs/plans/fresh.md'] = ['# Plan: Fresh', '', '_Slug: fresh · Status: active_', '', '## Sprints', '', '| Sprint | Slug | Status |', '|---|---|---|', '| 1 | one | planned |', ''].join('\n')
    }], { claims: [{ portBase: 3100, repoPath: '/c', plan: 'fresh' }], agents: [engineer({ id: 'g1', plan: 'fresh', sprint: undefined, slice: undefined })] })
    const toggled = attentionItems(boardOf([fresh], { autoContinue: [{ repoId: 'chess', run: 'fresh' }] }), NOW)
    expect(toggled.map((i) => i.id)).toContain('chess\nnot-started:fresh')
  })

  test('a click names the run', () => {
    // A repo id with characters to encode.
    const plan = chess([manual, onlyQueue(BLOCKED)], { id: 'a b/c#d' })
    expect(items(plan)[0]?.hash).toBe(`#/a%20b%2Fc%23d/${PLAN}`)

    const fix = chess([onlyQueue()], { claims: [fixClaim], agents: [fixEngineer, fixReviewer], prs: [gh(36, 'open', { branch: FIX })] })
    expect(items(fix)).toMatchObject([{ id: 'chess\npr:36', hash: `#/chess/${FIX}` }])

    // A repo with no plans: its row names no plan, and an entry that joins none shows there.
    const bare = chess([onlyQueue(UNJOINED)], { id: 'bare' })
    bare.model = { ...bare.model, plans: [] }
    expect(items(bare)).toMatchObject([{ id: `bare\nentry:${UNJOINED}`, hash: '#/bare' }])
  })

  test('a fix PR merged long after its review still raises its Continue', () => {
    const late = { ...fixReviewer, lastAt: NOW - 44 * MIN }
    const repoAt = (ago: number) => chess([onlyQueue()], { claims: [fixClaim], agents: [fixEngineer, late], prs: [gh(36, 'merged', { branch: FIX, mergedAt: NOW - ago * MIN })] })
    expect(items(repoAt(1))).toMatchObject([{ id: 'chess\nfix-merged:36', hash: `#/chess/${FIX}` }])
    // However old the merge, while the claim stands.
    expect(items(repoAt(3 * 24 * 60))).toMatchObject([{ id: 'chess\nfix-merged:36' }])
  })

  test('on a toggled fix run, only a merge the board will send for stays quiet', () => {
    const repoAt = (mergedAt: number | undefined) =>
      chess([onlyQueue()], { claims: [fixClaim], agents: [fixEngineer, fixReviewer], prs: [gh(36, 'merged', { branch: FIX, ...(mergedAt === undefined ? {} : { mergedAt }) })] })
    const on = { autoContinue: [{ repoId: 'chess', run: FIX }] }
    const idsOf = (mergedAt: number | undefined) => attentionItems(boardOf([repoAt(mergedAt)], on), NOW).map((i) => i.id)
    // Auto-continue sends this one by itself.
    expect(idsOf(NOW - MIN)).toEqual([])
    // It won't send these, so they wait on you.
    expect(idsOf(NOW - 45 * MIN)).toEqual(['chess\nfix-merged:36'])
    expect(idsOf(undefined)).toEqual(['chess\nfix-merged:36'])
  })

  test('a key the toggle already sent raises nothing, also past the 30 minutes', () => {
    const repoAt = (ago: number) => chess([onlyQueue()], { claims: [fixClaim], agents: [fixEngineer, fixReviewer], prs: [gh(36, 'merged', { branch: FIX, mergedAt: NOW - ago * MIN })] })
    const idsOf = (ago: number, lastKey?: string) =>
      attentionItems(boardOf([repoAt(ago)], { autoContinue: [{ repoId: 'chess', run: FIX, ...(lastKey === undefined ? {} : { lastKey }) }] }), NOW).map((i) => i.id)
    expect(idsOf(45, 'fix-merged:36')).toEqual([])
    expect(idsOf(3 * 24 * 60, 'fix-merged:36')).toEqual([])
    // Another stop's key doesn't count, and neither does another run's.
    expect(idsOf(45, 'fix-merged:99')).toEqual(['chess\nfix-merged:36'])
    expect(idsOf(45)).toEqual(['chess\nfix-merged:36'])
    const other = attentionItems(boardOf([repoAt(45)], { autoContinue: [{ repoId: 'chess', run: 'fix-other', lastKey: 'fix-merged:36' }] }), NOW)
    expect(other.map((i) => i.id)).toEqual(['chess\nfix-merged:36'])
  })

  test('a /pod:task run raises the same tray items as a fix run, under its task-<slug> name', () => {
    const TASK = 'task-scroll'
    const claims = [{ ...fixClaim, plan: TASK }]
    const agents = [{ ...fixEngineer, branch: TASK }, { ...fixReviewer, kind: 'task', branch: TASK }]
    const repoWith = (state: PrStatus['state'], mergedAt?: number) =>
      chess([onlyQueue()], { claims, agents, prs: [gh(36, state, { branch: TASK, ...(mergedAt === undefined ? {} : { mergedAt }) })] })
    // Open and reviewed: you merge.
    expect(items(repoWith('open'))).toMatchObject([{ id: 'chess\npr:36', hash: `#/chess/${TASK}`, run: 'Scroll' }])
    // Merged: Send continue, however old the merge, until a toggle sends it.
    expect(items(repoWith('merged', NOW - 3 * 24 * 60 * MIN))).toMatchObject([{ id: 'chess\nfix-merged:36', hash: `#/chess/${TASK}` }])
    const on = (lastKey?: string) => ({ autoContinue: [{ repoId: 'chess', run: TASK, ...(lastKey === undefined ? {} : { lastKey }) }] })
    expect(attentionItems(boardOf([repoWith('merged', NOW - MIN)], on()), NOW)).toEqual([])
    expect(attentionItems(boardOf([repoWith('merged', NOW - 45 * MIN)], on()), NOW).map((i) => i.id)).toEqual(['chess\nfix-merged:36'])
    expect(attentionItems(boardOf([repoWith('merged', NOW - 45 * MIN)], on('fix-merged:36')), NOW)).toEqual([])
  })

  test('a plan run reads its sent key as it always did: with no session to send to, it waits for you', () => {
    const noSession = chess([manual, pushed(78), onlyQueue()], { prs: [gh(78, 'merged')] })
    const on = { autoContinue: [{ repoId: 'chess', run: PLAN, lastKey: 'wave-merged:78' }] }
    expect(attentionItems(boardOf([noSession], on), NOW).map((i) => i.id)).toEqual(['chess\nwave-merged:78'])
    // With a session it stays quiet, whatever the key.
    expect(attentionItems(boardOf([sendable()], on), NOW)).toEqual([])
  })

  test('a plan run whose send of this key failed raises the item, with a session too', () => {
    const failed = (lastKey: string) => attentionItems(boardOf([sendable()], { autoContinue: [{ repoId: 'chess', run: PLAN, lastKey, lastFailed: true }] }), NOW).map((i) => i.id)
    expect(failed('wave-merged:78')).toEqual(['chess\nfailed:wave-merged:78'])
    // A mark on another key is an older stop: the board sends this one by itself.
    expect(failed('wave-merged:77')).toEqual([])
  })

  describe('a failed send on a toggled fix run', () => {
    const repoAt = chess([onlyQueue()], { claims: [fixClaim], agents: [fixEngineer, fixReviewer], prs: [gh(36, 'merged', { branch: FIX, mergedAt: NOW - 5 * MIN })] })
    const actions = [{ at: NOW - MIN, action: 'resume', repoId: 'chess', repo: 'chess', target: `${FIX} · continue`, result: 'failed', reply: 'continue', auto: true }] as const
    const idsWith = (toggle: { lastKey: string; lastFailed?: true }) =>
      attentionItems(boardOf([repoAt], { autoContinue: [{ repoId: 'chess', run: FIX, ...toggle }], actions: [...actions] }), NOW).map((i) => i.id)

    test('raises the item when the send for this key failed', () => {
      // Its own id, so it sends a toast even when the stop already did.
      expect(idsWith({ lastKey: 'fix-merged:36', lastFailed: true })).toEqual(['chess\nfailed:fix-merged:36'])
    })

    test('stays quiet when the send for this key started, whatever the action log says', () => {
      // PR #88's fix matched the log's failure by run, so a key that started still toasted `Send continue`.
      expect(idsWith({ lastKey: 'fix-merged:36' })).toEqual([])
    })
  })

  test('a bad repo is quiet', () => {
    const good = chess([manual, onlyQueue(BLOCKED)], { id: 'good', path: '/g' })
    const error = chess([manual, onlyQueue(BLOCKED)], { error: 'cannot read repo' })
    expect(ids(error, good)).toEqual([`good\nentry:${BLOCKED}`])

    const unsupported = chess([manual, onlyQueue(BLOCKED)], { id: 'old', path: '/o' })
    unsupported.model = { ...unsupported.model, docs: { ...unsupported.model.docs, supported: false } }
    expect(ids(unsupported, good)).toEqual([`good\nentry:${BLOCKED}`])
  })

  test('the words come from the existing rules', () => {
    const blocked = items(chess([manual, onlyQueue(BLOCKED)]))
    expect(blocked).toMatchObject([{ title: "T1 can't reach the rates file." }])
    expect(blocked[0]?.run).toBe(chess().model.plans.find((p) => p.slug === PLAN)?.title)
    expect(items(sendable())).toMatchObject([{ title: 'Send continue' }])
  })
})
