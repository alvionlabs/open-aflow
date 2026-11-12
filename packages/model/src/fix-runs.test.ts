import { describe, expect, it } from 'vitest'
import type { AgentRun, Board, BoardRepo, Claim, PrStatus } from './board.ts'
import { buildFixPipeline, fixRunAgents, fixRunNames, oneOffKind, otherActivity, OTHER_CAP, OTHER_WINDOW_MS } from './fix-runs.ts'
import { isPlanAgent, roleOf } from './pipeline.ts'
import { replySession, runReplies } from './replies.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'
import { activeRuns, listRuns } from './runs.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.
// Agents carry only the fields readDispatch reads from real /pod:fix dispatches (made-up values).

const NOW = Date.UTC(2026, 9, 20, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

const NO_PLANS: RepoFiles = { 'pod-docs/README.md': README }

function planDoc(slug: string, sprints: [string, string][]): string {
  return [
    `# Plan: ${slug}`,
    '',
    '_Generated: 2026-10-20 · Status: active · Grilled-with: grilling_',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, status]) => `| ${s} | goal | ${status} | — |`),
    '',
  ].join('\n')
}

const withPlan = (slug: string): RepoFiles => ({ ...NO_PLANS, [`pod-docs/plans/${slug}.md`]: planDoc(slug, [['one', 'planned']]) })

const claim = (plan: string, portBase = 3100): Claim => ({ portBase, repoPath: '/r/web', plan })

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', tokens: 0, ended: false, ...over }
}

/** Started `from` minutes ago, last wrote `to` minutes ago. */
const span = (from: number, to: number) => ({ startedAt: NOW - from * MIN, lastAt: NOW - to * MIN })
const engineer = (branch: string, from: number, to: number, over: Partial<AgentRun> = {}) => agent({ branch, ...span(from, to), ...over })
const reviewer = (from: number, to: number, over: Partial<AgentRun> = {}) =>
  agent({ type: 'pod:reviewer', kind: 'fix', branch: 'fix-scroll', ...span(from, to), ...over })

const pr = (number: number, state: PrStatus['state'], branch = 'fix-scroll'): PrStatus => ({ number, state, checks: 'none', checkedAt: NOW, branch })
/** A PR that merged `ago` minutes ago. */
const mergedPr = (number: number, ago: number): PrStatus => ({ ...pr(number, 'merged'), mergedAt: NOW - ago * MIN })

function repo(extra: Partial<BoardRepo> = {}, files: RepoFiles = NO_PLANS): BoardRepo {
  return { id: 'id-web', name: 'web', path: '/r/web', source: 'claim', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}

const board = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos })
const rows = (r: BoardRepo) => listRuns(board(r), NOW).map((x) => [x.plan, x.fix, x.where, x.state])

