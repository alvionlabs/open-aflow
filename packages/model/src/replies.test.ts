import { describe, expect, it } from 'vitest'
import * as model from './index.ts'
import type { AgentRun, BoardRepo, Claim, PrStatus } from './board.ts'
import { replySession, runReplies, type RunReply } from './replies.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'

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
const handBack = (n: number, pending = true) =>
  queueLine('PENDING', 'orchestrator → human', 'plan: alpha', `Plan complete: merge https://github.com/o/r/pull/${n}`, pending)
const halt = queueLine('BLOCKED', 'orchestrator → human', 'plan: alpha', 'Halted at gate 1.')

const link = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })
const claim = (plan: string): Claim => ({ portBase: 3100, repoPath: '/r', plan })

/** Sprint `one` of plan alpha, current, with wave 1 done and wave 2 handed back on PR #7. */
const PUSHED: BoardRow[] = [
  [1, 'A1', `${link(5)} merged`, 'done'],
  [2, 'B1', link(7), 'pushed'],
  [2, 'B2', link(7), 'pushed'],
]
const pushed = (extra: Partial<BoardRepo> = {}, rows: BoardRow[] = PUSHED, queue: string[] = []) => repo(files({ docs: { one: rows }, queue }), extra)

/** Every sprint done, with a hand-back of PR #12. */
const DONE: Opts = { sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] }, queue: [handBack(12)] }
/** Claimed, so the plan stays a run once its PR merges. */
const closing = (extra: Partial<BoardRepo> = {}, opts: Opts = DONE) => repo(files(opts), { claims: [claim('alpha')], ...extra })

/** Sprint one done, sprint two current with no doc yet. */
const BETWEEN: Opts = { sprints: [['one', 'done'], ['two', 'planned']], docs: { one: [[1, 'A1', 'merged', 'done']] } }
/** Every sprint planned, none with a doc. */
const FRESH: Opts = { sprints: [['one', 'planned'], ['two', 'planned']] }

const replies = (r: BoardRepo, run = 'alpha') => runReplies(r, run, NOW)
const words = (r: BoardRepo, run = 'alpha') => replies(r, run).map((x) => x.reply)
const merge = (n: number): RunReply => ({ reply: 'continue', signal: 'wave-waiting', why: `Merge PR #${n}, then reply continue.`, pr: n, key: `wave-waiting:${n}` })

