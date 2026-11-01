import { cpSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Board } from '@pod-board/model'
import * as model from '@pod-board/model'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createBoardService, finalPrBranches, livePrNumbers, type BoardServiceDeps } from './board-service.ts'
import type { GhReader, GhStatus, PrStatus } from './gh.ts'
import { normalizeRepoPath, repoId } from './guard.ts'
import { projectDirName } from './transcript-files.ts'
import { createBoardWatcher } from './watcher.ts'

// The model as is, with handBackPr and parseAgentTranscript watched, so the test can see the
// server uses the model's rule and parses only the transcripts that changed.
vi.mock('@pod-board/model', async (original) => {
  const actual = await original<typeof import('@pod-board/model')>()
  return { ...actual, handBackPr: vi.fn(actual.handBackPr), parseAgentTranscript: vi.fn(actual.parseAgentTranscript) }
})

const platform = process.platform
const caseless = platform === 'win32' || platform === 'darwin'
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'model', 'fixtures', 'chess-web')
const NOW = Date.parse('2026-10-18T12:00:00Z')

let root: string
let configFile: string
let portsDir: string
let claudeDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pod-board-a1-svc-'))
  configFile = join(root, 'config', 'config.json')
  portsDir = join(root, 'ports')
  claudeDir = join(root, 'claude')
  await mkdir(portsDir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A copy of a model fixture (chess-web by default) at `<root>/repos/<name>`. */
function copyFixture(name = 'chess-web', fixture = 'chess-web'): string {
  const repo = join(root, 'repos', name)
  cpSync(join(dirname(FIXTURE), fixture), repo, { recursive: true })
  return repo
}

async function register(...paths: string[]): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, JSON.stringify({ version: 1, repos: paths.map((path) => ({ path })) }))
}

async function claim(port: number, repoPath: string, plan: string): Promise<void> {
  await writeFile(join(portsDir, String(port)), `${repoPath} ${plan}\n`)
}

const ts = (min: number) => new Date(NOW - 10 * 60_000 + min * 60_000).toISOString()

const subagentsOf = (repoPath: string) => join(claudeDir, 'projects', projectDirName(repoPath), 'session-1', 'subagents')