describe('fix runs on the runs list', () => {
  it('a claim fix-<slug> that names no plan is a fix run with its port base', () => {
    const r = repo({ claims: [claim('fix-scroll', 3100)], agents: [engineer('fix-scroll', 10, 1)] })
    expect(listRuns(board(r), NOW)).toEqual([
      { repoId: 'id-web', repo: 'web', plan: 'fix-scroll', fix: 'scroll', where: 'build', state: 'running', portBase: 3100 },
    ])
  })

  it('a fix claim with no agent yet reads build · idle (the claim comes before the dispatch)', () => {
    expect(rows(repo({ claims: [claim('fix-scroll')] }))).toEqual([['fix-scroll', 'scroll', 'build', 'idle']])
  })

  it('a claim whose name matches a plan keeps the plan behaviour', () => {
    const r = repo({ claims: [claim('fix-thing')] }, withPlan('fix-thing'))
    const runs = listRuns(board(r), NOW)
    expect(runs.map((x) => [x.plan, x.fix, x.where])).toEqual([['fix-thing', undefined, 'one · not drafted']])
  })

  it('a claim not named fix-… that names no plan is not a run', () => {
    expect(rows(repo({ claims: [claim('somename')] }))).toEqual([[undefined, undefined, 'no active plan', 'idle']])
  })

  it('an engineer on a fix branch with no claim is not a run, and the count stays 0', () => {
    const r = repo({ agents: [engineer('fix-scroll', 10, 1)] })
    const runs = listRuns(board(r), NOW)
    expect(runs.map((x) => [x.plan, x.where, x.state])).toEqual([[undefined, 'no active plan', 'idle']])
    expect(activeRuns(runs)).toBe(0)
  })

  it('fix runs sit beside plan runs, the repo row gives way, and they count as active', () => {
    const files = withPlan('alpha')
    const r = repo({ claims: [claim('fix-a', 3200), claim('fix-b', 3300)], agents: [engineer('fix-a', 5, 1), engineer('fix-b', 5, 1)] }, files)
    const runs = listRuns(board(r), NOW)
    expect(runs.map((x) => [x.plan, x.state])).toEqual([
      ['fix-a', 'running'],
      ['fix-b', 'running'],
      ['alpha', 'idle'],
    ])
    expect(activeRuns(runs)).toBe(2)
    expect(rows(repo({ claims: [claim('fix-a')] }))).toEqual([['fix-a', 'a', 'build', 'idle']])
  })

  it('the same fix name claimed twice is one run', () => {
    expect(rows(repo({ claims: [claim('fix-scroll', 3100), claim('fix-scroll', 3200)] }))).toEqual([['fix-scroll', 'scroll', 'build', 'idle']])
  })

  it('where follows the newest running agent: build → review → fix pass → review round 2', () => {
    const build = engineer('fix-scroll', 60, 1)
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: [build] }))[0]?.[2]).toBe('build')
    const ended = { ...build, ...span(60, 40), ended: true }
    const r1 = reviewer(39, 1)
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: [ended, r1] }))[0]?.[2]).toBe('review')
    const r1done = { ...r1, ...span(39, 30), ended: true }
    const pass = engineer('fix-scroll', 29, 1)
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: [ended, r1done, pass] }))[0]?.[2]).toBe('fix pass')
    const passDone = { ...pass, ...span(29, 20), ended: true }
    // Round 2 by its round field, and by order after a fix pass when the field is missing.
    const r2 = reviewer(19, 1, { round: 2 })
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: [ended, r1done, passDone, r2] }))[0]?.[2]).toBe('review round 2')
    const r2NoField = reviewer(19, 1)
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: [ended, r1done, passDone, r2NoField] }))[0]?.[2]).toBe('review round 2')
  })

  it('a PR open with nothing running needs you; a running reviewer keeps it running', () => {
    const done = [engineer('fix-scroll', 60, 40, { ended: true }), reviewer(39, 30, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: done, prs: [pr(36, 'open')] }))).toEqual([['fix-scroll', 'scroll', 'PR', 'needs-you']])
    const reviewing = [done[0]!, reviewer(39, 1)]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents: reviewing, prs: [pr(36, 'open')] }))).toEqual([['fix-scroll', 'scroll', 'review', 'running']])
  })

  it('nothing running and no PR: the last step reached, idle', () => {
    const agents = [engineer('fix-scroll', 60, 40, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents }))).toEqual([['fix-scroll', 'scroll', 'build', 'idle']])
  })

  it('the reviewer wrote at 3:17 PM and the human merged at 4:00 PM: the run stays, with Continue', () => {
    // 43 minutes between the last write and the merge; the board reads it one minute later.
    const agents = [engineer('fix-scroll', 120, 90, { ended: true, session: 's1' }), reviewer(80, 44, { ended: true, session: 's1' })]
    const r = repo({ claims: [claim('fix-scroll')], agents, prs: [mergedPr(36, 1)] })
    expect(rows(r)).toEqual([['fix-scroll', 'scroll', 'PR', 'idle']])
    expect(runReplies(r, 'fix-scroll', NOW).map((x) => x.key)).toEqual(['fix-merged:36'])
  })

  describe('a merged PR: the claim stays listed until cleanup frees it', () => {
    const old = [engineer('fix-scroll', 300, 240, { ended: true })]
    const listed = [['fix-scroll', 'scroll', 'PR', 'idle']]
    const at = (mergedAt: number | undefined, agents: AgentRun[] = old) =>
      rows(repo({ claims: [claim('fix-scroll')], agents, prs: [{ ...pr(36, 'merged'), ...(mergedAt === undefined ? {} : { mergedAt }) }] }))

    it('however long ago the merge was', () => {
      for (const ago of [0, 30 * MIN - 1, 30 * MIN, 45 * MIN, 3 * 24 * 60 * MIN]) expect(at(NOW - ago), String(ago)).toEqual(listed)
    })

    it('a merge time ahead of the clock changes nothing', () => {
      expect(at(NOW + 5 * MIN)).toEqual(listed)
    })

    it('with no agent, and with no merge time', () => {
      expect(at(NOW - 45 * MIN, [])).toEqual(listed)
      expect(at(undefined)).toEqual(listed)
      expect(at(undefined, [])).toEqual(listed)
    })

    it('freeing the claim ends it', () => {
      expect(rows(repo({ agents: old, prs: [mergedPr(36, 45)] }))).toEqual([[undefined, undefined, 'no active plan', 'idle']])
    })

    it('with its session past the transcript window: its steps read as run, and only Copy is left', () => {
      const r = repo({ claims: [claim('fix-scroll')], prs: [mergedPr(36, 40 * 24 * 60)] })
      const steps = buildFixPipeline(r, 'fix-scroll', NOW)!.stages.flatMap((s) => s.steps)
      expect(steps.find((s) => s.key === 'engineer')).toMatchObject({ state: 'done', detail: 'no transcript' })
      expect(steps.find((s) => s.key === 'round-1')).toMatchObject({ state: 'done', detail: 'no transcript' })
      expect(steps.map((s) => s.detail)).not.toContain('not started')
      expect(steps.find((s) => s.key === 'pr')).toMatchObject({ state: 'done', detail: 'PR #36 · merged' })
      // Pod still waits for the word, so the card offers it to copy. With no session, nothing can send it.
      expect(runReplies(r, 'fix-scroll', NOW).map((x) => x.key)).toEqual(['fix-merged:36'])
      expect(replySession(r, 'fix-scroll', NOW)).toBeUndefined()
    })

    it('a step with an agent keeps its own figures, and an open PR still reads not started', () => {
      const r = repo({ claims: [claim('fix-scroll')], agents: [engineer('fix-scroll', 60, 40, { ended: true })], prs: [mergedPr(36, 5)] })
      const steps = buildFixPipeline(r, 'fix-scroll', NOW)!.stages.flatMap((s) => s.steps)
      expect(steps.find((s) => s.key === 'engineer')?.detail).not.toBe('no transcript')
      const open = repo({ claims: [claim('fix-scroll')], prs: [pr(36, 'open')] })
      expect(buildFixPipeline(open, 'fix-scroll', NOW)!.stages[0]!.steps[0]).toMatchObject({ state: 'wait', detail: 'not started' })
    })

    it('a run with an agent on the Board never reads a step as run with no transcript', () => {
      const steps = (agents: AgentRun[]) => buildFixPipeline(repo({ claims: [claim('fix-scroll')], agents, prs: [mergedPr(36, 5)] }), 'fix-scroll', NOW)!.stages.flatMap((s) => s.steps)
      const round1 = (agents: AgentRun[]) => steps(agents).find((s) => s.key === 'round-1')
      const waiting = { state: 'wait', detail: 'not started' }
      // fix-live: its engineer is running.
      expect(round1([engineer('fix-scroll', 10, 1)])).toMatchObject(waiting)
      // fix-noreview: its engineer ended 10 minutes ago, with no reviewer.
      expect(round1([engineer('fix-scroll', 60, 10, { ended: true })])).toMatchObject(waiting)
      // A reviewer with no engineer on the Board leaves the engineer not started too.
      expect(steps([reviewer(30, 10, { ended: true })]).find((s) => s.key === 'engineer')).toMatchObject(waiting)
    })

    it('an old merge still offers Continue', () => {
      const r = repo({ claims: [claim('fix-scroll')], agents: old, prs: [mergedPr(36, 3 * 24 * 60)] })
      expect(runReplies(r, 'fix-scroll', NOW).map((x) => x.key)).toEqual(['fix-merged:36'])
    })

    it('its agents stay out of Other activity while its claim exists, and join it once the claim goes', () => {
      const late = [reviewer(80, 44, { ended: true })]
      const others = (claims: Claim[]) => otherActivity(repo({ claims, agents: late, prs: [mergedPr(36, 45)] }), NOW).map((a) => a.role)
      expect(others([claim('fix-scroll')])).toEqual([])
      expect(others([])).toEqual(['reviewer'])
    })
  })

  it('an open or closed PR keeps the claim listed however old its agents are', () => {
    const agents = [engineer('fix-scroll', 600, 500, { ended: true }), reviewer(499, 450, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))[0]?.slice(2)).toEqual(['PR', 'needs-you'])
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'closed')] }))[0]?.slice(2)).toEqual(['PR', 'idle'])
  })

  it('an open PR waits for its review: an ended engineer with no reviewer reads review · idle, not needs you', () => {
    const agents = [engineer('fix-scroll', 60, 40, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))).toEqual([['fix-scroll', 'scroll', 'review', 'idle']])
  })

  it('an open PR after an ended fix pass with no round 2 yet reads review · idle', () => {
    const agents = [engineer('fix-scroll', 60, 50, { ended: true }), reviewer(49, 45, { ended: true }), engineer('fix-scroll', 44, 35, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))).toEqual([['fix-scroll', 'scroll', 'review', 'idle']])
  })

  it('an engineer continued for the fix pass (same transcript) that wrote after the review ended un-reviews the PR', () => {
    // One engineer, started before the review, wrote again after it: the review no longer covers the PR.
    const agents = [engineer('fix-scroll', 120, 5, { ended: true }), reviewer(90, 60, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))[0]?.slice(3)).toEqual(['idle'])
    expect(buildFixPipeline(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }), 'fix-scroll', NOW)?.stages[2]?.steps[0]?.detail).toBe('PR #36 · after review')
  })

  it('a newest reviewer that went quiet without ending is no finished review', () => {
    const agents = [engineer('fix-scroll', 120, 100, { ended: true }), reviewer(99, 60)]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))[0]?.slice(2)).toEqual(['review', 'idle'])
  })

  it('a PR found for another branch is not this run’s', () => {
    const agents = [engineer('fix-scroll', 60, 40, { ended: true })]
    expect(rows(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open', 'fix-other')] }))[0]?.slice(2)).toEqual(['build', 'idle'])
  })
})

