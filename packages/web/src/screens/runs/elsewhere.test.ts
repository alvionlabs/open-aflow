import { describe, expect, it } from 'vitest'
import { buildRepoModel, listRuns, type Board, type BoardRepo, type Claim, type PrStatus, type RunSummary } from '@openaflow/model'
import { loadFixture } from '../../../../model/test/load-fixture.ts'
import { hashFor } from '../../selection.ts'
import { elsewhere, type Elsewhere } from './elsewhere.ts'
import { nextSteps } from './next-step.ts'

// Boards of several repos, each a copy of the chess-web fixture (plan sparring-ladder) with its own id,
// name and queue, so each run's Next step card is one tier the test picks.

const NOW = Date.UTC(2026, 9, 20, 12)
const PLAN = 'sparring-ladder'
const QUEUE = 'pod-docs/handoff-queue.md'
const LADDER = 'pod-docs/sprints/ladder.md'

type Files = Record<string, string>
type Edit = (files: Files) => void

const entry = (type: string, route: string, fields: string, body: string, date = '2026-10-19') =>
  `- \`[${date} · ${type} · ${route}${fields ? ` · ${fields}` : ''}]\` ${body} **Resolution:** pending`
const own = `plan: ${PLAN}`
const blocked = (date = '2026-10-19', body = 'Gate 1: T1 is blocked, the rates file is missing.') => entry('BLOCKED', 'orchestrator → human', own, body, date)
const pending = (body: string, date = '2026-10-19') => entry('PENDING', 'engineer → human', own, body, date)
/** A PENDING that stops the run: it names open slice T1 and records no default. */
const ask = (body: string, date = '2026-10-19') => entry('PENDING', 'engineer → human', `${own} · sprint: ladder · slice: T1`, body, date)
/** No date: a blank first part in the header. */
const undated = (line: string) => line.replace(/`\[\d{4}-\d{2}-\d{2} · /, '`[ · ')

const onlyQueue = (...lines: string[]): Edit => (f) => {
  f[QUEUE] = ['# Handoff Queue', '', ...lines, ''].join('\n')
}
/** Started with /pod:code, so a stop gets a reply. */
const manual: Edit = (f) => {
  for (const doc of ['pod-docs/plans/sparring-ladder.md', LADDER]) f[doc] = f[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
}
const t1Pushed: Edit = (f) => {
  f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', '| ladder-T1 | #78 | pushed | medium |')
}
const gh = (number: number, state: PrStatus['state']): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW })

function repoOf(id: string, edits: Edit[], extra: Partial<BoardRepo> = {}): BoardRepo {
  const files = loadFixture('chess-web')
  for (const e of edits) e(files)
  return { id, name: `${id}-web`, path: `/${id}`, source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}

// One recipe per card (pinned by the first case).
type Card = 'blocked' | 'merge' | 'reply' | 'now' | 'decision' | 'before' | 'other' | 'someday' | 'nothing'
const RECIPE: Record<Card, (id: string) => BoardRepo> = {
  blocked: (id) => repoOf(id, [onlyQueue(blocked()), manual]),
  merge: (id) => repoOf(id, [onlyQueue(), manual, t1Pushed], { prs: [gh(78, 'open')] }),
  reply: (id) => repoOf(id, [onlyQueue(), manual, t1Pushed], { prs: [gh(78, 'merged')] }),
  now: (id) => repoOf(id, [onlyQueue(ask('now: pick the title line.')), manual]),
  decision: (id) => repoOf(id, [onlyQueue(ask('decision: pick the port.')), manual]),
  before: (id) => repoOf(id, [onlyQueue(ask('before hosting: add TLS.')), manual]),
  other: (id) => repoOf(id, [onlyQueue(pending('Check the npm cache.')), manual]),
  someday: (id) => repoOf(id, [onlyQueue(pending('someday: trim the cache.')), manual]),
  nothing: (id) => repoOf(id, [onlyQueue(), manual]),
}

const boardOf = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos, actions: [] })
/** The repo's plan run, as the sidebar lists it. */
function runOf(repo: BoardRepo, plan = PLAN): RunSummary {
  const r = listRuns(boardOf(repo), NOW).find((x) => x.plan === plan)
  if (!r) throw new Error(`no run ${plan} in ${repo.id}`)
  return r
}
const cardOf = (repo: BoardRepo, run = runOf(repo)) => nextSteps(run, repo, NOW)!.card