async function transcript(repoPath: string, id: string, agentType: string, prompt: string, description = `Build ${id}`): Promise<void> {
  const sub = subagentsOf(repoPath)
  await mkdir(sub, { recursive: true })
  await writeFile(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType, description }))
  const lines = [
    { type: 'user', timestamp: ts(0), message: { role: 'user', content: prompt } },
    {
      type: 'assistant',
      timestamp: ts(2),
      message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 50 }, content: [] },
    },
  ]
  await writeFile(join(sub, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

type FakeGh = GhReader & { refreshed: { repoPath: string; numbers: number[]; branches?: string[]; staging?: string[] }[]; asked: number[] }

function fakeGh(prs: Record<number, PrStatus['state']> = {}, status: GhStatus = 'ok', byBranch: Record<string, PrStatus> = {}): FakeGh {
  const refreshed: FakeGh['refreshed'] = []
  const asked: number[] = []
  return {
    refreshed,
    asked,
    status: () => status,
    checkedAt: () => NOW,
    get(_repoPath, n) {
      asked.push(n)
      const state = prs[n]
      return state ? { number: n, state, checks: 'pass', checkedAt: NOW } : undefined
    },
    getBranch: (_repoPath, branch) => byBranch[branch],
    async refresh(repoPath, numbers, branches = [], staging = []) {
      refreshed.push({
        repoPath,
        numbers: [...numbers],
        ...(branches.length > 0 ? { branches: [...branches] } : {}),
        ...(staging.length > 0 ? { staging: [...staging] } : {}),
      })
      return false
    },
  }
}

function deps(gh: GhReader = fakeGh()): BoardServiceDeps {
  return { configFile, portsDir, claudeDir, transcriptDays: 30, platform, gh, now: () => NOW }
}

const ENGINEER_PROMPT = '- **sprint slug:** ladder\n- **slice code:** T1\n- **branch name:** ladder-T1\n'

describe('board service', () => {
  test('builds the board', async () => {
    const repo = copyFixture()
    await register(repo)
    // The claim names the repo with forward slashes and a trailing one, as pod writes it.
    await claim(3100, repo.replaceAll('\\', '/') + '/', 'sparring-ladder')
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    await transcript(repo, 'other', 'general-purpose', 'not a pod agent')

    const board = await createBoardService(deps()).build()
    const path = normalizeRepoPath(repo, platform)

    expect(board.generatedAt).toBe(NOW)
    expect(board.gh).toBe('ok')
    expect(board.ghCheckedAt).toBe(NOW)
    // The transcript day window, so the page knows which agent starts it can trust.
    expect(board.transcriptDays).toBe(30)
    expect(board.repos).toHaveLength(1)
    const [r] = board.repos
    expect(r).toMatchObject({ id: repoId(path, platform, caseless), name: 'chess-web', path, source: 'both' })
    expect(r!.error).toBeUndefined()
    expect(r!.model.docs.supported).toBe(true)
    expect(r!.model.plans.map((p) => p.slug)).toContain('sparring-ladder')
    expect(r!.agents).toHaveLength(1)
    expect(r!.agents[0]).toMatchObject({ id: 'eng1', type: 'pod:engineer', sprint: 'ladder', slice: 'T1', tokens: 150 })
    expect(r!.claims).toEqual([{ portBase: 3100, repoPath: path, plan: 'sparring-ladder' }])
    expect(r!.prs).toEqual([])
  })

  test('board carries the action log', async () => {
    const entries = [
      { at: NOW - 1, action: 'merge', repoId: 'id-r', repo: 'r', target: 'PR #8', result: 'merged' },
      { at: NOW - 2, action: 'merge', repoId: 'id-r', repo: 'r', target: 'PR #7', result: 'stale', message: 'head now bbbbbbb' },
    ] as const
    let list: model.ActionEntry[] = []
    const withLog = createBoardService({ ...deps(), actions: () => list })
    expect((await withLog.build()).actions).toEqual([])
    list = [...entries]
    // Read on every build, so a new entry is on the next Board.
    expect((await withLog.build()).actions).toEqual(entries)
    expect(await createBoardService(deps()).build()).not.toHaveProperty('actions')
  })

  test('carries auto-continue toggles', async () => {
    let toggles: model.AutoToggle[] = []
    const withToggles = createBoardService({ ...deps(), autoContinue: () => toggles })
    expect((await withToggles.build()).autoContinue).toEqual([])
    toggles = [{ repoId: 'id-r', run: 'alpha', lastKey: 'sprint-done:one' }, { repoId: 'id-x', run: 'fix-scroll' }]
    // Read on every build; the stop keys stay in the store, off the Board.
    expect((await withToggles.build()).autoContinue).toEqual([
      { repoId: 'id-r', run: 'alpha' },
      { repoId: 'id-x', run: 'fix-scroll' },
    ])
    expect(await createBoardService(deps()).build()).not.toHaveProperty('autoContinue')
  })

  test('serves no agent description, so a secret in the meta file appears nowhere on the Board', async () => {
    const repo = copyFixture()
    await register(repo)
    const secret = `desc-secret-${Math.random().toString(36).slice(2)}`
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT, secret)
    await transcript(repo, 'rev1', 'pod:reviewer', '- **plan:** sparring-ladder\n- **round:** 1\n', `Review ${secret}`)

    const board = await createBoardService(deps()).build()
    const agents = board.repos.flatMap((r) => r.agents)
    expect(agents.map((a) => a.id).sort()).toEqual(['eng1', 'rev1'])
    for (const a of agents) expect(a).not.toHaveProperty('description')
    expect(JSON.stringify(board)).not.toContain(secret)
  })

  test('a claim alone gives a claim repo; a registered repo alone a registered one; sorted by name', async () => {
    const a = copyFixture('zeta')
    const b = copyFixture('alpha')
    await register(a)
    await claim(3200, b, 'sparring-ladder')
    await claim(3300, b, 'board-feel')
    const board = await createBoardService(deps()).build()
    expect(board.repos.map((r) => [r.name, r.source])).toEqual([
      ['alpha', 'claim'],
      ['zeta', 'registered'],
    ])
    expect(board.repos[0]!.claims.map((c) => c.portBase)).toEqual([3200, 3300])
  })

  test('the same repo listed twice in the config, by other slashes, is one repo', async () => {
    const repo = copyFixture()
    await register(repo, repo.replaceAll('\\', '/') + '/')
    const board = await createBoardService(deps()).build()
    expect(board.repos).toHaveLength(1)
  })

  test('a missing repo fails soft', async () => {
    const repo = copyFixture()
    const gone = join(root, 'repos', 'gone-repo')
    await register(gone, repo)
    const board = await createBoardService(deps()).build()
    expect(board.repos.map((r) => r.name)).toEqual(['chess-web', 'gone-repo'])
    const [ok, missing] = board.repos
    expect(ok!.error).toBeUndefined()
    expect(ok!.model.plans.length).toBeGreaterThan(0)
    expect(missing!.error).toBeTruthy()
    expect(missing!.model.docs.supported).toBe(false)
    expect(missing!.model.plans).toEqual([])
    expect(missing!.agents).toEqual([])
  })

  test('an unreadable config keeps the last registered list', async () => {
    const repo = copyFixture()
    await register(repo)
    const service = createBoardService(deps())
    expect((await service.build()).repos).toHaveLength(1)
    await writeFile(configFile, '{ not json')
    expect((await service.build()).repos.map((r) => r.name)).toEqual(['chess-web'])
  })

  test('config error on the board', async () => {
    const repo = copyFixture()
    const service = createBoardService(deps())
    // No config file: never an error.
    const none = await service.build()
    expect(none.configError).toBeUndefined()
    expect('configError' in none).toBe(false)

    // Unreadable on the first read: an error, and no registered repos.
    await mkdir(dirname(configFile), { recursive: true })
    await writeFile(configFile, '{ not json')
    const first = await service.build()
    expect(first.configError).toBe('config unreadable')
    expect(first.repos).toEqual([])

    await register(repo)
    const ok = await service.build()
    expect(ok.configError).toBeUndefined()
    expect(ok.repos.map((r) => r.name)).toEqual(['chess-web'])

    // Corrupt again: set on every build, and the last list stays.
    await writeFile(configFile, '{ not json')
    for (let i = 0; i < 2; i++) {
      const bad = await service.build()
      expect(bad.configError).toBe('config unreadable')
      expect(bad.repos.map((r) => r.name)).toEqual(['chess-web'])
    }

    // A newer config version is unreadable too, never overwritten.
    await writeFile(configFile, JSON.stringify({ version: 2, repos: [] }))
    expect((await service.build()).configError).toBe('config unreadable')

    // Fixed: cleared.
    await register(repo)
    expect((await service.build()).configError).toBeUndefined()

    // Deleted: a missing file is no error.
    await rm(configFile)
    const gone = await service.build()
    expect(gone.configError).toBeUndefined()
    expect(gone.repos).toEqual([])
  })

  test('asks gh only for live PRs', async () => {
    const repo = join(root, 'repos', 'live')
    const docs = join(repo, 'pod-docs')
    await mkdir(join(docs, 'plans'), { recursive: true })
    await mkdir(join(docs, 'sprints'), { recursive: true })
    await writeFile(join(docs, 'README.md'), '# pod docs\n\npod docs: 2\n')
    await writeFile(
      join(docs, 'plans', 'p.md'),
      [
        '# Plan: P',
        '',
        '_Generated: 2026-10-01 · Status: active_',
        '',
        '## Sprint sequence',
        '',
        '| Sprint | Goal | Status | Depends on |',
        '|---|---|---|---|',
        '| s1 | first | done | — |',
        '| s2 | second | active | — |',
        '',
      ].join('\n'),
    )
    const board = (slug: string, status: string, rows: string[]) =>
      [
        `# Sprint: ${slug}`,
        '',
        `_From plan: pod-docs/plans/p.md · Slug: ${slug} · Status: ${status} · Generated: 2026-10-01_`,
        '',
        '## Status board',
        '',
        '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
        '|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
      ].join('\n')
    await mkdir(join(docs, 'sprints', 'archive'), { recursive: true })
    // A done sprint's open PR is not asked about.
    await writeFile(
      join(docs, 'sprints', 'archive', 's1.md'),
      board('s1', 'done', ['| 1 | A1 | a | s1-A1 | [#5](https://github.com/o/r/pull/5) open | pushed | high | — |']),
    )
    await writeFile(
      join(docs, 'sprints', 's2.md'),
      board('s2', 'active', [
        '| 1 | B1 | b | s2-B1 | [#10](https://github.com/o/r/pull/10) merged | done | high | — |',
        '| 2 | B2 | c | s2-B2 | [#11](https://github.com/o/r/pull/11) open | pushed | high | — |',
        '| 2 | B3 | d | s2-B3 | — | pending | — | — |',
      ]),
    )
    // An archived plan's open PR is not asked about.
    await writeFile(
      join(docs, 'plans', 'old.md'),
      [
        '# Plan: Old',
        '',
        '_Generated: 2026-09-01 · Status: archived_',
        '',
        '## Sprint sequence',
        '',
        '| Sprint | Goal | Status | Depends on |',
        '|---|---|---|---|',
        '| o1 | old | active | — |',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(docs, 'sprints', 'o1.md'),
      [
        '# Sprint: o1',
        '',
        '_From plan: pod-docs/plans/old.md · Slug: o1 · Status: active · Generated: 2026-09-01_',
        '',
        '## Status board',
        '',
        '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
        '|---|---|---|---|---|---|---|---|',
        '| 1 | C1 | e | o1-C1 | [#13](https://github.com/o/r/pull/13) open | pushed | high | — |',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(docs, 'handoff-queue.md'),
      [
        '# Handoff Queue',
        '',
        // Resolved: not the hand-back.
        '- `[2026-10-02 · PENDING · orchestrator → human · plan: p]` Final PR https://github.com/o/r/pull/30 awaiting you. **Resolution:** done',
        // The last pending orchestrator hand-back wins.
        '- `[2026-10-03 · PENDING · orchestrator → human · plan: p]` Plan complete: final PR https://github.com/o/r/pull/20 is awaiting your merge. **Resolution:** pending',
        // Not from the orchestrator.
        '- `[2026-10-04 · PENDING · engineer → orchestrator · plan: p]` See https://github.com/o/r/pull/40 hand-back. **Resolution:** pending',
        // From the orchestrator but no hand-back words.
        '- `[2026-10-04 · PENDING · orchestrator → human · plan: p]` Look at https://github.com/o/r/pull/41 when free. **Resolution:** pending',
        '',
      ].join('\n'),
    )
    await register(repo)
    const gh = fakeGh({ 11: 'open', 20: 'open' })
    const service = createBoardService(deps(gh))

    const first = await service.build()
    expect(first.repos[0]!.model.plans.find((p) => p.slug === 'p')?.currentSprint).toBe('s2')
    await service.refreshGh(first)
    const path = normalizeRepoPath(repo, platform)
    expect(gh.refreshed).toEqual([{ repoPath: path, numbers: [11, 20] }])

    const second = await service.build()
    expect(second.repos[0]!.prs.map((p) => p.number)).toEqual([11, 20])
    expect(new Set(gh.asked)).toEqual(new Set([11, 20]))
    // The hand-back PR comes from the model's rule, not a copy.
    expect(vi.mocked(model.handBackPr)).toHaveBeenCalledWith(expect.objectContaining({ slug: 'p' }))
  })

  test("refreshGh asks about a claimed archived plan's hand-back PR, and only while it's claimed", async () => {
    // chess-web's ui-polish close-out: archived, its hand-back links PR #91.
    const repo = copyFixture('chess-web', 'chess-web-ui-polish')
    await register(repo)
    const path = normalizeRepoPath(repo, platform)

    const unclaimed = fakeGh()
    const before = createBoardService(deps(unclaimed))
    await before.refreshGh(await before.build())
    expect(unclaimed.refreshed).toEqual([{ repoPath: path, numbers: [] }])

    await claim(3200, repo, 'ui-polish')
    const gh = fakeGh({ 91: 'merged' })
    const service = createBoardService(deps(gh))
    await service.refreshGh(await service.build())
    expect(gh.refreshed).toEqual([{ repoPath: path, numbers: [91] }])
    expect((await service.build()).repos[0]!.prs.map((p) => [p.number, p.state])).toEqual([[91, 'merged']])
  })

  test('refreshGh asks for every readable repo, even with no PRs, so gh status is known; it skips repos with an error', async () => {
    const repo = copyFixture()
    await register(join(root, 'repos', 'gone'), repo)
    const gh = fakeGh()
    const service = createBoardService(deps(gh))
    expect(await service.refreshGh(await service.build())).toBe(false)
    expect(gh.refreshed).toEqual([{ repoPath: normalizeRepoPath(repo, platform), numbers: [] }])
  })

  test('a fix claim: refreshGh asks gh for its branch; the Board has its branch PR and its agents', async () => {
    const repo = copyFixture()
    const path = normalizeRepoPath(repo, platform)
    await claim(3200, repo, 'fix-clock')
    // A claim named like a plan, and one that names no fix, ask gh for no branch.
    await claim(3300, repo, 'sparring-ladder')
    await claim(3400, repo, 'somename')
    await transcript(repo, 'eng1', 'pod:engineer', 'Standalone /pod:fix slice. Parent repo: E:/r. Merge-target: main. Branch: fix-clock. Ports: 3210/3211.')
    await transcript(repo, 'rev1', 'pod:reviewer', 'kind: fix. Task as given: x.\nPR: https://github.com/o/r/pull/95. Branch: fix-clock. Merge-target: main.')

    const gh = fakeGh({}, 'ok', { 'fix-clock': { number: 95, state: 'open', checks: 'none', checkedAt: NOW, branch: 'fix-clock' } })
    const service = createBoardService(deps(gh))
    const board = await service.build()
    await service.refreshGh(board)
    expect(gh.refreshed).toEqual([{ repoPath: path, numbers: [], branches: ['fix-clock'] }])
    const r = board.repos[0]!
    expect(r.prs).toEqual([{ number: 95, state: 'open', checks: 'none', checkedAt: NOW, branch: 'fix-clock' }])
    expect(r.agents.map((a) => [a.id, a.branch, a.kind, a.pr])).toEqual([
      ['eng1', 'fix-clock', undefined, undefined],
      ['rev1', 'fix-clock', 'fix', 95],
    ])
    expect(model.listRuns(board, NOW).find((x) => x.fix === 'clock')).toMatchObject({ plan: 'fix-clock', where: 'review', state: 'running', portBase: 3200 })
  })

  test("a claimed archived plan with no hand-back yet: refreshGh asks gh for the plan's branch; the Board has its final PR", async () => {
    // chess-web's ui-polish close-out before pod writes the hand-back: the final PR is open on `ui-polish`.
    const repo = copyFixture('chess-web', 'chess-web-ui-polish')
    await writeFile(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
    await claim(3200, repo, 'ui-polish')
    const path = normalizeRepoPath(repo, platform)
    const pr: PrStatus = { number: 91, state: 'open', checks: 'pass', checkedAt: NOW, branch: 'ui-polish' }
    const gh = fakeGh({}, 'ok', { 'ui-polish': pr })
    const service = createBoardService(deps(gh))
    const board = await service.build()
    await service.refreshGh(board)
    expect(gh.refreshed).toEqual([{ repoPath: path, numbers: [], branches: ['ui-polish'] }])
    expect(board.repos[0]!.prs).toEqual([pr])
    const ship = model.buildPipeline(board.repos[0]!, 'ui-polish', NOW)?.stages.find((s) => s.key === 'ship')?.steps
    expect(ship).toEqual([{ key: 'final-pr', label: 'Final PR', state: 'wait', detail: 'PR #91 · after review' }])
  })

  test("a final PR into a staging branch: refreshGh asks gh for that branch too, and the Board has its PR", async () => {
    // ui-polish's final PR #91 merged into `ui-polish-staging`; the staging PR #95 to main is open.
    const repo = copyFixture('chess-web', 'chess-web-ui-polish')
    await writeFile(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
    await claim(3200, repo, 'ui-polish')
    const path = normalizeRepoPath(repo, platform)
    const final: PrStatus = { number: 91, state: 'merged', checks: 'pass', checkedAt: NOW, branch: 'ui-polish', base: 'ui-polish-staging' }
    const staging: PrStatus = { number: 95, state: 'open', checks: 'pass', checkedAt: NOW, branch: 'ui-polish-staging', base: 'main' }
    const gh = fakeGh({}, 'ok', { 'ui-polish': final, 'ui-polish-staging': staging })
    const service = createBoardService(deps(gh))
    const board = await service.build()
    await service.refreshGh(board)
    expect(gh.refreshed).toEqual([{ repoPath: path, numbers: [], branches: ['ui-polish'], staging: ['ui-polish-staging'] }])
    expect(board.repos[0]!.prs).toEqual([final, staging])
    const ship = model.buildFlow(board.repos[0]!, 'ui-polish', NOW)?.find((s) => s.key === 'ship')?.steps
    expect(ship?.map((s) => [s.label, s.state, s.detail])).toEqual([
      ['Final PR', 'done', 'merged PR #91'],
      ['Staging → main', 'you', 'PR #95 · you merge'],
    ])
  })

  test('a pending gate 7 naming the staging PR keeps it found by branch: the staging Merge stays', async () => {
    // As above, plus the gate 7 entry, which makes the server ask gh about #95 by number too.
    const repo = copyFixture('chess-web', 'chess-web-ui-polish')
    const gate7 =
      '- `[2026-10-28 · PENDING · orchestrator → human · plan: ui-polish]` gate 7 (plan-complete): plan ui-polish merged to `ui-polish-staging` (final PR https://github.com/o/r/pull/91); review it and merge the staging PR https://github.com/o/r/pull/95 to `main` when ready. **Resolution:** pending'
    await writeFile(join(repo, 'pod-docs', 'handoff-queue.md'), `# Handoff Queue\n\n${gate7}\n`)
    await claim(3200, repo, 'ui-polish')
    const final: PrStatus = { number: 91, state: 'merged', checks: 'pass', checkedAt: NOW, branch: 'ui-polish', base: 'ui-polish-staging' }
    const staging: PrStatus = { number: 95, state: 'open', checks: 'pass', checkedAt: NOW, branch: 'ui-polish-staging', base: 'main' }
    const gh = fakeGh({ 95: 'open' }, 'ok', { 'ui-polish': final, 'ui-polish-staging': staging })
    const board = await createBoardService(deps(gh)).build()
    expect(gh.asked).toContain(95)
    const r = board.repos[0]!
    // #95 once, the copy found by branch (it carries the branch the staging rule looks for).
    expect(r.prs.filter((p) => p.number === 95)).toEqual([staging])
    const plan = r.model.plans.find((p) => p.slug === 'ui-polish')!
    expect(model.stagingPr(r, plan)).toBe(95)
    const ship = model.buildFlow(r, 'ui-polish', NOW)?.find((s) => s.key === 'ship')?.steps
    expect(ship?.map((s) => [s.label, s.state, s.detail])).toContainEqual(['Staging → main', 'you', 'PR #95 · you merge'])
  })

  test('a PR found by branch that is also a numbered live PR is on the Board once', async () => {
    const repo = copyFixture()
    // A hand-back linking #77 makes #77 a live PR by number too.
    const queue = join(repo, 'pod-docs', 'handoff-queue.md')
    const handBack = '- `[2026-10-20 · PENDING · orchestrator → human · plan: sparring-ladder]` plan sparring-ladder complete — final PR https://github.com/o/r/pull/77 **Resolution:** pending'
    await writeFile(queue, `${await readFile(queue, 'utf8')}\n${handBack}\n`)
    await claim(3200, repo, 'fix-clock')
    const pr: PrStatus = { number: 77, state: 'open', checks: 'none', checkedAt: NOW, branch: 'fix-clock' }
    const gh = fakeGh({ 77: 'open' }, 'ok', { 'fix-clock': pr })
    const board = await createBoardService(deps(gh)).build()
    expect(gh.asked).toContain(77)
    expect(board.repos[0]!.prs.filter((p) => p.number === 77)).toEqual([pr])
  })

  test('never writes into a repo', async () => {
    const repo = copyFixture()
    await register(repo)
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    const before = await snapshot(repo)

    const service = createBoardService(deps())
    await service.build()
    const watcher = createBoardWatcher({ service, configFile, portsDir, claudeDir })
    await watcher.start()
    const changed = new Promise<Board>((resolve) => watcher.subscribe(resolve))
    // A new claim outside the repo makes one watch cycle.
    await claim(3100, repo, 'sparring-ladder')
    const next = await withTimeout(changed, 5000)
    expect(next.repos[0]!.claims).toHaveLength(1)
    await watcher.close()

    expect(await snapshot(repo)).toEqual(before)
  })
})

/** Every file and folder under `dir` with its bytes and mtime. */
async function snapshot(dir: string): Promise<Record<string, { bytes?: string; mtimeMs: number }>> {
  const out: Record<string, { bytes?: string; mtimeMs: number }> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name)
    const info = await stat(full)
    out[full] = entry.isFile()
      ? { bytes: (await readFile(full)).toString('base64'), mtimeMs: info.mtimeMs }
      : { mtimeMs: info.mtimeMs }
  }
  return out
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))])
}

