import { describe, expect, it } from 'vitest'
import * as model from './index.ts'
import type { AgentRun, BoardRepo, Claim, PrStatus } from './board.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'
import { waitingPrs, type WaitingPr } from './waiting-prs.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 9, 21, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string]

function planDoc(slug: string, sprints: SprintRow[], status = 'active'): string {
  return [
    `# Plan: ${slug}`,
    '',
    `_Generated: 2026-10-21 · Status: ${status} · Grilled-with: grilling_`,
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, st]) => `| ${s} | goal of ${s} | ${st} | — |`),
    '',
  ].join('\n')
}

function sprintDoc(slug: string, plan: string, board: BoardRow[]): string {
  return [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-10-21_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    ...board.map(([w, code, pr, status]) => `| ${w} | ${code} | Title ${code} | ${slug}-${code} | ${pr} | ${status} | medium | — |`),
    '',
  ].join('\n')
}

type Opts = { sprints?: SprintRow[]; docs?: Record<string, BoardRow[]>; queue?: string[]; status?: string }

function files(opts: Opts = {}): RepoFiles {
  const sprints = opts.sprints ?? [['one', 'active']]
  const out: RepoFiles = {
    'pod-docs/README.md': README,
    'pod-docs/plans/alpha.md': planDoc('alpha', sprints, opts.status),
    'pod-docs/handoff-queue.md': (opts.queue ?? []).join('\n'),
  }
  for (const [s, rows] of Object.entries(opts.docs ?? {})) out[`pod-docs/sprints/${s}.md`] = sprintDoc(s, 'alpha', rows)
  return out
}

function repo(f: RepoFiles, extra: Partial<BoardRepo> = {}): BoardRepo {
  return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(f), agents: [], prs: [], claims: [], ...extra }
}

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', tokens: 0, ended: false, ...over }
}
const running = (over: Partial<AgentRun>) => agent({ startedAt: NOW - 10 * MIN, lastAt: NOW - MIN, ...over })
const ended = (over: Partial<AgentRun>) => agent({ startedAt: NOW - 60 * MIN, lastAt: NOW - 40 * MIN, ended: true, ...over })

const queueLine = (type: string, route: string, fields: string, body: string, pending = true) =>
  `- \`[2026-10-21 · ${type} · ${route} · ${fields}]\` ${body} **Resolution:** ${pending ? 'pending' : 'fixed in #9'}`
const handBack = (n: number) => queueLine('PENDING', 'orchestrator → human', 'plan: alpha', `Plan complete: merge https://github.com/o/r/pull/${n}`)

const link = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({
  number,
  state,
  checks: 'pass',
  checkedAt: NOW,
  url: `https://github.com/o/r/pull/${number}`,
  ...over,
})
const claim = (plan: string): Claim => ({ portBase: 3100, repoPath: '/r', plan })

/** Sprint `one` of plan alpha, current, with wave 1 done and wave 2 handed back on PR #7. */
const PUSHED: BoardRow[] = [
  [1, 'A1', `${link(5)} merged`, 'done'],
  [2, 'B1', link(7), 'pushed'],
  [2, 'B2', link(7), 'pushed'],
]
const pushed = (extra: Partial<BoardRepo> = {}, rows: BoardRow[] = PUSHED) => repo(files({ docs: { one: rows } }), extra)
const waves = (r: BoardRepo) => waitingPrs(r, NOW).filter((w) => w.kind === 'wave')