describe('which agents a fix run has', () => {
  const stepsOf = (r: BoardRepo) => buildFixPipeline(r, 'fix-scroll', NOW)?.log.map((x) => [x.role, x.round])

  it('engineers by branch; reviewers by kind fix plus branch or PR number', () => {
    const agents = [
      engineer('fix-scroll', 60, 40, { ended: true }),
      reviewer(39, 30, { ended: true, branch: undefined, pr: 36 }),
      engineer('fix-other', 50, 1),
      reviewer(20, 1, { kind: 'plan' }),
      reviewer(20, 1, { kind: undefined }),
      reviewer(20, 1, { branch: 'fix-other' }),
      reviewer(20, 1, { branch: undefined, pr: 99 }),
    ]
    expect(stepsOf(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))).toEqual([
      ['engineer', undefined],
      ['reviewer', 1],
    ])
  })

  it('a second engineer before any review is still the build; after a review it is the fix pass', () => {
    const redo = [engineer('fix-scroll', 60, 50, { ended: true }), engineer('fix-scroll', 49, 40, { ended: true })]
    expect(stepsOf(repo({ claims: [claim('fix-scroll')], agents: redo }))).toEqual([
      ['engineer', undefined],
      ['engineer', undefined],
    ])
    const pass = [engineer('fix-scroll', 60, 50, { ended: true }), reviewer(49, 45, { ended: true }), engineer('fix-scroll', 44, 1)]
    expect(stepsOf(repo({ claims: [claim('fix-scroll')], agents: pass }))).toEqual([
      ['engineer', undefined],
      ['reviewer', 1],
      ['fix pass', undefined],
    ])
  })

  it('a reviewer re-dispatched before any fix pass is still round 1', () => {
    const agents = [engineer('fix-scroll', 60, 50, { ended: true }), reviewer(49, 45, { ended: true }), reviewer(44, 1)]
    expect(stepsOf(repo({ claims: [claim('fix-scroll')], agents }))).toEqual([
      ['engineer', undefined],
      ['reviewer', 1],
      ['reviewer', 1],
    ])
  })

  it('a fix reviewer is never a plan’s review round, even with a plan field', () => {
    const files = withPlan('alpha')
    const plan = buildRepoModel(files).plans[0]!
    expect(roleOf(reviewer(10, 1, { plan: 'alpha' }), plan)).toEqual({ kind: 'other' })
    expect(roleOf(reviewer(10, 1, { plan: 'alpha', kind: 'plan' }), plan)).toEqual({ kind: 'review' })
    expect(roleOf(reviewer(10, 1, { plan: 'alpha', kind: undefined }), plan)).toEqual({ kind: 'review' })
  })

  it('fixRunNames: claims named fix-… that match no plan, once each, in claim order', () => {
    const r = repo({ claims: [claim('fix-b', 3100), claim('alpha', 3200), claim('fix-a', 3300), claim('fix-b', 3400), claim('fix-alpha', 3500)] }, withPlan('fix-alpha'))
    expect(fixRunNames(r)).toEqual(['fix-b', 'fix-a'])
  })
})