/** Repos in sidebar order; the first one's run is selected. */
function pick(...repos: BoardRepo[]): Elsewhere | undefined {
  const runs = repos.map((r) => runOf(r))
  return elsewhere(runs, boardOf(...repos), runs[0], NOW)
}
/** Which repo's run the banner names, or nothing. */
const winner = (...repos: BoardRepo[]) => pick(...repos)?.run.repoId

describe('elsewhere', () => {
  it('recipes give the card each case means', () => {
    const cards = Object.fromEntries(Object.entries(RECIPE).map(([k, make]) => [k, cardOf(make('x'))]))
    expect(Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, c.tier]))).toEqual({
      blocked: 'blocked',
      merge: 'merge',
      reply: 'reply',
      now: 'pending',
      decision: 'pending',
      before: 'pending',
      other: 'pending',
      someday: 'pending',
      nothing: 'nothing',
    })
    for (const k of ['now', 'decision', 'before', 'other', 'someday']) expect(cards[k]!.entry?.kind).toBe(k)
  })

  it('blocked elsewhere outranks a pending decision', () => {
    const x = RECIPE.decision('x')
    const y = RECIPE.blocked('y')
    const runs = [runOf(x), runOf(y)]
    const got = elsewhere(runs, boardOf(x, y), runs[0], NOW)
    expect(got).toEqual<Elsewhere>({
      run: runs[1]!,
      item: cardOf(y),
      name: 'Sparring ladder to Liem',
      repo: 'y-web',
      more: 0,
      href: hashFor(runs[1]!),
    })
    expect(got?.item.tier).toBe('blocked')
    expect(got?.href).toBe('#/y/sparring-ladder')
  })

  it('rank table', () => {
    // High to low; the pending rank stands for each kind that can raise a banner.
    const ranks: Card[][] = [['blocked'], ['merge'], ['reply'], ['now', 'decision', 'before']]
    for (let hi = 0; hi < ranks.length; hi++) {
      for (let lo = 0; lo < ranks.length; lo++) {
        for (const a of ranks[hi]!) {
          for (const b of ranks[lo]!) {
            // The other run shows only when its rank is strictly higher.
            expect(winner(RECIPE[b]('sel'), RECIPE[a]('other')), `${a} elsewhere, ${b} selected`).toBe(hi < lo ? 'other' : undefined)
          }
        }
      }
    }
  })

  it('same tier shows nothing', () => {
    expect(winner(RECIPE.blocked('x'), RECIPE.blocked('y'))).toBeUndefined()
    expect(winner(RECIPE.merge('x'), RECIPE.merge('y'))).toBeUndefined()
    expect(winner(RECIPE.reply('x'), RECIPE.reply('y'))).toBeUndefined()
    expect(winner(RECIPE.decision('x'), RECIPE.now('y'))).toBeUndefined()
    expect(winner(RECIPE.now('x'), RECIPE.decision('y'))).toBeUndefined()
    // One rank up does show.
    expect(winner(RECIPE.merge('x'), RECIPE.blocked('y'))).toBe('y')
  })

  it('nothing to do is outranked by any action', () => {
    for (const card of ['blocked', 'merge', 'reply', 'now', 'decision', 'before'] as const) {
      expect(winner(RECIPE.nothing('x'), RECIPE[card]('y')), card).toBe('y')
    }
    expect(pick(RECIPE.nothing('x'), RECIPE.merge('y'))?.item).toMatchObject({ tier: 'merge', title: 'Merge PR #78' })
  })

  it('an entry pod goes on without never raises a banner, whatever its kind', () => {
    expect(winner(RECIPE.nothing('x'), RECIPE.someday('y'))).toBeUndefined()
    expect(winner(RECIPE.nothing('x'), RECIPE.other('y'))).toBeUndefined()
    for (const body of ['now: pick the title line.', 'decision: pick the port.', 'before hosting: add TLS.', 'decision: pick the port. Value in use: 3000.']) {
      expect(winner(RECIPE.nothing('x'), repoOf('y', [onlyQueue(pending(body)), manual])), body).toBeUndefined()
    }
    // The same run with a stop instead does show, also with no kind word.
    expect(winner(RECIPE.nothing('x'), RECIPE.decision('y'))).toBe('y')
    expect(winner(RECIPE.nothing('x'), repoOf('y', [onlyQueue(ask('Which store?')), manual]))).toBe('y')
    // A selected card pod goes on without ranks as nothing, so a stop elsewhere still outranks it.
    expect(winner(repoOf('x', [onlyQueue(pending('decision: pick the port.')), manual]), RECIPE.now('y'))).toBe('y')
    // An answered decision is info, never the card: with only it (and its reply, as autopilot gives
    // none here), the run's card is Nothing to do and no banner shows.
    const answered = `${pending('decision: pick the port.')} **Answer (human):** 3000`
    const y = repoOf('y', [onlyQueue(answered), t1Pushed], { prs: [gh(78, 'open')] })
    const s = nextSteps(runOf(y), y, NOW)!
    expect(s.rest.find((i) => i.key === `entry:${answered}`)?.tier).toBe('info')
    expect(s.card.key).not.toBe(`entry:${answered}`)
    expect(pick(RECIPE.nothing('x'), y)?.item.key).not.toBe(`entry:${answered}`)
  })

  it('a selected card pod goes on without ranks as nothing', () => {
    expect(winner(RECIPE.someday('x'), RECIPE.decision('y'))).toBe('y')
    expect(winner(RECIPE.someday('x'), RECIPE.now('y'))).toBe('y')
    expect(winner(RECIPE.someday('x'), RECIPE.merge('y'))).toBe('y')
    expect(winner(RECIPE.other('x'), RECIPE.decision('y'))).toBe('y')
    expect(winner(RECIPE.someday('x'), RECIPE.other('y'))).toBeUndefined()
  })

  it("only each run's card counts", () => {
    // Y's card is its merge. A blocked entry routed to the orchestrator sits in Y's rest (info, with a
    // blocked status); it doesn't lift Y over a selected merge.
    const toOrchestrator = entry('BLOCKED', 'engineer → orchestrator', `${own} · sprint: ladder · slice: T1`, 'Tool missing.')
    const y = repoOf('y', [onlyQueue(toOrchestrator), manual, t1Pushed], { prs: [gh(78, 'open')] })
    const s = nextSteps(runOf(y), y, NOW)!
    expect(s.card.tier).toBe('merge')
    expect(s.rest.some((i) => i.status === 'blocked')).toBe(true)
    expect(winner(RECIPE.merge('x'), y)).toBeUndefined()
    expect(pick(RECIPE.reply('x'), y)?.item.tier).toBe('merge')
    // A pending decision under Y's merge card: Y still ranks as merge.
    const both = repoOf('y', [onlyQueue(pending('decision: pick the port.')), manual, t1Pushed], { prs: [gh(78, 'open')] })
    expect(cardOf(both).tier).toBe('merge')
    expect(pick(RECIPE.nothing('x'), both)?.item.tier).toBe('merge')
  })

  it('oldest entry wins, then sidebar order', () => {
    const x = RECIPE.nothing('x')
    const late = repoOf('late', [onlyQueue(blocked('2026-10-19')), manual])
    const early = repoOf('early', [onlyQueue(blocked('2026-10-12')), manual])
    expect(winner(x, late, early)).toBe('early')
    // An undated entry loses to a dated one, wherever it sits.
    const none = repoOf('none', [onlyQueue(undated(blocked('2026-10-01'))), manual])
    expect(cardOf(none).tier).toBe('blocked')
    expect(cardOf(none).entry?.date).toBeUndefined()
    expect(winner(x, none, late)).toBe('late')
    expect(winner(x, late, none)).toBe('late')
    // Equal dates: the earlier run in the sidebar.
    const same = repoOf('same', [onlyQueue(blocked('2026-10-19')), manual])
    expect(winner(x, same, late)).toBe('same')
    expect(winner(x, late, same)).toBe('late')
    // Two undated: the earlier run in the sidebar.
    const none2 = repoOf('none2', [onlyQueue(undated(blocked())), manual])
    expect(winner(x, none2, none)).toBe('none2')
    // The pending rank ties the same way, whatever the kinds.
    const pLate = repoOf('plate', [onlyQueue(ask('now: a.', '2026-10-19')), manual])
    const pEarly = repoOf('pearly', [onlyQueue(ask('decision: b.', '2026-10-02')), manual])
    expect(winner(x, pLate, pEarly)).toBe('pearly')
    const pNone = repoOf('pnone', [onlyQueue(undated(ask('before hosting: c.'))), manual])
    expect(winner(x, pNone, pLate)).toBe('plate')
    // Rank still comes first: a newer blocked beats an older pending.
    expect(winner(x, pEarly, late)).toBe('late')
  })

  it('merge and reply tie by sidebar order', () => {
    const x = RECIPE.nothing('x')
    const m90 = repoOf('m90', [onlyQueue(), manual, (f) => t1Pushed(f), (f) => (f[LADDER] = f[LADDER]!.replace('| #78 |', '| #90 |'))], {
      prs: [gh(90, 'open')],
    })
    expect(cardOf(m90).title).toBe('Merge PR #90')
    const m78 = RECIPE.merge('m78')
    expect(winner(x, m90, m78)).toBe('m90')
    expect(winner(x, m78, m90)).toBe('m78')
    const r1 = RECIPE.reply('r1')
    const r2 = RECIPE.reply('r2')
    expect(winner(RECIPE.now('x'), r2, r1)).toBe('r2')
    expect(winner(RECIPE.now('x'), r1, r2)).toBe('r1')
  })

  it('counts the other outranking runs', () => {
    const got = pick(RECIPE.nothing('x'), RECIPE.decision('a'), RECIPE.merge('b'), RECIPE.blocked('c'), RECIPE.someday('d'), RECIPE.nothing('e'))
    expect(got?.run.repoId).toBe('c')
    // a and b outrank too; d (someday) and e (nothing) can't raise a banner.
    expect(got?.more).toBe(2)
    expect(pick(RECIPE.nothing('x'), RECIPE.blocked('c'))?.more).toBe(0)
    // Only runs above the selected one count: over a selected reply, the decision doesn't.
    expect(pick(RECIPE.reply('x'), RECIPE.decision('a'), RECIPE.merge('b'), RECIPE.blocked('c'))?.more).toBe(1)
  })

  it('an entry with no plan on two runs raises nothing', () => {
    // An entry with no plan tag goes to every run of its repo: the plan run and a fix run here.
    const name = 'fix-scroll'
    const claim: Claim = { portBase: 3100, repoPath: '/y', plan: name }
    const shared = entry('BLOCKED', 'engineer → human', '', 'The npm cache is broken.')
    const y = repoOf('y', [onlyQueue(shared), manual], { claims: [claim] })
    const yRuns = listRuns(boardOf(y), NOW)
    const plan = yRuns.find((r) => r.plan === PLAN)!
    const fix = yRuns.find((r) => r.plan === name)!
    // It heads neither run's card, so it raises no banner and counts for nothing.
    expect(cardOf(y, plan).tier).toBe('nothing')
    expect(cardOf(y, fix).tier).toBe('nothing')
    const x = RECIPE.nothing('x')
    const xRun = runOf(x)
    expect(elsewhere([xRun, plan, fix], boardOf(x, y), xRun, NOW)).toBeUndefined()
    const z = repoOf('z', [onlyQueue(blocked('2026-10-01')), manual])
    const zRun = runOf(z)
    const behind = elsewhere([xRun, plan, fix, zRun], boardOf(x, y, z), xRun, NOW)
    expect(behind?.run.repoId).toBe('z')
    expect(behind?.more).toBe(0)
  })

  it('selected run, missing board and missing repo', () => {
    const x = RECIPE.nothing('x')
    const y = RECIPE.blocked('y')
    const runs = [runOf(x), runOf(y)]
    const board = boardOf(x, y)
    // A copy of the selected summary is still the selected run.
    expect(elsewhere(runs, board, { ...runs[1]! }, NOW)).toBeUndefined()
    expect(elsewhere(runs, board, { ...runs[0]! }, NOW)?.run.repoId).toBe('y')
    expect(elsewhere(runs, board, undefined, NOW)).toBeUndefined()
    expect(elsewhere(runs, undefined, runs[0], NOW)).toBeUndefined()
    // Y's repo isn't on the Board: its run is skipped, and another still shows.
    expect(elsewhere(runs, boardOf(x), runs[0], NOW)).toBeUndefined()
    const z = RECIPE.merge('z')
    expect(elsewhere([...runs, runOf(z)], boardOf(x, z), runs[0], NOW)?.run.repoId).toBe('z')
    // The selected run's own repo is gone: nothing to compare with, so no banner.
    expect(elsewhere(runs, boardOf(y), runs[0], NOW)).toBeUndefined()
  })

  it('a repo row names itself once', () => {
    const shared = entry('BLOCKED', 'engineer → human', '', 'The npm cache is broken.')
    const y = repoOf('y', [onlyQueue(shared), manual])
    const row: RunSummary = { repoId: 'y', repo: 'y-web', where: 'no active plan', state: 'blocked' }
    const x = RECIPE.nothing('x')
    const xRun = runOf(x)
    const got = elsewhere([xRun, row], boardOf(x, y), xRun, NOW)
    expect(got).toBeDefined()
    expect(got!.name).toBe('y-web')
    expect(got).not.toHaveProperty('repo')
    expect(got!.href).toBe('#/y')
  })
})