describe('runReplies', () => {
  it('final PR replies', () => {
    const both: RunReply[] = [
      { reply: 'continue', signal: 'final-waiting', why: 'Merge PR #12, then reply continue.', pr: 12, key: 'final-waiting:12' },
      { reply: 'try', signal: 'final-waiting', why: 'Starts the app so you can try it.', key: 'try:alpha' },
    ]
    // A pending hand-back: continue and try; try names no PR.
    expect(replies(repo(files(DONE)))).toEqual(both)
    expect(replies(closing({ prs: [gh(12, 'open')] }))).toEqual(both)
    expect(replies(repo(files(DONE)))[1]).not.toHaveProperty('pr')
    // Merged and still pending: continue only.
    expect(replies(closing({ prs: [gh(12, 'merged')] }))).toEqual([
      { reply: 'continue', signal: 'final-merged', why: 'PR #12 merged: pod cleans up.', pr: 12, key: 'final-merged:12' },
    ])
    // Once pod resolves the entry, nothing.
    expect(replies(closing({ prs: [gh(12, 'merged')] }, { ...DONE, queue: [handBack(12, false)] }))).toEqual([])
    // pod archives the plan before the final merge. Archived and claimed, long after its last agent wrote:
    const archived: Opts = { ...DONE, status: 'archived' }
    const old = { agents: [ended({ type: 'pod:reporter', plan: 'alpha', lastAt: NOW - 120 * MIN })] }
    // gh open, closed, or unknown → still waiting on your merge: one continue, one try.
    for (const prs of [[gh(12, 'open')], [gh(12, 'closed')], []]) expect(replies(closing({ ...old, prs }, archived))).toEqual(both)
    expect(replies(closing({ ...old, prs: [gh(12, 'open')] }, archived)).filter((x) => x.reply === 'continue')).toHaveLength(1)
    // gh merged, the hand-back entry still pending → pod waits for continue to clean up.
    expect(replies(closing({ ...old, prs: [gh(12, 'merged')] }, archived))).toEqual([
      { reply: 'continue', signal: 'final-merged', why: 'PR #12 merged: pod cleans up.', pr: 12, key: 'final-merged:12' },
    ])
    // Once pod resolves the entry, nothing; with no claim, nothing either.
    expect(replies(closing({ ...old, prs: [gh(12, 'merged')] }, { ...archived, queue: [handBack(12, false)] }))).toEqual([])
    expect(replies(repo(files(archived), { ...old, prs: [gh(12, 'merged')] }))).toEqual([])
    // A hand-back beside a handed-back wave: the hand-back wins.
    expect(replies(pushed({}, PUSHED, [handBack(12)])).map((x) => x.signal)).toEqual(['final-waiting', 'final-waiting'])
  })

  it('wave replies follow gh', () => {
    // Handed back, gh unknown → waiting on your merge.
    expect(replies(pushed())).toEqual([merge(7)])
    expect(replies(pushed({ prs: [gh(7, 'open')] }))).toEqual([merge(7)])
    // gh merged → continue, it's merged.
    expect(replies(pushed({ prs: [gh(7, 'merged')] }))).toEqual([{ reply: 'continue', signal: 'wave-merged', why: 'PR #7 merged.', pr: 7, key: 'wave-merged:7' }])
    // Closed is neither: nothing.
    expect(replies(pushed({ prs: [gh(7, 'closed')] }))).toEqual([])
    // Two PRs, one merged, one unknown: the unknown one still waits.
    const two: BoardRow[] = [
      [1, 'B1', link(7), 'pushed'],
      [1, 'B2', link(8), 'pushed'],
    ]
    expect(replies(pushed({ prs: [gh(7, 'merged')] }, two))).toEqual([merge(8)])
    // A merged PR on a wave that isn't handed back (a slice pending) or is blocked: nothing.
    expect(replies(pushed({ prs: [gh(7, 'merged')] }, [[1, 'B1', link(7), 'pushed'], [1, 'B2', '—', 'pending']]))).toEqual([])
    expect(replies(pushed({ prs: [gh(7, 'merged')] }, [[1, 'B1', link(7), 'pushed'], [1, 'B2', '—', 'blocked']]))).toEqual([])
    // A done wave's merged PR asks nothing.
    expect(replies(pushed({ prs: [gh(5, 'merged')] }, [[1, 'A1', link(5), 'done'], [2, 'B1', '—', 'pending']]))).toEqual([])
  })

  it('sprint done asks to continue', () => {
    expect(replies(repo(files(BETWEEN)))).toEqual([{ reply: 'continue', signal: 'sprint-done', why: 'Sprint one is done.', key: 'sprint-done:one' }])
    // The latest done sprint before the current one is named.
    const later: Opts = { sprints: [['one', 'done'], ['two', 'done'], ['three', 'planned']] }
    expect(replies(repo(files(later)))[0]?.why).toBe('Sprint two is done.')
    // A current sprint with a doc and no handed-back wave: nothing.
    const drafted: Opts = { ...BETWEEN, docs: { ...BETWEEN.docs, two: [[1, 'C1', '—', 'pending']] } }
    expect(replies(repo(files(drafted)))).toEqual([])
    // A first sprint with no doc, not planned, and nothing done before it: nothing.
    expect(replies(repo(files({ sprints: [['one', 'active']] })))).toEqual([])
  })

  it('go only on a plan not started', () => {
    expect(replies(repo(files(FRESH)))).toEqual([{ reply: 'go', signal: 'not-started', why: 'Only if pod asked for go.', key: 'not-started:alpha' }])
    // One sprint with a doc: not go.
    expect(words(repo(files({ ...FRESH, docs: { one: [[1, 'A1', '—', 'pending']] } })))).toEqual([])
    // An archived plan, kept a run by its claim and a recent ended agent: not go.
    const reporter = ended({ type: 'pod:reporter', plan: 'alpha', lastAt: NOW - 5 * MIN })
    expect(words(repo(files({ ...FRESH, status: 'archived' }), { claims: [claim('alpha')], agents: [reporter] }))).toEqual([])
    // A plan with no sprints (a claim keeps it listed): not go.
    expect(words(closing({}, { sprints: [] }))).toEqual([])
    // An ended planner's transcript changes nothing: still go.
    expect(words(repo(files(FRESH), { agents: [ended({ type: 'pod:sprint-planner', plan: 'alpha' })] }))).toEqual(['go'])
  })

  it('no reply while pod works or is halted', () => {
    // Halted: even with a handed-back wave.
    expect(replies(pushed({}, PUSHED, [halt]))).toEqual([])
    // A running engineer, planner, or reviewer of the plan.
    expect(replies(pushed({ agents: [running({ sprint: 'one', slice: 'A1' })] }))).toEqual([])
    expect(replies(repo(files(FRESH), { agents: [running({ type: 'pod:sprint-planner', plan: 'alpha' })] }))).toEqual([])
    expect(replies(repo(files(DONE), { agents: [running({ type: 'pod:reviewer', plan: 'alpha' })] }))).toEqual([])
    // An agent of another plan doesn't hold it.
    expect(replies(pushed({ agents: [running({ type: 'pod:reviewer', plan: 'beta' })] }))).toEqual([merge(7)])
    // Unlisted: archived with no claim, an error, unsupported docs, or no such run.
    expect(replies(repo(files({ ...DONE, status: 'archived' })))).toEqual([])
    expect(replies(pushed({ error: 'folder not found' }))).toEqual([])
    expect(replies(repo({ 'pod-docs/README.md': 'pod docs: 1\n', 'pod-docs/plans/alpha.md': planDoc('alpha', [['one', 'planned']]) }))).toEqual([])
    expect(replies(pushed(), 'beta')).toEqual([])
    expect(replies(pushed(), 'fix-scroll')).toEqual([])
  })

  it('go never comes from another signal', () => {
    // A pending hand-back on a plan whose sprints all read planned: final, never go.
    expect(words(repo(files({ ...FRESH, queue: [handBack(12)] })))).toEqual(['continue', 'try'])
    // A handed-back wave, a merged wave, a done sprint, a merged and a pending hand-back: never go.
    const others = [pushed(), pushed({ prs: [gh(7, 'merged')] }), repo(files(BETWEEN)), closing({ prs: [gh(12, 'merged')] }), repo(files(DONE))]
    for (const r of [...others, repo(files(FRESH))]) {
      const ws = words(r)
      expect(new Set(ws).size).toBe(ws.length)
    }
    expect(others.flatMap((r) => words(r))).not.toContain('go')
  })

  it('fix run replies', () => {
    const name = 'fix-scroll'
    const eng = ended({ branch: name, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
    const rev = ended({ type: 'pod:reviewer', kind: 'fix', branch: name, startedAt: NOW - 50 * MIN, lastAt: NOW - 40 * MIN })
    const fix = (extra: Partial<BoardRepo>) => runReplies(repo({ 'pod-docs/README.md': README }, { claims: [claim(name)], ...extra }), name, NOW)
    const open = gh(36, 'open', { branch: name })
    const merged = gh(36, 'merged', { branch: name })

    // Reviewed and open: merge first.
    expect(fix({ agents: [eng, rev], prs: [open] })).toEqual([{ reply: 'continue', signal: 'fix-waiting', why: 'Merge PR #36, then reply continue.', pr: 36, key: 'fix-waiting:36' }])
    // Not reviewed yet: nothing.
    expect(fix({ agents: [eng], prs: [open] })).toEqual([])
    // Merged while the run is listed (an agent wrote recently): continue.
    expect(fix({ agents: [eng, { ...rev, lastAt: NOW - 5 * MIN }], prs: [merged] })).toEqual([
      { reply: 'continue', signal: 'fix-merged', why: 'PR #36 merged.', pr: 36, key: 'fix-merged:36' },
    ])
    // Merged and stale: the run isn't listed, so nothing.
    expect(fix({ agents: [eng, rev], prs: [merged] })).toEqual([])
    // A running fix agent: nothing.
    expect(fix({ agents: [eng, rev, running({ branch: name })], prs: [open] })).toEqual([])
    expect(fix({ agents: [eng, running({ type: 'pod:reviewer', kind: 'fix', branch: name })], prs: [merged] })).toEqual([])
    // No PR yet, or no claim: nothing.
    expect(fix({ agents: [eng, rev] })).toEqual([])
    expect(runReplies(repo({ 'pod-docs/README.md': README }, { agents: [eng, rev], prs: [open] }), name, NOW)).toEqual([])
  })

  it('stop keys name one stop', () => {
    const keys = (r: BoardRepo, run = 'alpha') => replies(r, run).map((x) => x.key)
    // A PR names the stop: <signal>:<pr>.
    expect(keys(pushed())).toEqual(['wave-waiting:7'])
    expect(keys(pushed({ prs: [gh(7, 'merged')] }))).toEqual(['wave-merged:7'])
    expect(keys(closing({ prs: [gh(12, 'merged')] }))).toEqual(['final-merged:12'])
    // The final-waiting try has no PR: try:<plan slug>.
    expect(keys(repo(files(DONE)))).toEqual(['final-waiting:12', 'try:alpha'])
    // A done sprint names the done sprint, not the current one.
    expect(keys(repo(files(BETWEEN)))).toEqual(['sprint-done:one'])
    expect(keys(repo(files({ sprints: [['one', 'done'], ['two', 'done'], ['three', 'planned']] })))).toEqual(['sprint-done:two'])
    // A fresh plan: not-started:<plan slug>.
    expect(keys(repo(files(FRESH)))).toEqual(['not-started:alpha'])

    // Two waves of one sprint, each merged in turn, are two stops.
    const wave1: BoardRow[] = [[1, 'A1', link(5), 'pushed'], [2, 'B1', '—', 'pending']]
    const wave2: BoardRow[] = [[1, 'A1', `${link(5)} merged`, 'done'], [2, 'B1', link(7), 'pushed']]
    const k1 = keys(pushed({ prs: [gh(5, 'merged')] }, wave1))
    const k2 = keys(pushed({ prs: [gh(5, 'merged'), gh(7, 'merged')] }, wave2))
    expect(k1).toEqual(['wave-merged:5'])
    expect(k2).toEqual(['wave-merged:7'])
    expect(k1[0]).not.toBe(k2[0])

    // Fix runs: the PR names the stop.
    const name = 'fix-scroll'
    const eng = ended({ branch: name, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
    const rev = ended({ type: 'pod:reviewer', kind: 'fix', branch: name, startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })
    const fixRepo = (pr: PrStatus) => repo({ 'pod-docs/README.md': README }, { claims: [claim(name)], agents: [eng, rev], prs: [pr] })
    expect(keys(fixRepo(gh(36, 'open', { branch: name })), name)).toEqual(['fix-waiting:36'])
    expect(keys(fixRepo(gh(36, 'merged', { branch: name })), name)).toEqual(['fix-merged:36'])
  })

  it('is exported from the package entry', () => {
    expect(model.runReplies).toBe(runReplies)
    expect(model.replySession).toBe(replySession)
    // Only these signals mean pod already waits for continue.
    expect([...model.SEND_SIGNALS].sort()).toEqual(['answered', 'final-merged', 'fix-merged', 'sprint-done', 'wave-merged'])
  })
})


describe('answered stop', () => {
  /** The line with the board's answer appended, as the Answer route writes it. */
  const answer = (line: string, text = 'go on') => `${line} **Answer (human):** ${text}`
  const decision = queueLine('PENDING', 'orchestrator → human', 'plan: alpha · sprint: one', 'Pick a storage format.')
  const engineerBlock = queueLine('BLOCKED', 'engineer → orchestrator', 'plan: alpha · sprint: one · slice: A1', 'Port taken.')
  /** Sprint one in progress, no wave handed back: no other reply. */
  const WORK: BoardRow[] = [[1, 'A1', '—', 'in progress']]
  const at = (queue: string[], extra: Partial<BoardRepo> = {}, rows: BoardRow[] = WORK) => repo(files({ docs: { one: rows }, queue }), extra)
  const one = (r: BoardRepo) => {
    const got = replies(r)
    expect(got).toHaveLength(1)
    return got[0]!
  }

  it('offers continue on a halted run once every entry waiting on you is answered', () => {
    const got = one(at([answer(halt)]))
    expect(got).toMatchObject({ reply: 'continue', signal: 'answered', why: 'You answered 1 entry: reply continue so pod reads it.' })
    expect(got).not.toHaveProperty('pr')
    expect(got.key).toMatch(/^answered:alpha:1:[0-9a-f]{8}$/)
    // Unanswered halt: nothing, as before.
    expect(replies(at([halt]))).toEqual([])
    // Two answered: the count and the plural.
    expect(one(at([answer(halt), answer(decision, 'json')])).why).toBe('You answered 2 entries: reply continue so pod reads them.')
    expect(one(at([answer(halt), answer(decision, 'json')])).key).toMatch(/^answered:alpha:2:[0-9a-f]{8}$/)
  })

  it('an unanswered BLOCKED holds it back, an unanswered PENDING does not', () => {
    // A PENDING only defers (pod uses the value in use), so an open one doesn't hold the reply back or count.
    expect(one(at([answer(halt), decision])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    const someday = queueLine('PENDING', 'orchestrator → human', 'plan: alpha · sprint: one', '**Someday (Look):** tighten the margins.')
    expect(one(at([answer(halt), decision, someday])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    // An unanswered BLOCKED halts pod: nothing, even with an answered PENDING beside it.
    expect(replies(at([halt, answer(decision)]))).toEqual([])
    // Only entries routed → human count. Gate 1: the engineer's BLOCKED to the orchestrator plus the
    // orchestrator's halt to you. You answer the halt; the engineer's entry doesn't hold it back.
    expect(one(at([engineerBlock, answer(halt)])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    // An answered engineer → orchestrator BLOCKED doesn't add to N, nor make a reply alone.
    expect(one(at([answer(halt), answer(engineerBlock)])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    expect(replies(at([answer(engineerBlock)]))).toEqual([])
    // A BLOCKED routed to you from anyone holds it back.
    const toYou = queueLine('BLOCKED', 'engineer → human', 'plan: alpha · sprint: one · slice: A1', 'Need a key.')
    expect(replies(at([answer(halt), toYou]))).toEqual([])
    expect(replies(at([answer(halt), toYou.replace('engineer → human', 'engineer -> human')]))).toEqual([])
    expect(one(at([answer(halt), answer(toYou)])).why).toBe('You answered 2 entries: reply continue so pod reads them.')
    // Only unanswered PENDINGs: nothing to read yet.
    expect(replies(at([decision, someday]))).toEqual([])
  })

  it('counts only pending PENDING and BLOCKED entries waiting on you for this plan', () => {
    // A NOTE → human waits on you but can't be answered: it doesn't hold the reply back or count.
    const note = queueLine('NOTE', 'engineer → human', 'plan: alpha', 'FYI.')
    expect(one(at([answer(halt), note])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    // An entry not addressed to you, answered or not, doesn't count.
    const toOrch = queueLine('PENDING', 'engineer → orchestrator', 'plan: alpha', 'Which port?')
    expect(one(at([answer(halt), toOrch])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    expect(replies(at([answer(toOrch)]))).toEqual([])
    // Another plan's entries: neither count nor hold it back.
    const beta = queueLine('PENDING', 'orchestrator → human', 'plan: beta', 'Beta question.')
    expect(one(at([answer(halt), beta])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
    expect(replies(at([answer(beta)]))).toEqual([])
    // No entry waiting on you at all: nothing.
    expect(replies(at([]))).toEqual([])
  })

  it('works on a PENDING decision gate that is not a halt', () => {
    expect(one(at([answer(decision)]))).toMatchObject({ reply: 'continue', signal: 'answered' })
  })

  it('goes away once pod applies the answers', () => {
    // pod rewrites the Resolution from pending to a date: the entry is no longer pending.
    const applied = (line: string) => answer(line).replace('**Resolution:** pending', '**Resolution:** 2026-10-23 — retried')
    expect(replies(at([applied(halt)]))).toEqual([])
    expect(replies(at([applied(halt), applied(decision)]))).toEqual([])
    // One applied, one still pending and answered: only the pending one counts.
    expect(one(at([applied(halt), answer(decision)])).why).toBe('You answered 1 entry: reply continue so pod reads it.')
  })

  it('never while pod works', () => {
    expect(replies(at([answer(halt)], { agents: [running({ sprint: 'one', slice: 'A1' })] }))).toEqual([])
    expect(replies(at([answer(decision)], { agents: [running({ type: 'pod:reviewer', plan: 'alpha' })] }))).toEqual([])
    // Ended agents don't hold it back.
    expect(one(at([answer(halt)], { agents: [ended({ plan: 'alpha' })] })).signal).toBe('answered')
    // Not a run: nothing.
    expect(replies(at([answer(halt)], { error: 'folder not found' }))).toEqual([])
  })

  it('an existing reply wins: never a second continue', () => {
    // A merged wave beside an answered gate: only wave-merged.
    expect(replies(at([answer(decision)], { prs: [gh(7, 'merged')] }, PUSHED))).toEqual([
      { reply: 'continue', signal: 'wave-merged', why: 'PR #7 merged.', pr: 7, key: 'wave-merged:7' },
    ])
    // A wave waiting on your merge: only the merge-first continue.
    expect(replies(at([answer(decision)], {}, PUSHED))).toEqual([merge(7)])
    // A done sprint: only sprint-done.
    expect(replies(repo(files({ ...BETWEEN, queue: [answer(decision)] }))).map((r) => r.signal)).toEqual(['sprint-done'])
    // A fresh plan: only go.
    expect(replies(repo(files({ ...FRESH, queue: [answer(decision)] }))).map((r) => r.signal)).toEqual(['not-started'])
    // A halt still hides the other replies, so an answered halt gives only answered.
    expect(replies(at([answer(halt)], { prs: [gh(7, 'merged')] }, PUSHED)).map((r) => r.signal)).toEqual(['answered'])
    // At most one reply per word.
    for (const r of [at([answer(halt)]), at([answer(decision)], { prs: [gh(7, 'merged')] }, PUSHED)]) {
      expect(replies(r).filter((x) => x.reply === 'continue')).toHaveLength(1)
    }
  })

  it('keys by the answered entries', () => {
    const key = (queue: string[]) => one(at(queue)).key
    // The same answers give the same key, on every rebuild.
    expect(key([answer(halt)])).toBe(key([answer(halt)]))
    // A line that isn't an answered entry doesn't change it.
    const note = queueLine('NOTE', 'engineer → human', 'plan: alpha', 'FYI.')
    expect(key([answer(halt), note])).toBe(key([answer(halt)]))
    // Nor does an unanswered PENDING: the key names the answered entries.
    expect(key([answer(halt), decision])).toBe(key([answer(halt)]))
    // Nor an answered entry not routed to you.
    expect(key([answer(halt), answer(engineerBlock)])).toBe(key([answer(halt)]))
    // A new set of answers is a new stop.
    const keys = new Set([
      key([answer(halt)]),
      key([answer(halt, 'other text')]),
      key([answer(decision)]),
      key([answer(halt), answer(decision)]),
      key([answer(halt.replace('2026-10-21', '2026-10-22'))]),
    ])
    expect(keys.size).toBe(5)
    // The key isn't the why.
    expect(key([answer(halt)])).not.toContain('answered 1')
  })

  it('fix runs get no answered reply', () => {
    // Queue entries join plans, not fix runs, so a fix run's replies stay its PR's.
    const name = 'fix-scroll'
    const eng = ended({ branch: name })
    const fix = repo({ 'pod-docs/README.md': README, 'pod-docs/handoff-queue.md': answer(halt) }, { claims: [claim(name)], agents: [eng] })
    expect(replies(fix, name)).toEqual([])
  })
})
describe('replySession', () => {
  it('a session the board cannot prove is the repo’s gives no resume, so nothing can send it', () => {
    const a = { id: 'a', session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: true, plan: 'alpha', lastAt: NOW - 90 * MIN, sessionUnproven: true as const }
    const repo = pushed({ agents: [a] })
    const s = replySession(repo, 'alpha', NOW)
    expect(s?.id).toBe('sess-1')
    expect(s?.resume).toBeUndefined()
  })

  it('finds the chat to paste in', () => {
    const old = ended({ plan: 'alpha', session: 'sess-old', startedAt: NOW - 90 * MIN, lastAt: NOW - 30 * MIN })
    const newest = ended({ sprint: 'one', slice: 'B1', session: 'sess-new', startedAt: NOW - 20 * MIN, lastAt: NOW - 5 * MIN })
    // A repo agent of no plan in the same session started earliest: it sets the session's start.
    const earlier = ended({ type: 'pod:researcher', session: 'sess-new', startedAt: NOW - 200 * MIN, lastAt: NOW - 150 * MIN })
    // Started later but never wrote: doesn't count.
    const silent = agent({ plan: 'alpha', session: 'sess-silent', startedAt: NOW - MIN })
    const r = pushed({ agents: [old, newest, earlier, silent] })
    expect(replySession(r, 'alpha', NOW)).toEqual({ id: 'sess-new', startedAt: NOW - 200 * MIN, repoPath: '/r', resume: 'claude --resume sess-new' })

    // Ties on lastAt: the newer start wins; then the smaller agent id.
    const t1 = ended({ plan: 'alpha', session: 'tie-a', startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })
    const t2 = ended({ plan: 'alpha', session: 'tie-b', startedAt: NOW - 40 * MIN, lastAt: NOW - 5 * MIN })
    expect(replySession(pushed({ agents: [t1, t2] }), 'alpha', NOW)?.id).toBe('tie-b')
    const u1 = agent({ id: 'b', plan: 'alpha', session: 'id-b', lastAt: NOW - 5 * MIN })
    const u2 = agent({ id: 'a', plan: 'alpha', session: 'id-a', lastAt: NOW - 5 * MIN })
    expect(replySession(pushed({ agents: [u1, u2] }), 'alpha', NOW)?.id).toBe('id-a')

    // No start on any agent of the session: no startedAt.
    expect(replySession(pushed({ agents: [u2] }), 'alpha', NOW)).toEqual({ id: 'id-a', repoPath: '/r', resume: 'claude --resume id-a' })

    // An id outside the pattern: shown, but no resume.
    for (const id of ['bad id', 'x;rm -rf', 'a'.repeat(65), '$(whoami)', 'id_with_underscore']) {
      const s = replySession(pushed({ agents: [ended({ plan: 'alpha', session: id })] }), 'alpha', NOW)
      expect(s?.id).toBe(id)
      expect(s).not.toHaveProperty('resume')
    }
    const long = 'a'.repeat(64)
    expect(replySession(pushed({ agents: [ended({ plan: 'alpha', session: long })] }), 'alpha', NOW)?.resume).toBe(`claude --resume ${long}`)

    // No agents, only other plans' agents, or no such run → undefined.
    expect(replySession(pushed(), 'alpha', NOW)).toBeUndefined()
    expect(replySession(pushed({ agents: [ended({ plan: 'beta', session: 'other' })] }), 'alpha', NOW)).toBeUndefined()
    expect(replySession(pushed({ agents: [old] }), 'beta', NOW)).toBeUndefined()

    // A fix run: its engineers and reviewers only.
    const name = 'fix-scroll'
    const fixRepo = repo(
      { 'pod-docs/README.md': README },
      {
        claims: [claim(name)],
        agents: [
          ended({ branch: name, session: 'fix-sess', startedAt: NOW - 30 * MIN, lastAt: NOW - 20 * MIN }),
          ended({ type: 'pod:researcher', session: 'stray', lastAt: NOW - MIN }),
        ],
      },
    )
    expect(replySession(fixRepo, name, NOW)).toEqual({ id: 'fix-sess', startedAt: NOW - 30 * MIN, repoPath: '/r', resume: 'claude --resume fix-sess' })
  })
})