describe('buildFixPipeline', () => {
  const stages = (r: BoardRepo, name = 'fix-scroll') =>
    buildFixPipeline(r, name, NOW)?.stages.map((s) => [s.caption, s.steps.map((x) => [x.label, x.state, x.detail])])

  it('a building engineer: Build live, the rest waiting', () => {
    const r = repo({ claims: [claim('fix-scroll')], agents: [engineer('fix-scroll', 10, 1)] })
    expect(stages(r)).toEqual([
      ['Build', [['Engineer', 'live', '10 min so far'], ['Fix pass', 'wait', 'only if review fails']]],
      ['Review', [['Round 1', 'wait', 'not started'], ['Round 2', 'wait', 'only after a fix pass']]],
      ['Ship', [['PR', 'wait', 'not open yet']]],
    ])
  })

  it('the whole flow done with the PR open: every step done, Ship you merge', () => {
    const agents = [
      engineer('fix-scroll', 100, 80, { ended: true, tokens: 1500 }),
      reviewer(79, 70, { ended: true }),
      engineer('fix-scroll', 69, 60, { ended: true }),
      reviewer(59, 50, { ended: true, round: 2 }),
    ]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents, prs: [pr(36, 'open')] }))).toEqual([
      ['Build', [['Engineer', 'done', '20 min · 1.5k tok'], ['Fix pass', 'done', '9 min']]],
      ['Review', [['Round 1', 'done', '9 min'], ['Round 2', 'done', '9 min']]],
      ['Ship', [['PR', 'you', 'PR #36 · you merge']]],
    ])
  })

  it('a review running, then a merged PR, then a closed one', () => {
    const agents = [engineer('fix-scroll', 60, 40, { ended: true }), reviewer(39, 1)]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents }))?.[1]).toEqual(['Review', [['Round 1', 'live', '39 min so far'], ['Round 2', 'wait', 'only after a fix pass']]])
    const ended = [agents[0]!, { ...agents[1]!, ...span(39, 10), ended: true }]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents: ended, prs: [pr(36, 'merged')] }))?.[2]).toEqual(['Ship', [['PR', 'done', 'PR #36 · merged']]])
    expect(stages(repo({ claims: [claim('fix-scroll')], agents: ended, prs: [pr(36, 'closed')] }))?.[2]).toEqual(['Ship', [['PR', 'blocked', 'PR #36 · closed']]])
  })

  it('Ship waits for the review: an open PR reads after review until the newest agent is an ended reviewer', () => {
    const built = [engineer('fix-scroll', 60, 40, { ended: true })]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents: built, prs: [pr(36, 'open')] }))?.[2]).toEqual(['Ship', [['PR', 'wait', 'PR #36 · after review']]])
    const passed = [...built, reviewer(39, 30, { ended: true }), engineer('fix-scroll', 29, 20, { ended: true })]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents: passed, prs: [pr(36, 'open')] }))?.[2]).toEqual(['Ship', [['PR', 'wait', 'PR #36 · after review']]])
    const reviewed = [...built, reviewer(39, 30, { ended: true })]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents: reviewed, prs: [pr(36, 'open')] }))?.[2]).toEqual(['Ship', [['PR', 'you', 'PR #36 · you merge']]])
  })

  it('fix Ship step carries merge', () => {
    const ship = (agents: AgentRun[], prs: PrStatus[]) => buildFixPipeline(repo({ claims: [claim('fix-scroll')], agents, prs }), 'fix-scroll', NOW)?.stages.at(-1)?.steps[0]
    const others = (agents: AgentRun[], prs: PrStatus[]) =>
      buildFixPipeline(repo({ claims: [claim('fix-scroll')], agents, prs }), 'fix-scroll', NOW)
        ?.stages.slice(0, -1)
        .flatMap((s) => s.steps)
        .filter((s) => 'merge' in s)
    const built = [engineer('fix-scroll', 60, 40, { ended: true })]
    const reviewed = [...built, reviewer(39, 30, { ended: true })]
    // Open and reviewed: you merge, with merge set.
    expect(ship(reviewed, [pr(36, 'open')])).toEqual({ key: 'pr', label: 'PR', state: 'you', detail: 'PR #36 · you merge', merge: { number: 36 } })
    expect(others(reviewed, [pr(36, 'open')])).toEqual([])
    // Before the review, merged, closed, or no PR: no merge.
    expect(ship(built, [pr(36, 'open')])).not.toHaveProperty('merge')
    expect(ship(reviewed, [pr(36, 'merged')])).not.toHaveProperty('merge')
    expect(ship(reviewed, [pr(36, 'closed')])).not.toHaveProperty('merge')
    expect(ship(reviewed, [])).not.toHaveProperty('merge')
  })

  it('two build engineers show their count', () => {
    // 60→50 and 49→40 minutes ago: the 1-minute gap between them is under the idle gap, so it counts (20 min).
    const agents = [engineer('fix-scroll', 60, 50, { ended: true }), engineer('fix-scroll', 49, 40, { ended: true })]
    expect(stages(repo({ claims: [claim('fix-scroll')], agents }))?.[0]?.[1]).toEqual([
      ['Engineer', 'done', '2 engineers · 20 min'],
      ['Fix pass', 'wait', 'only if review fails'],
    ])
  })

  it('the agent log: role, round, start, end, state, oldest first; the engineer view can open each engineer', () => {
    const e = engineer('fix-scroll', 60, 40, { ended: true })
    const rv = reviewer(39, 1)
    const log = buildFixPipeline(repo({ claims: [claim('fix-scroll')], agents: [rv, e] }), 'fix-scroll', NOW)?.log
    expect(log).toEqual([
      { agentId: e.id, role: 'engineer', startedAt: NOW - 60 * MIN, endedAt: NOW - 40 * MIN, state: 'ended', engineer: true },
      { agentId: rv.id, role: 'reviewer', round: 1, startedAt: NOW - 39 * MIN, state: 'running', engineer: false },
    ])
  })

  it('a stale agent shows its last write as its end', () => {
    const e = engineer('fix-scroll', 120, 60)
    expect(buildFixPipeline(repo({ claims: [claim('fix-scroll')], agents: [e] }), 'fix-scroll', NOW)?.log[0]).toMatchObject({ state: 'stale', endedAt: NOW - 60 * MIN })
  })

  it('the slug, and undefined for a name that is no fix run', () => {
    const r = repo({ claims: [claim('fix-scroll')] }, withPlan('fix-plan'))
    expect(buildFixPipeline(r, 'fix-scroll', NOW)?.slug).toBe('scroll')
    expect(buildFixPipeline(r, 'fix-nope', NOW)).toBeUndefined()
    expect(buildFixPipeline(repo({ claims: [claim('fix-plan')] }, withPlan('fix-plan')), 'fix-plan', NOW)).toBeUndefined()
  })
})