describe('sidebar order tie', () => {
  // The sidebar is `listRuns` order: newest activity first, so an equal-date tie goes to the run active last.
  const active = (id: string, minutesAgo: number) =>
    repoOf(id, [onlyQueue(blocked('2026-10-19')), manual], {
      agents: [{ id: `a-${id}`, session: 's', type: 'pod:engineer', plan: PLAN, tokens: 0, ended: true, lastAt: NOW - minutesAgo * 60_000 }],
    })

  it('the banner tie picks the earlier run in the sidebar', () => {
    const idle = RECIPE.nothing('idle')
    // Alphabetically `aaa` is first, but `zzz` was active last, so it is first in the sidebar.
    const aaa = active('aaa', 90)
    const zzz = active('zzz', 5)
    const b = boardOf(idle, aaa, zzz)
    const runs = listRuns(b, NOW)
    expect(runs.map((r) => r.repoId)).toEqual(['zzz', 'aaa', 'idle'])
    expect(elsewhere(runs, b, runs[2], NOW)?.run.repoId).toBe('zzz')
    // Moving the activity moves the tie.
    const b2 = boardOf(idle, active('aaa', 1), active('zzz', 5))
    const runs2 = listRuns(b2, NOW)
    expect(elsewhere(runs2, b2, runs2[2], NOW)?.run.repoId).toBe('aaa')
  })
})

describe('elsewhere after Remove repo', () => {
  const selected = RECIPE.nothing('a')
  const gone = RECIPE.blocked('b')
  const left = RECIPE.now('c')

  it('a removed repo leaves the banner, and Open run points at a run that is still listed', () => {
    const before = pick(selected, gone, left)
    expect([before?.run.repoId, before?.more]).toEqual(['b', 1])
    const after = pick(selected, left)
    expect([after?.run.repoId, after?.more]).toEqual(['c', 0])
    expect(after?.href).toBe(hashFor(runOf(left)))
    expect(after?.href).not.toContain('/b/')
  })

  it('the banner goes away when the removed repo was the only one that outranked the open run', () => {
    expect(winner(selected, gone)).toBe('b')
    expect(pick(selected)).toBeUndefined()
  })
})