describe('transcript cache', () => {
  const parsed = vi.mocked(model.parseAgentTranscript)
  const jsonlOf = (repo: string, id: string) => join(subagentsOf(repo), `agent-${id}.jsonl`)
  const metaOf = (repo: string, id: string) => join(subagentsOf(repo), `agent-${id}.meta.json`)
  const line = (r: unknown) => JSON.stringify(r) + '\n'
  const usage = (min: number, id: string, tokens: number, extra: Record<string, unknown> = {}) =>
    line({ type: 'assistant', timestamp: ts(min), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: tokens, output_tokens: 0 }, content: [], ...extra } })
  const json = (b: Board) => JSON.stringify(b)
  /** The ids of the agents parsed since the last call. */
  const parsedIds = () => {
    const ids = parsed.mock.calls.map(([f]) => f.id).sort()
    parsed.mockClear()
    return ids
  }

  // A block body: a function returned from beforeEach runs as its cleanup.
  beforeEach(() => {
    parsed.mockClear()
  })

  test('a second build with no file changed parses no transcript, across every repo', async () => {
    const a = copyFixture('alpha')
    const b = copyFixture('beta')
    await register(a, b)
    await transcript(a, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    await transcript(b, 'eng2', 'pod:engineer', ENGINEER_PROMPT)
    await transcript(b, 'other', 'general-purpose', 'not a pod agent')
    const service = createBoardService(deps())
    const first = await service.build()
    expect(parsedIds()).toEqual(['eng1', 'eng2', 'other'])
    const second = await service.build()
    expect(parsedIds()).toEqual([])
    expect(json(second)).toBe(json(first))
  })

  test('only the transcript that grew, or whose meta changed, is parsed again', async () => {
    const repo = copyFixture()
    await register(repo)
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    await transcript(repo, 'rev1', 'general-purpose', '- **plan:** sparring-ladder\n- **round:** 1\n')
    const service = createBoardService(deps())
    await service.build()
    parsedIds()

    await appendFile(jsonlOf(repo, 'eng1'), usage(5, 'm2', 1000))
    const grown = await service.build()
    expect(parsedIds()).toEqual(['eng1'])
    expect(grown.repos[0]!.agents[0]).toMatchObject({ id: 'eng1', tokens: 1150, lastAt: Date.parse(ts(5)) })

    await writeFile(metaOf(repo, 'rev1'), JSON.stringify({ agentType: 'pod:reviewer' }))
    const meta = await service.build()
    expect(parsedIds()).toEqual(['rev1'])
    expect(meta.repos[0]!.agents.map((x) => x.id)).toEqual(['eng1', 'rev1'])
  })

  test('a transcript that leaves the listing is forgotten, and parsed again when it comes back', async () => {
    const repo = copyFixture()
    await register(repo)
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    const service = createBoardService(deps())
    await service.build()
    parsedIds()

    // The session is older than the 30-day window: off the listing and the Board.
    const old = new Date(NOW - 40 * 24 * 60 * 60_000)
    const session = dirname(subagentsOf(repo))
    await utimes(subagentsOf(repo), old, old)
    await utimes(session, old, old)
    expect((await service.build()).repos[0]!.agents).toEqual([])
    expect(parsedIds()).toEqual([])

    const back = new Date(NOW)
    await utimes(subagentsOf(repo), back, back)
    await utimes(session, back, back)
    expect((await service.build()).repos[0]!.agents.map((x) => x.id)).toEqual(['eng1'])
    expect(parsedIds()).toEqual(['eng1'])
  })

  test('a transcript deleted after a build drops off the Board', async () => {
    const repo = copyFixture()
    await register(repo)
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    const service = createBoardService(deps())
    expect((await service.build()).repos[0]!.agents).toHaveLength(1)
    await rm(jsonlOf(repo, 'eng1'))
    expect((await service.build()).repos[0]!.agents).toEqual([])
  })

  test('the Board built from the cache is byte for byte the Board built fresh, through appends, resumes, and rewrites', async () => {
    const repo = copyFixture()
    const second = copyFixture('second')
    await register(repo)
    await transcript(repo, 'eng1', 'pod:engineer', ENGINEER_PROMPT)
    await transcript(repo, 'rev1', 'pod:reviewer', '- **plan:** sparring-ladder\n- **round:** 1\n')
    await transcript(repo, 'other', 'general-purpose', 'not a pod agent')
    const cached = createBoardService(deps())
    const same = async (step: string) => {
      const fromCache = json(await cached.build())
      expect(fromCache, step).toBe(json(await createBoardService(deps()).build()))
    }
    await same('start')

    await appendFile(jsonlOf(repo, 'eng1'), usage(3, 'm2', 500))
    await same('appended')

    // A record half written: skipped until it's whole, both ways.
    const record = usage(4, 'm3', 70, { content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: {} }] })
    await appendFile(jsonlOf(repo, 'eng1'), record.slice(0, 40))
    await same('half a record')
    await appendFile(jsonlOf(repo, 'eng1'), record.slice(40))
    await same('the record finished: handed back')

    // The coordinator resumes it (SendMessage): a second turn, then a second hand-back.
    await appendFile(
      jsonlOf(repo, 'eng1'),
      line({ type: 'user', timestamp: ts(6), origin: { kind: 'coordinator' }, message: { role: 'user', content: 'fix pass' } }) +
        usage(7, 'm4', 30),
    )
    await same('resumed')
    await appendFile(jsonlOf(repo, 'eng1'), usage(8, 'm5', 9, { stop_reason: 'end_turn' }))
    await same('handed back again')

    // The same message streamed again with its final usage replaces its first count.
    await appendFile(jsonlOf(repo, 'rev1'), usage(5, 'm1', 999))
    await same('a streamed message')

    await writeFile(metaOf(repo, 'other'), JSON.stringify({ agentType: 'pod:engineer' }))
    await same('meta now a pod agent')
    await writeFile(metaOf(repo, 'other'), 'not json')
    await same('meta unreadable')

    await writeFile(jsonlOf(repo, 'eng1'), line({ type: 'user', timestamp: ts(1), message: { role: 'user', content: ENGINEER_PROMPT } }))
    await same('rewritten shorter')

    await rm(jsonlOf(repo, 'rev1'))
    await same('deleted')

    await register(repo, second)
    await transcript(second, 'eng9', 'pod:engineer', ENGINEER_PROMPT)
    await same('a second repo')
  })
})