describe('otherActivity', () => {
  const of = (r: BoardRepo) => otherActivity(r, NOW).map((x) => [x.role, x.detail, x.state])

  it('agents tied to no run: researcher, scout, a planner with no plan, stray engineers and reviewers', () => {
    const agents = [
      agent({ type: 'pod:researcher', ...span(50, 40), ended: true }),
      agent({ type: 'pod:scout', ...span(30, 20), ended: true }),
      agent({ type: 'pod:sprint-planner', ...span(15, 10), ended: true }),
      engineer('fix-old', 9, 8, { ended: true }),
      agent({ type: 'pod:reviewer', kind: 'fix', ...span(5, 1) }),
    ]
    expect(of(repo({ agents }))).toEqual([
      ['reviewer', undefined, 'running'],
      ['engineer', 'fix-old', 'ended'],
      ['sprint-planner', undefined, 'ended'],
      ['scout', undefined, 'ended'],
      ['researcher', undefined, 'ended'],
    ])
  })

  it('leaves out agents of any plan in the repo and of a fix run', () => {
    const agents = [
      engineer('one-A1', 10, 1, { sprint: 'one', slice: 'A1' }),
      agent({ type: 'pod:reporter', plan: 'alpha', ...span(10, 1) }),
      engineer('fix-scroll', 10, 1),
      reviewer(5, 1),
      agent({ type: 'pod:researcher', ...span(5, 1) }),
    ]
    expect(of(repo({ agents, claims: [claim('fix-scroll')] }, withPlan('alpha')))).toEqual([['researcher', undefined, 'running']])
  })

  it('a fix run’s agents with its claim gone are other activity, with their branch', () => {
    expect(of(repo({ agents: [engineer('fix-scroll', 10, 2, { ended: true })] }))).toEqual([['engineer', 'fix-scroll', 'ended']])
  })

  it(`only the last ${OTHER_WINDOW_MS / 3_600_000} hours, newest ${OTHER_CAP} at most`, () => {
    const old = agent({ type: 'pod:researcher', startedAt: NOW - OTHER_WINDOW_MS - 10 * MIN, lastAt: NOW - OTHER_WINDOW_MS - MIN, ended: true })
    const edge = agent({ type: 'pod:scout', startedAt: NOW - OTHER_WINDOW_MS - 10 * MIN, lastAt: NOW - OTHER_WINDOW_MS + MIN, ended: true })
    const noTime = agent({ type: 'pod:scout' })
    expect(of(repo({ agents: [old, edge, noTime] }))).toEqual([['scout', undefined, 'ended']])
    const many = Array.from({ length: OTHER_CAP + 3 }, (_, i) => agent({ type: 'pod:researcher', ...span(100, i + 1), ended: true }))
    const out = otherActivity(repo({ agents: many }), NOW)
    expect(out).toHaveLength(OTHER_CAP)
    expect(out.map((x) => x.id)).toEqual(many.slice(0, OTHER_CAP).map((x) => x.id))
  })

  it('the detail is a dispatch field only: branch, else plan, else sprint', () => {
    const agents = [
      agent({ type: 'pod:sprint-planner', plan: 'gone-plan', ...span(5, 3), ended: true }),
      agent({ type: 'pod:engineer', sprint: 'gone-sprint', ...span(5, 2), ended: true }),
    ]
    expect(of(repo({ agents }))).toEqual([
      ['engineer', 'gone-sprint', 'ended'],
      ['sprint-planner', 'gone-plan', 'ended'],
    ])
  })

  it('carries no description or other text', () => {
    const a = agent({ type: 'pod:researcher', description: 'PLANTED_FAKE_SECRET', ...span(5, 1) })
    const out = otherActivity(repo({ agents: [a] }), NOW)
    expect(JSON.stringify(out)).not.toContain('PLANTED_FAKE_SECRET')
    expect(Object.keys(out[0]!).sort()).toEqual(['id', 'lastAt', 'role', 'startedAt', 'state'])
  })

  it('adds nothing to the runs or the count', () => {
    const r = repo({ agents: [agent({ type: 'pod:researcher', ...span(5, 1) })] })
    const runs = listRuns(board(r), NOW)
    expect(runs.map((x) => [x.where, x.state])).toEqual([['no active plan', 'idle']])
    expect(activeRuns(runs)).toBe(0)
  })
})