describe('waitingPrs', () => {
  it('final PR waits until merged', () => {
    const done = { sprints: [['one', 'done']] as SprintRow[], docs: { one: [[1, 'A1', 'merged', 'done']] as BoardRow[] }, queue: [handBack(12)] }
    expect(waitingPrs(repo(files(done)), NOW)).toEqual([{ kind: 'final', number: 12, run: 'alpha' }])
    // gh knows it: its url comes along; still open → still waiting.
    expect(waitingPrs(repo(files(done), { prs: [gh(12, 'open')] }), NOW)).toEqual<WaitingPr[]>([
      { kind: 'final', number: 12, url: 'https://github.com/o/r/pull/12', run: 'alpha' },
    ])
    // Once gh says merged, nothing waits.
    expect(waitingPrs(repo(files(done), { prs: [gh(12, 'merged')] }), NOW)).toEqual([])
    // No hand-back: the PR gh found on the plan's branch isn't yours to merge yet (after review).
    const noHandBack = { ...done, queue: [] }
    expect(waitingPrs(repo(files(noHandBack), { prs: [gh(12, 'open', { branch: 'alpha' })] }), NOW)).toEqual([])
  })

  it('fix PR waits after review', () => {
    const name = 'fix-scroll'
    const base = { claims: [claim(name)], model: buildRepoModel({ 'pod-docs/README.md': README }) }
    const eng = ended({ branch: name, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
    const rev = ended({ type: 'pod:reviewer', kind: 'fix', branch: name, startedAt: NOW - 50 * MIN, lastAt: NOW - 40 * MIN })
    const open = gh(36, 'open', { branch: name })
    const fix = (extra: Partial<BoardRepo>) => waitingPrs({ ...repo({}), ...base, ...extra }, NOW)

    // Open and reviewed (the last agent to write is an ended reviewer) → waiting.
    expect(fix({ agents: [eng, rev], prs: [open] })).toEqual([{ kind: 'fix', number: 36, url: 'https://github.com/o/r/pull/36', run: name }])
    // Not reviewed yet, a reviewer still running, or the engineer wrote after the review → not waiting.
    expect(fix({ agents: [eng], prs: [open] })).toEqual([])
    expect(fix({ agents: [eng, running({ type: 'pod:reviewer', kind: 'fix', branch: name })], prs: [open] })).toEqual([])
    expect(fix({ agents: [eng, rev, running({ branch: name })], prs: [open] })).toEqual([])
    // Merged or closed → not waiting; no PR → not waiting.
    expect(fix({ agents: [eng, rev], prs: [gh(36, 'merged', { branch: name })] })).toEqual([])
    expect(fix({ agents: [eng, rev], prs: [gh(36, 'closed', { branch: name })] })).toEqual([])
    expect(fix({ agents: [eng, rev] })).toEqual([])
    // gh knows no url: none is set.
    expect(fix({ agents: [eng, rev], prs: [{ ...open, url: undefined }] })[0]).not.toHaveProperty('url')
  })

  it('wave PR waits when the wave is handed back', () => {
    const wave2: WaitingPr = { kind: 'wave', number: 7, run: 'alpha', sprint: 'one', wave: 2 }
    // Every unfinished slice pushed, an open PR, no agent running → one entry for the wave.
    expect(waitingPrs(pushed(), NOW)).toEqual([wave2])
    // Its engineers ended: still waiting.
    expect(waves(pushed({ agents: [ended({ sprint: 'one', slice: 'B1' })] }))).toEqual([wave2])
    // A pending slice in the wave → not handed back yet.
    expect(waves(pushed({}, [PUSHED[0]!, PUSHED[1]!, [2, 'B2', '—', 'pending']]))).toEqual([])
    // A running slice engineer → not waiting.
    expect(waves(pushed({ agents: [running({ sprint: 'one', slice: 'B2' })] }))).toEqual([])
    // A running wave-fix engineer → not waiting; another wave's fix doesn't count.
    expect(waves(pushed({ agents: [running({ branch: 'one-w2-fix' })] }))).toEqual([])
    expect(waves(pushed({ agents: [running({ branch: 'one-w1-fix' })] }))).toEqual([wave2])
    // A running engineer of another wave's slice doesn't hold this one.
    expect(waves(pushed({ agents: [running({ sprint: 'one', slice: 'A1' })] }))).toEqual([wave2])
    // A done slice beside the pushed ones doesn't stop it.
    expect(waves(pushed({}, [[1, 'A1', '—', 'done'], [1, 'A2', link(4), 'pushed']]))).toEqual([{ ...wave2, number: 4, wave: 1 }])
  })

  it('wave PR follows gh state', () => {
    expect(waves(pushed({ prs: [gh(7, 'merged')] }))).toEqual([])
    expect(waves(pushed({ prs: [gh(7, 'closed')] }))).toEqual([])
    // gh unknown (not on prs) counts as open; gh open adds its url.
    expect(waves(pushed())).toEqual([{ kind: 'wave', number: 7, run: 'alpha', sprint: 'one', wave: 2 }])
    expect(waves(pushed({ prs: [gh(7, 'open')] }))).toEqual([{ kind: 'wave', number: 7, url: 'https://github.com/o/r/pull/7', run: 'alpha', sprint: 'one', wave: 2 }])
  })

  it('wave PR edges', () => {
    // Blocked: a blocked slice in the wave.
    expect(waves(pushed({}, [[1, 'A1', link(7), 'pushed'], [1, 'A2', '—', 'blocked']]))).toEqual([])
    // Done: every slice done, even with an open-looking PR cell.
    expect(waves(pushed({}, [[1, 'A1', link(7), 'done']]))).toEqual([])
    // No PR number on any unfinished slice → nothing to merge.
    expect(waves(pushed({}, [[1, 'A1', '—', 'pushed']]))).toEqual([])
    // One numbered slice is enough; the first numbered open PR is used, once per wave.
    expect(waves(pushed({}, [[1, 'A1', '—', 'pushed'], [1, 'A2', link(8), 'pushed'], [1, 'A3', link(9), 'pushed']]))).toEqual([
      { kind: 'wave', number: 8, run: 'alpha', sprint: 'one', wave: 1 },
    ])
    // Two handed-back waves → one entry each, in wave order.
    expect(waves(pushed({}, [[1, 'A1', link(4), 'pushed'], [2, 'B1', link(7), 'pushed']])).map((w) => [w.wave, w.number])).toEqual([
      [1, 4],
      [2, 7],
    ])
    // A sprint that isn't current: its pushed wave gives nothing.
    const notCurrent = repo(
      files({ sprints: [['one', 'done'], ['two', 'active']], docs: { one: [[1, 'A1', link(7), 'pushed']], two: [[1, 'C1', '—', 'pending']] } }),
    )
    expect(waves(notCurrent)).toEqual([])
  })

  it('only listed runs', () => {
    // An archived plan with no claim is off the runs list: neither its pending hand-back nor a pushed wave waits.
    const archived = files({ status: 'archived', docs: { one: PUSHED }, queue: [handBack(12)] })
    expect(waitingPrs(repo(archived), NOW)).toEqual([])
    // A claim lists it again (closing out), so its hand-back waits.
    expect(waitingPrs(repo(archived, { claims: [claim('alpha')] }), NOW).map((w) => w.kind)).toContain('final')
    // Once gh says it merged, the run stays listed (pod waits for continue) but the final PR no longer waits.
    const closedOut = files({ status: 'archived', sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] }, queue: [handBack(12)] })
    expect(waitingPrs(repo(closedOut, { claims: [claim('alpha')], prs: [gh(12, 'open')] }), NOW).map((w) => w.kind)).toEqual(['final'])
    expect(waitingPrs(repo(closedOut, { claims: [claim('alpha')], prs: [gh(12, 'merged')] }), NOW)).toEqual([])
    // A repo with an error or unsupported docs lists no runs.
    expect(waitingPrs(pushed({ error: 'folder not found' }), NOW)).toEqual([])
    expect(waitingPrs(repo({ 'pod-docs/README.md': 'pod docs: 1\n' }), NOW)).toEqual([])
    // A fix claim that is gone lists no fix run, so its PR doesn't wait.
    const name = 'fix-scroll'
    const agents = [ended({ branch: name, lastAt: NOW - 60 * MIN }), ended({ type: 'pod:reviewer', kind: 'fix', branch: name })]
    expect(waitingPrs(repo({ 'pod-docs/README.md': README }, { agents, prs: [gh(36, 'open', { branch: name })] }), NOW)).toEqual([])
  })

  describe('the staging → main PR', () => {
    // Plan alpha is done and claimed; its final PR #80 merged into pod-staging an hour ago.
    const doneFiles = files({ sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] } })
    const final = gh(80, 'merged', { branch: 'alpha', base: 'pod-staging', mergedAt: NOW - 60 * MIN })
    const staging = (state: PrStatus['state'], over: Partial<PrStatus> = {}) => gh(91, state, { branch: 'pod-staging', base: 'main', ...over })
    const listed = (prs: PrStatus[], extra: Partial<BoardRepo> = {}) => waitingPrs(repo(doneFiles, { claims: [claim('alpha')], prs, ...extra }), NOW)

    it('waits on you while it is open, once the final PR merged', () => {
      expect(listed([final, staging('open')])).toEqual<WaitingPr[]>([{ kind: 'staging', number: 91, url: 'https://github.com/o/r/pull/91', run: 'alpha' }])
      // pod reuses an open staging PR an earlier plan left, so its number can be below the final PR's.
      expect(listed([final, gh(13, 'open', { branch: 'pod-staging', base: 'main' })]).map((w) => [w.kind, w.number])).toEqual([['staging', 13]])
    })

    it("comes after the plan's final PR, which waits first", () => {
      // A pending hand-back whose PR gh says is open: the final PR waits, and staging isn't open for this plan yet.
      const handed = files({ sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] }, queue: [handBack(80)] })
      expect(waitingPrs(repo(handed, { claims: [claim('alpha')], prs: [gh(80, 'open', { branch: 'alpha', base: 'pod-staging' }), staging('open')] }), NOW)).toEqual([
        { kind: 'final', number: 80, url: 'https://github.com/o/r/pull/80', run: 'alpha' },
      ])
      // Once the hand-back's PR merged, the staging PR waits instead.
      expect(waitingPrs(repo(handed, { claims: [claim('alpha')], prs: [final, staging('open')] }), NOW).map((w) => [w.kind, w.number])).toEqual([['staging', 91]])
    })

    it('does not wait when it is closed, merged, or not open yet', () => {
      expect(listed([final, staging('closed')])).toEqual([])
      expect(listed([final, staging('merged', { mergedAt: NOW - 5 * MIN })])).toEqual([])
      expect(listed([final, staging('merged')])).toEqual([])
      expect(listed([final])).toEqual([])
    })

    it('does not wait before the final PR merges, or with no staging branch', () => {
      expect(listed([gh(80, 'open', { branch: 'alpha', base: 'pod-staging' }), staging('open')])).toEqual([])
      expect(listed([gh(80, 'closed', { branch: 'alpha', base: 'pod-staging' }), staging('open')])).toEqual([])
      // A final PR into main: no staging step, so an open pod-staging PR isn't this plan's.
      expect(listed([gh(80, 'merged', { branch: 'alpha', base: 'main' }), staging('open')])).toEqual([])
    })

    it('only for a listed run', () => {
      // Unclaimed, the finished plan is off the runs list.
      expect(listed([final, staging('open')], { claims: [] })).toEqual([])
    })
  })

  it('is exported from the package entry', () => {
    expect(model.waitingPrs).toBe(waitingPrs)
  })
})