describe('finalPrBranches', () => {
  const README = '# pod docs\n\npod docs: 2\n'
  const plan = (slug: string, status: string, sprints: [string, string][]) =>
    [
      `# Plan: ${slug}`,
      '',
      `_Generated: 2026-10-18 · Status: ${status} · Grilled-with: grilling_`,
      '',
      '## Sprint sequence',
      '',
      '| Sprint | Goal | Status | Depends on |',
      '|--------|------|--------|------------|',
      ...sprints.map(([s, st]) => `| ${s} | goal | ${st} | — |`),
      '',
    ].join('\n')
  const handBack = (slug: string, pending = true) =>
    `- \`[2026-10-20 · PENDING · orchestrator → human · plan: ${slug}]\` plan ${slug} complete — final PR https://github.com/o/r/pull/9 **Resolution:** ${pending ? 'pending' : '2026-10-20 — merged'}`
  const branches = (plans: Record<string, string>, claimed: string[] = [], queue: string[] = []) =>
    finalPrBranches(
      model.buildRepoModel({
        'pod-docs/README.md': README,
        'pod-docs/handoff-queue.md': ['# Handoff Queue', '', ...queue, ''].join('\n'),
        ...Object.fromEntries(Object.entries(plans).map(([slug, doc]) => [`pod-docs/plans/${slug}.md`, doc])),
      }),
      claimed.map((p) => ({ plan: p })),
    )

  test('a plan with every sprint done (final review, close-out) gives its slug; one mid-sprint gives none', () => {
    expect(branches({ alpha: plan('alpha', 'active', [['one', 'done'], ['two', 'done']]) })).toEqual(['alpha'])
    expect(branches({ alpha: plan('alpha', 'active', [['one', 'done'], ['two', 'active']]) })).toEqual([])
    // No sprints yet is not close-out.
    expect(branches({ alpha: plan('alpha', 'active', []) })).toEqual([])
  })

  test('an archived or done plan only while a claim names it', () => {
    const plans = { alpha: plan('alpha', 'archived', [['one', 'done']]), beta: plan('beta', 'done', [['b', 'done']]) }
    expect(branches(plans)).toEqual([])
    expect(branches(plans, ['alpha', 'beta'])).toEqual(['alpha', 'beta'])
  })

  test('a pending hand-back is asked by number, not by branch; a resolved one is no hand-back', () => {
    const plans = { alpha: plan('alpha', 'active', [['one', 'done']]) }
    expect(branches(plans, [], [handBack('alpha')])).toEqual([])
    expect(branches(plans, [], [handBack('alpha', false)])).toEqual(['alpha'])
  })
})