describe('fixRunAgents', () => {
  it('fix run agents', () => {
    const eng = engineer('fix-scroll', 90, 60)
    const rev1 = reviewer(55, 50, { ended: true })
    // An engineer continued for the fix pass: two turns, one agent.
    const cont = engineer('fix-scroll', 120, 20, {
      turns: [
        { startedAt: NOW - 120 * MIN, endedAt: NOW - 100 * MIN, lastAt: NOW - 100 * MIN, tokens: 1 },
        { startedAt: NOW - 30 * MIN, lastAt: NOW - 20 * MIN, tokens: 1 },
      ],
      resumedAt: NOW - 30 * MIN,
    })
    // A reviewer joined by the PR number, not the branch.
    const byPr = reviewer(15, 10, { branch: 'other', pr: 36 })
    const strays = [
      engineer('fix-other', 10, 1),
      reviewer(10, 1, { kind: 'plan' }),
      agent({ type: 'pod:researcher', branch: 'fix-scroll', ...span(10, 1) }),
    ]
    const r = repo({ claims: [claim('fix-scroll')], agents: [byPr, rev1, ...strays, eng, cont], prs: [pr(36, 'open')] })
    const ids = fixRunAgents(r, 'fix-scroll', NOW).map((a) => a.id)
    // The run's engineers and reviewers, once each, oldest first.
    expect(ids).toEqual([cont.id, eng.id, rev1.id, byPr.id])
    // The same agents the pipeline's agent log is built from.
    const log = buildFixPipeline(r, 'fix-scroll', NOW)!.log.map((x) => x.agentId)
    expect(new Set(ids)).toEqual(new Set(log))
    // Each is the agent itself, not one of its turns.
    expect(fixRunAgents(r, 'fix-scroll', NOW)[0]).toBe(cont)
    // No such run → none.
    expect(fixRunAgents(r, 'fix-nope', NOW)).toEqual([])
  })
})

// pod 0.10.0 renamed /pod:fix to /pod:task: the claim, branch, and worktree are `task-<slug>`, and the
// reviewer gets `kind: task`. Both forms are one-off runs; `fix-` stays for older pod versions.
describe('task runs (/pod:task)', () => {
  const T = 'task-scroll'
  const taskEngineer = (from: number, to: number, over: Partial<AgentRun> = {}) => engineer(T, from, to, over)
  const taskReviewer = (from: number, to: number, over: Partial<AgentRun> = {}) => reviewer(from, to, { kind: 'task', branch: T, ...over })
  const taskPr = (number: number, state: PrStatus['state']) => pr(number, state, T)

  it('a claim task-<slug> with its engineer and kind task reviewer is a run with the right agents, flow, and state', () => {
    const agents = [taskEngineer(60, 40, { ended: true }), taskReviewer(39, 30, { ended: true })]
    const r = repo({ claims: [claim(T, 3100)], agents, prs: [taskPr(36, 'open')] })
    expect(listRuns(board(r), NOW)).toEqual([{ repoId: 'id-web', repo: 'web', plan: T, fix: 'scroll', where: 'PR', state: 'needs-you', portBase: 3100 }])
    const p = buildFixPipeline(r, T, NOW)!
    expect(p.slug).toBe('scroll')
    expect(p.log.map((x) => [x.role, x.round])).toEqual([
      ['engineer', undefined],
      ['reviewer', 1],
    ])
    expect(p.stages.map((s) => [s.caption, s.steps.map((x) => [x.label, x.state, x.detail])])).toEqual([
      ['Build', [['Engineer', 'done', '20 min'], ['Fix pass', 'wait', 'only if review fails']]],
      ['Review', [['Round 1', 'done', '9 min'], ['Round 2', 'wait', 'only after a fix pass']]],
      ['Ship', [['PR', 'you', 'PR #36 · you merge']]],
    ])
    expect(p.stages[2]!.steps[0]!.merge).toEqual({ number: 36 })
  })

  it('the run is tagged task; a fix run stays tagged fix', () => {
    expect(oneOffKind(T)).toBe('task')
    expect(oneOffKind('fix-scroll')).toBe('fix')
    expect(oneOffKind('task-fix-toast')).toBe('task')
    for (const name of ['task-', 'fix-', 'tasks-x', 'alpha', '']) expect(oneOffKind(name)).toBeUndefined()
  })

  it('a kind task reviewer joins by the PR number; other reviewers and engineers stay out', () => {
    const agents = [
      taskEngineer(60, 40, { ended: true }),
      taskReviewer(39, 30, { ended: true, branch: undefined, pr: 36 }),
      engineer('task-other', 50, 1),
      taskReviewer(20, 1, { kind: 'plan' }),
      taskReviewer(20, 1, { branch: 'task-other' }),
    ]
    expect(fixRunAgents(repo({ claims: [claim(T)], agents, prs: [taskPr(36, 'open')] }), T, NOW).map((a) => a.id)).toEqual([agents[0]!.id, agents[1]!.id])
  })

  it('a reviewer of either one-off kind joins either run by its branch', () => {
    const r = repo({ claims: [claim(T), claim('fix-old')], agents: [taskReviewer(10, 1, { kind: 'fix' }), reviewer(10, 1, { kind: 'task', branch: 'fix-old' })] })
    expect(fixRunAgents(r, T, NOW)).toHaveLength(1)
    expect(fixRunAgents(r, 'fix-old', NOW)).toHaveLength(1)
  })

  it('task-<slug> and fix-<slug> claims are two runs; task- alone or a claim named like a plan is none', () => {
    const r = repo({ claims: [claim('fix-a', 3100), claim('task-a', 3200), claim('task-', 3300), claim('task-alpha', 3400)] }, withPlan('task-alpha'))
    expect(fixRunNames(r)).toEqual(['fix-a', 'task-a'])
    expect(rows(r)).toEqual([
      ['fix-a', 'a', 'build', 'idle'],
      ['task-a', 'a', 'build', 'idle'],
      ['task-alpha', undefined, 'one · not drafted', 'idle'],
    ])
  })

  it('a kind task reviewer is never a plan’s review round, even with a plan field', () => {
    const plan = buildRepoModel(withPlan('alpha')).plans[0]!
    expect(roleOf(taskReviewer(10, 1, { plan: 'alpha' }), plan)).toEqual({ kind: 'other' })
  })

  it('a one-off reviewer is never a plan agent, even when its task text gives it the plan field', () => {
    // A task block with `Plan: alpha has the same code.` reads as `plan: alpha`.
    const files = withPlan('alpha')
    const plan = buildRepoModel(files).plans[0]!
    expect(isPlanAgent(taskReviewer(10, 1, { plan: 'alpha' }), plan)).toBe(false)
    expect(isPlanAgent(reviewer(10, 1, { plan: 'alpha' }), plan)).toBe(false)
    expect(isPlanAgent(reviewer(10, 1, { plan: 'alpha', kind: 'plan' }), plan)).toBe(true)
    // The plan's own run stays as it was: not running because of the task reviewer.
    const r = repo({ claims: [claim(T)], agents: [taskEngineer(10, 1), taskReviewer(5, 1, { plan: 'alpha' })] }, files)
    expect(listRuns(board(r), NOW).find((x) => x.plan === 'alpha')?.state).not.toBe('running')
  })

  it('its agents stay out of Other activity while its claim exists', () => {
    const agents = [taskEngineer(10, 1), taskReviewer(5, 1)]
    expect(otherActivity(repo({ agents, claims: [claim(T)] }), NOW)).toEqual([])
    expect(otherActivity(repo({ agents }), NOW).map((x) => x.role).sort()).toEqual(['engineer', 'reviewer'])
  })

  it('a merged task PR gives Send continue, as a merged fix PR does', () => {
    const agents = [taskEngineer(60, 40, { ended: true, session: 'sess-1' }), taskReviewer(39, 30, { ended: true, session: 'sess-1' })]
    const r = repo({ claims: [claim(T)], agents, prs: [{ ...taskPr(36, 'merged'), mergedAt: NOW - MIN }] })
    expect(runReplies(r, T, NOW)).toEqual([{ reply: 'continue', signal: 'fix-merged', why: 'PR #36 merged.', pr: 36, key: 'fix-merged:36' }])
    expect(replySession(r, T, NOW)?.id).toBe('sess-1')
    const open = repo({ claims: [claim(T)], agents, prs: [taskPr(36, 'open')] })
    expect(runReplies(open, T, NOW).map((x) => x.signal)).toEqual(['fix-waiting'])
  })
})