describe('livePrNumbers: the staging PR a pending gate 7 names', () => {
  const README = '# pod docs\n\npod docs: 2\n'
  const archived = ['# Plan: old', '', '_Generated: 2026-10-18 · Status: archived · Grilled-with: grilling_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | done | — |', ''].join('\n')
  const gate7 = (resolution = 'pending', plan = ' · plan: old') =>
    `- \`[2026-10-20 · PENDING · orchestrator → human${plan}]\` gate 7 (plan-complete): plan old merged to \`pod-staging\` (final PR https://github.com/o/r/pull/20); review it and merge the staging PR https://github.com/o/r/pull/21 to \`main\` when ready. **Resolution:** ${resolution}`
  const numbers = (queue: string[]) =>
    livePrNumbers(
      model.buildRepoModel({ 'pod-docs/README.md': README, 'pod-docs/plans/archive/old.md': archived, 'pod-docs/handoff-queue.md': ['# Handoff Queue', '', ...queue, ''].join('\n') }),
    )

  test('asked by number while the entry is pending, whatever the plan, once', () => {
    // The archived, unclaimed plan gives nothing else; the gate 7 gives its staging PR, not its final PR.
    expect(numbers([gate7()])).toEqual([21])
    // An entry that joins no plan counts too; two entries naming the same PR ask once.
    expect(numbers([gate7('pending', ''), gate7()])).toEqual([21])
    // `#N` instead of a URL.
    expect(numbers([gate7().replace('https://github.com/o/r/pull/21', '#22')])).toEqual([22])
  })

  test('not once resolved, nor for an entry that names no staging PR', () => {
    expect(numbers([gate7('2026-10-21 — merged')])).toEqual([])
    expect(numbers([gate7().replace('the staging PR https://github.com/o/r/pull/21', 'the staging branch')])).toEqual([])
  })
})
