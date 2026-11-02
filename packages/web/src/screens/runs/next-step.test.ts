import { describe, expect, it } from 'vitest'
import { buildRepoModel, listRuns, type AgentRun, type BoardRepo, type Claim, type PrStatus, type RunSummary } from '@pod-board/model'
import { loadFixture } from '../../../../model/test/load-fixture.ts'
import { gateTitle, nextSteps, type NextItem, type NextSteps } from './next-step.ts'
import { emptyMessage } from './view.ts'

// Boards built from the chess-web fixture: plan sparring-ladder, an autopilot run on wave 3 of sprint ladder
// (T1 pending), with three PENDING entries routed to you (H1, U1, wave 2). Each case edits the files first.

const NOW = Date.UTC(2026, 9, 20, 12)
const MIN = 60_000
const PLAN = 'sparring-ladder'
const QUEUE = 'pod-docs/handoff-queue.md'
const LADDER = 'pod-docs/sprints/ladder.md'

type Files = Record<string, string>
type Edit = (files: Files) => void

const FIXTURE_QUEUE = loadFixture('chess-web')[QUEUE]!
/** The fixture's entry whose line contains `part`, as the Board carries it. */
const lineWith = (part: string) => {
  const line = FIXTURE_QUEUE.split(/\r?\n/).find((l) => l.includes(part))
  if (!line) throw new Error(`no fixture line with ${part}`)
  return line.trim()
}
const H1 = lineWith('slice: H1]` Needs your decision')
const U1 = lineWith('slice: U1]`')
const WAVE2 = lineWith('slice: wave 2]` **Look:** at 375 px')

const entry = (type: string, route: string, fields: string, body: string) => `- \`[2026-10-19 · ${type} · ${route}${fields ? ` · ${fields}` : ''}]\` ${body} **Resolution:** pending`
const HALT = entry('BLOCKED', 'orchestrator → human', `plan: ${PLAN}`, 'Gate 1: T1 is blocked, the rates file is missing.')
const T1_BLOCKED = entry('BLOCKED', 'engineer → human', 'sprint: ladder · slice: T1', "T1 can't reach the rates file.")
const T1_BLOCKED_2 = entry('BLOCKED', 'engineer → human', 'sprint: ladder · slice: T1', 'T1 needs the 2500 games.')
const TO_ORCHESTRATOR = entry('BLOCKED', 'engineer → orchestrator', 'sprint: ladder · slice: T1', 'Tool missing.')
const ANSWERED = `${entry('PENDING', 'engineer → human', 'sprint: ladder · slice: T1', 'Pick the step size.')} **Answer (human):** 50`
const UNJOINED = entry('PENDING', 'orchestrator → human', '', 'Check the npm cache.')
const HAND_BACK = entry('PENDING', 'orchestrator → human', `plan: ${PLAN}`, 'Plan complete: merge https://github.com/o/r/pull/80')

const addQueue = (...lines: string[]): Edit => (f) => {
  f[QUEUE] = `${f[QUEUE]!.trimEnd()}\n${lines.join('\n')}\n`
}
/** Only these entries in the queue. */
const onlyQueue = (...lines: string[]): Edit => (f) => {
  f[QUEUE] = ['# Handoff Queue', '', ...lines, ''].join('\n')
}
/** Started with /pod:code: no autopilot line in the plan doc or the sprint doc. */
const manual: Edit = (f) => {
  for (const doc of ['pod-docs/plans/sparring-ladder.md', LADDER]) f[doc] = f[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
}
/** T1 handed back on PR #78. */
const t1Pushed: Edit = (f) => {
  f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', '| ladder-T1 | #78 | pushed | medium |')
}
const t1Blocked: Edit = (f) => {
  f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', '| ladder-T1 | — | blocked | — |')
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
const runs = (repo: BoardRepo) => listRuns({ generatedAt: NOW, gh: 'ok', repos: [repo] }, NOW)
const runOf = (repo: BoardRepo, plan = PLAN): RunSummary => {
  const r = runs(repo).find((x) => x.plan === plan)
  if (!r) throw new Error(`no run ${plan}`)
  return r
}
const steps = (repo: BoardRepo, plan = PLAN): NextSteps => defined(nextSteps(runOf(repo, plan), repo, NOW))
function defined<T>(x: T | undefined): T {
  expect(x).toBeDefined()
  return x!
}
/** Each item as `tier key`, card first. */
const order = (s: NextSteps) => [s.card, ...s.rest].map((i) => `${i.tier} ${i.key}`)
const entryKey = (line: string) => `entry:${line.trim()}`

describe('next step', () => {
  it('blocked beats a PR', () => {
    const repo = chess([manual, t1Pushed, addQueue(T1_BLOCKED)], { prs: [gh(78, 'open')] })
    const s = steps(repo)
    expect(s.card).toEqual<NextItem>({
      key: entryKey(T1_BLOCKED),
      tier: 'blocked',
      status: 'blocked',
      title: "T1 can't reach the rates file.",
      detail: 'The run is stopped until you answer.',
      entry: expect.objectContaining({ line: T1_BLOCKED, route: 'engineer → human', body: "T1 can't reach the rates file.", answerable: true }),
      action: { kind: 'answer', repoId: 'chess', line: T1_BLOCKED },
    })
    // The PR comes next in rest, with its Merge action.
    expect(s.rest[0]).toEqual<NextItem>({
      key: 'pr:78',
      tier: 'merge',
      status: 'needs-you',
      title: 'Merge PR #78',
      detail: 'Wave 3 of ladder is handed back to you.',
      action: { kind: 'merge', repoId: 'chess', number: 78 },
    })
    expect(s.rest.map((i) => i.key)).toContain('pr:78')
  })

  it('tier order', () => {
    // Two BLOCKED → human, a wave PR and the final PR, the reply (merge first), and the PENDING entries.
    const repo = chess([manual, t1Pushed, addQueue(T1_BLOCKED, HAND_BACK, T1_BLOCKED_2)], { prs: [gh(78, 'open'), gh(80, 'open')] })
    expect(order(steps(repo))).toEqual([
      `blocked ${entryKey(T1_BLOCKED)}`,
      `blocked ${entryKey(T1_BLOCKED_2)}`,
      'merge pr:78',
      'merge pr:80',
      `reply reply:${PLAN}`,
      `pending ${entryKey(H1)}`,
      `pending ${entryKey(U1)}`,
      `pending ${entryKey(WAVE2)}`,
      `pending ${entryKey(HAND_BACK)}`,
    ])

    // No BLOCKED: the first PR is the card; a reply beats a PENDING → human.
    const noBlock = chess([manual, t1Pushed], { prs: [gh(78, 'open')] })
    const s = steps(noBlock)
    expect(order(s)).toEqual(['merge pr:78', `reply reply:${PLAN}`, `pending ${entryKey(H1)}`, `pending ${entryKey(U1)}`, `pending ${entryKey(WAVE2)}`])
    expect(s.rest[0]).toMatchObject({ tier: 'reply', status: 'needs-you', title: 'Send continue', detail: 'Merge PR #78, then reply continue.' })
    expect(s.rest[0]?.action.kind).toBe('reply')
    expect(s.rest[1]).toEqual<NextItem>({
      key: entryKey(H1),
      tier: 'pending',
      status: 'needs-you',
      title: expect.stringMatching(/^Needs your decision: recent arenas gave too few players .*…$/),
      detail: 'pod goes on with the value in use until you answer.',
      entry: expect.objectContaining({ line: H1, answerable: true }),
      action: { kind: 'answer', repoId: 'chess', line: H1 },
    })
    expect(s.rest[1]!.title.length).toBeLessThanOrEqual(80)

    // A reply beats a PENDING when there is no PR: the fixture's own entries, the wave merged.
    const merged = chess([manual, t1Pushed], { prs: [gh(78, 'merged')], agents: [engineer()] })
    expect(order(steps(merged))).toEqual([`reply reply:${PLAN}`, `pending ${entryKey(H1)}`, `pending ${entryKey(U1)}`, `pending ${entryKey(WAVE2)}`])

    // Only PENDING entries: the first in list order is the card; the Waiting count is the rest.
    const plain = steps(chess())
    expect(order(plain)).toEqual([`pending ${entryKey(H1)}`, `pending ${entryKey(U1)}`, `pending ${entryKey(WAVE2)}`])
    expect(plain.rest).toHaveLength(2)
  })

  it('only entries routed to you take the card', () => {
    // A BLOCKED between agents waits on you (listed) but is pod's to resolve: info, never the card.
    const alone = steps(chess([onlyQueue(TO_ORCHESTRATOR)]))
    expect(alone.card).toMatchObject({ tier: 'nothing', title: 'Nothing to do', action: { kind: 'none' } })
    const toOrchestrator: NextItem = {
      key: entryKey(TO_ORCHESTRATOR),
      tier: 'info',
      status: 'blocked',
      title: 'Tool missing.',
      detail: 'engineer → orchestrator',
      entry: expect.objectContaining({ line: TO_ORCHESTRATOR, answerable: false }),
      action: { kind: 'none' },
    }
    expect(alone.rest).toEqual([toOrchestrator])

    // An answered entry is info too. The model's answered reply (continue) takes the card instead.
    const s = steps(chess([onlyQueue(TO_ORCHESTRATOR, ANSWERED)]))
    expect(s.card).toMatchObject({ tier: 'reply', title: 'Send continue', detail: 'You answered 1 entry: reply continue so pod reads it.' })
    expect(s.rest).toEqual<NextItem[]>([
      toOrchestrator,
      {
        key: entryKey(ANSWERED),
        tier: 'info',
        status: 'idle',
        title: 'Pick the step size.',
        detail: 'Your answer: 50',
        entry: expect.objectContaining({ line: ANSWERED, yourAnswer: 'Your answer: 50' }),
        action: { kind: 'none' },
      },
    ])

    // Listed first, they still follow a PENDING → human, which follows the reply.
    const withAsk = chess([onlyQueue(TO_ORCHESTRATOR, ANSWERED, H1)])
    expect(order(steps(withAsk))).toEqual([`reply reply:${PLAN}`, `pending ${entryKey(H1)}`, `info ${entryKey(TO_ORCHESTRATOR)}`, `info ${entryKey(ANSWERED)}`])
    expect(order(steps(chess([onlyQueue(TO_ORCHESTRATOR, H1)])))).toEqual([`pending ${entryKey(H1)}`, `info ${entryKey(TO_ORCHESTRATOR)}`])
  })

  it('nothing to do', () => {
    // Idle run: the status from the run, its where as the detail.
    const idle = chess([onlyQueue()])
    expect(runOf(idle).state).toBe('idle')
    expect(steps(idle)).toEqual<NextSteps>({
      card: { key: 'nothing', tier: 'nothing', status: 'idle', title: 'Nothing to do', detail: 'ladder · wave 3/3', action: { kind: 'none' } },
      rest: [],
    })
    // A running run reads running; a blocked one blocked.
    const running = chess([onlyQueue()], { agents: [engineer({ ended: false, lastAt: NOW - MIN })] })
    expect(runOf(running).state).toBe('running')
    expect(steps(running).card).toMatchObject({ tier: 'nothing', status: 'running', detail: 'ladder · wave 3/3' })
    const blocked = chess([onlyQueue(), t1Blocked])
    expect(runOf(blocked).state).toBe('blocked')
    expect(steps(blocked).card).toMatchObject({ tier: 'nothing', status: 'blocked' })

    // A needs-you run with only info entries: not running or blocked, so idle.
    expect(runOf(chess([onlyQueue(TO_ORCHESTRATOR)])).state).toBe('needs-you')
    expect(steps(chess([onlyQueue(TO_ORCHESTRATOR)])).card).toMatchObject({ tier: 'nothing', status: 'idle' })

    // An error, unsupported, or plan-less run: the empty message as the detail.
    const broken = chess([], { error: 'folder not found' })
    const brokenRun = runs(broken)[0]!
    expect(brokenRun.state).toBe('error')
    expect(nextSteps(brokenRun, broken, NOW)?.card).toEqual({
      key: 'nothing',
      tier: 'nothing',
      status: 'idle',
      title: 'Nothing to do',
      detail: emptyMessage(brokenRun, broken),
      action: { kind: 'none' },
    })
    const old: BoardRepo = { ...chess(), model: buildRepoModel(loadFixture('speak-out')) }
    const oldRun = runs(old)[0]!
    expect(oldRun.state).toBe('unsupported')
    expect(nextSteps(oldRun, old, NOW)?.card.detail).toBe(emptyMessage(oldRun, old))
    const row: RunSummary = { repoId: 'chess', repo: 'chess-web', where: 'no active plan', state: 'idle' }
    expect(nextSteps(row, chess(), NOW)?.card).toMatchObject({ tier: 'nothing', detail: 'No active plan in this repo. A plan shows here once pod starts one.' })

    // No run, no repo, or another repo's run: nothing at all.
    expect(nextSteps(undefined, chess(), NOW)).toBeUndefined()
    expect(nextSteps(runOf(chess()), undefined, NOW)).toBeUndefined()
    expect(nextSteps({ ...runOf(chess()), repoId: 'other' }, chess(), NOW)).toBeUndefined()
  })

  it('the staging → main PR is a Merge card once the final PR merged', () => {
    // The ladder sprint done, the plan claimed; final PR #80 merged into pod-staging, staging PR #91 open into main.
    const sprintDone: Edit = (f) => {
      const doc = 'pod-docs/plans/sparring-ladder.md'
      f[doc] = f[doc]!.replace(/(\| ladder \|.*\| )active( \| — \|)/, '$1done$2')
    }
    const claims: Claim[] = [{ portBase: 3100, repoPath: '/c', plan: PLAN }]
    const final = gh(80, 'merged', { branch: PLAN, base: 'pod-staging', mergedAt: NOW - 60 * MIN })
    const staging = gh(91, 'open', { branch: 'pod-staging', base: 'main', url: 'https://github.com/o/r/pull/91' })
    const repo = chess([manual, sprintDone, onlyQueue()], { claims, prs: [final, staging] })
    expect(runOf(repo).state).toBe('needs-you')
    const s = steps(repo)
    expect(s.card).toEqual<NextItem>({
      key: 'pr:91',
      tier: 'merge',
      status: 'needs-you',
      title: 'Merge PR #91',
      detail: 'The staging → main PR waits for you.',
      action: { kind: 'merge', repoId: 'chess', number: 91 },
    })
    // A blocked entry still comes first; the staging PR waits in the rest.
    const blocked = steps(chess([manual, sprintDone, onlyQueue(HALT)], { claims, prs: [final, staging] }))
    expect(blocked.card.tier).toBe('blocked')
    expect(blocked.rest.map((i) => i.key)).toContain('pr:91')
    // Closed, or merged: nothing to merge.
    for (const pr of [gh(91, 'closed', { branch: 'pod-staging', base: 'main' }), gh(91, 'merged', { branch: 'pod-staging', base: 'main', mergedAt: NOW - MIN })]) {
      expect(order(steps(chess([manual, sprintDone, onlyQueue()], { claims, prs: [final, pr] })))).not.toContain('merge pr:91')
    }
  })

  it('autopilot', () => {
    // Not halted: the wave PR is pod's to merge, so a run with nothing else has nothing to do, running.
    const working = chess([onlyQueue(), t1Pushed], { prs: [gh(78, 'open')] })
    expect(runOf(working).state).toBe('running')
    expect(steps(working)).toEqual<NextSteps>({
      card: { key: 'nothing', tier: 'nothing', status: 'running', title: 'Nothing to do', detail: 'ladder · wave 3/3', action: { kind: 'none' } },
      rest: [],
    })

    // Stopped: the halt is the card, the PR follows in rest, then the PENDING entries. No reply while a BLOCKED waits.
    const stopped = chess([t1Pushed, addQueue(HALT)], { prs: [gh(78, 'open')] })
    const s = steps(stopped)
    expect(s.card).toMatchObject({ key: entryKey(HALT), tier: 'blocked', status: 'blocked', action: { kind: 'answer', repoId: 'chess', line: HALT } })
    expect(order(s).slice(1)).toEqual(['merge pr:78', `pending ${entryKey(H1)}`, `pending ${entryKey(U1)}`, `pending ${entryKey(WAVE2)}`])

    // Stopped by a PENDING gate (gate 6 withholds a PR for you): the plan's order puts the PR first, the halt after.
    const GATE6 = entry('PENDING', 'orchestrator → human', `plan: ${PLAN}`, 'Gate 6: PR #78 is yours to merge.')
    const gate = chess([t1Pushed, onlyQueue(GATE6)], { prs: [gh(78, 'open')] })
    expect(order(steps(gate))).toEqual(['merge pr:78', `pending ${entryKey(GATE6)}`])

    // The halt answered: only the answered reply (a halted plan hides the rest), sendable once a session is safe.
    const answered = chess([t1Pushed, onlyQueue(`${HALT} **Answer (human):** rerun it`)], { prs: [gh(78, 'open')], agents: [engineer()] })
    expect(order(steps(answered))).toEqual(['merge pr:78', `reply reply:${PLAN}`, `info ${entryKey(`${HALT} **Answer (human):** rerun it`)}`])
    const reply = steps(answered).rest[0]!
    expect(reply).toMatchObject({ status: 'ready', title: 'Send continue' })
    expect(reply.action.kind === 'reply' && reply.action.panel.rows.map((r) => r.key)).toEqual(['continue'])
  })

  it('reply status', () => {
    // The final PR waiting: continue (merge first) and try. try is never sendable, so neither row sends.
    const final = chess([onlyQueue(HAND_BACK), manual], { prs: [gh(80, 'open')], agents: [engineer()] })
    const s = steps(final)
    expect(order(s)).toEqual(['merge pr:80', `reply reply:${PLAN}`, `pending ${entryKey(HAND_BACK)}`])
    const reply = s.rest[0]!
    expect(reply.status).toBe('needs-you')
    expect(reply.action.kind).toBe('reply')
    if (reply.action.kind !== 'reply') return
    expect(reply.action.panel.rows.map((r) => [r.word, r.send])).toEqual([
      ['continue', undefined],
      ['try', undefined],
    ])
    expect(reply.title).toBe('Send continue')
    expect(s.rest[0]?.detail).toBe(reply.action.panel.rows[0]?.why)

    // A sendable continue (the wave merged, a safe session): ready.
    const merged = chess([onlyQueue(), manual, t1Pushed], { prs: [gh(78, 'merged')], agents: [engineer()] })
    const card = steps(merged).card
    expect(card).toMatchObject({ key: `reply:${PLAN}`, tier: 'reply', status: 'ready', title: 'Send continue', detail: 'PR #78 merged.' })
    expect(card.action.kind === 'reply' && card.action.panel.rows[0]?.send).toBe('continue')
    // The same stop with no session: the row can't send, so it needs you.
    const noSession = chess([onlyQueue(), manual, t1Pushed], { prs: [gh(78, 'merged')] })
    expect(steps(noSession).card).toMatchObject({ tier: 'reply', status: 'needs-you' })
  })

  it('fix run and repo row', () => {
    const name = 'fix-scroll'
    const claim: Claim = { portBase: 3100, repoPath: '/c', plan: name }
    const eng = engineer({ id: 'f1', plan: undefined, sprint: undefined, slice: undefined, branch: name, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
    const rev = engineer({ id: 'f2', plan: undefined, sprint: undefined, slice: undefined, type: 'pod:reviewer', kind: 'fix', branch: name, startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })
    const repo = chess([addQueue(UNJOINED)], { claims: [claim], agents: [eng, rev], prs: [gh(36, 'open', { branch: name })] })

    // The fix run: its own PR and reply, and only the entries that join no plan.
    const fix = steps(repo, name)
    expect(order(fix)).toEqual(['merge pr:36', `reply reply:${name}`, `pending ${entryKey(UNJOINED)}`])
    expect(fix.card).toMatchObject({ title: 'Merge PR #36', detail: 'The fix PR is reviewed and waits for you.', action: { kind: 'merge', repoId: 'chess', number: 36 } })

    // The plan run never gets the fix PR, nor the fix's reply.
    expect(order(steps(repo))).toEqual([`pending ${entryKey(H1)}`, `pending ${entryKey(U1)}`, `pending ${entryKey(WAVE2)}`, `pending ${entryKey(UNJOINED)}`])

    // A repo row: only the entries that join no plan; no PR, no reply.
    const row: RunSummary = { repoId: 'chess', repo: 'chess-web', where: 'no active plan', state: 'idle' }
    const s = defined(nextSteps(row, repo, NOW))
    expect(order(s)).toEqual([`pending ${entryKey(UNJOINED)}`])
  })

  it('pending entries sort by kind: now, decision, before, other, someday', () => {
    const p = (date: string, body: string) => entry('PENDING', 'reviewer → human', `plan: ${PLAN}`, body).replace('2026-10-19', date)
    const SOMEDAY_OLD = p('2026-10-19', 'someday: trim the cache.')
    const DECISION = p('2026-10-30', 'decision: pick the port.')
    const OTHER = p('2026-10-20', 'Check the npm cache.')
    const BEFORE = p('2026-10-21', 'before hosting: add TLS.')
    const SOMEDAY_NEW = p('2026-10-22', 'someday (pod side): a field in pod.')
    const NOW_ = p('2026-10-23', 'now (product choice): the title line.')
    const DECISION_2 = p('2026-10-24', 'decision (wording): the card text.')
    const repo = chess([onlyQueue(SOMEDAY_OLD, DECISION, OTHER, BEFORE, T1_BLOCKED, SOMEDAY_NEW, NOW_, DECISION_2)])
    // The tier order stays (blocked first); inside pending, by kind, file order within a kind.
    expect(order(steps(repo))).toEqual([
      `blocked ${entryKey(T1_BLOCKED)}`,
      `pending ${entryKey(NOW_)}`,
      `pending ${entryKey(DECISION)}`,
      `pending ${entryKey(DECISION_2)}`,
      `pending ${entryKey(BEFORE)}`,
      `pending ${entryKey(OTHER)}`,
      `pending ${entryKey(SOMEDAY_OLD)}`,
      `pending ${entryKey(SOMEDAY_NEW)}`,
    ])
    // With no BLOCKED, the card is the first entry by kind, not the oldest in the file.
    const noBlock = steps(chess([onlyQueue(SOMEDAY_OLD, DECISION, NOW_)]))
    expect(noBlock.card.key).toBe(entryKey(NOW_))
    // The card's title drops the kind prefix; the kind shows as a dot and word, like the rows.
    expect(noBlock.card.title).toBe('the title line.')
    expect(noBlock.card.kind).toEqual({ cls: 's-you', label: 'now (product choice)' })
    // Answered entries are info, not pending: they stay after every pending kind (the answer brings a continue reply).
    const answered = `${SOMEDAY_OLD.replace('trim', 'cut')} **Answer (human):** later`
    expect(order(steps(chess([onlyQueue(answered, SOMEDAY_NEW)])))).toEqual([`reply reply:${PLAN}`, `pending ${entryKey(SOMEDAY_NEW)}`, `info ${entryKey(answered)}`])
  })

  it('the card shows the entry kind as a dot and word, and its title without the prefix', () => {
    const p = (type: string, body: string) => entry(type, 'reviewer → human', `plan: ${PLAN}`, body)
    const DECISION = p('PENDING', '**decision (wording):** pick the `port` label.')
    const s = steps(chess([onlyQueue(DECISION)]))
    expect(s.card).toMatchObject({ tier: 'pending', status: 'needs-you', title: 'pick the port label.', kind: { cls: 's-run', label: 'decision (wording)' } })
    // A BLOCKED entry keeps its blocked status; its kind shows beside it.
    const BLOCKED_NOW = p('BLOCKED', 'now: the rates file is missing.')
    expect(steps(chess([onlyQueue(BLOCKED_NOW)])).card).toMatchObject({ tier: 'blocked', status: 'blocked', title: 'the rates file is missing.', kind: { cls: 's-you', label: 'now' } })
    // No kind word: no kind on the card (a BLOCKED one already says blocked), and the whole body as title.
    const plain = steps(chess([onlyQueue(T1_BLOCKED)])).card
    expect(plain.title).toBe("T1 can't reach the rates file.")
    expect(plain).not.toHaveProperty('kind')
    // A gate halt keeps its sentence and has no kind.
    const halt = steps(chess([onlyQueue(HALT)])).card
    expect(halt.title).toBe('Autopilot stopped: a slice is blocked')
    expect(halt).not.toHaveProperty('kind')
    // Merge, reply and nothing cards never carry a kind.
    const merge = steps(chess([manual, t1Pushed, onlyQueue()], { prs: [gh(78, 'open')] }))
    expect(merge.card.action.kind).toBe('merge')
    expect(merge.card).not.toHaveProperty('kind')
    expect(merge.rest.every((i) => i.kind === undefined)).toBe(true)
    expect(steps(chess([onlyQueue()])).card).not.toHaveProperty('kind')
  })

  it('stable keys', () => {
    // Two Boards with the same items: the same keys.
    const a = steps(chess([manual, t1Pushed, addQueue(T1_BLOCKED)], { prs: [gh(78, 'open')] }))
    const b = steps(chess([manual, t1Pushed, addQueue(T1_BLOCKED)], { prs: [gh(78, 'open')] }))
    expect(order(b)).toEqual(order(a))
    // An entry added before them doesn't move any key (unlike a row index).
    const moved = steps(chess([manual, t1Pushed, onlyQueue(TO_ORCHESTRATOR, H1, U1, WAVE2, T1_BLOCKED)], { prs: [gh(78, 'open')] }))
    for (const key of order(a).map((x) => x.split(' ')[1])) expect(order(moved).map((x) => x.split(' ')[1])).toContain(key)

    // A repeated line gets #2, then #3, in list order; every key is unique.
    const twice = steps(chess([onlyQueue(T1_BLOCKED, H1, T1_BLOCKED, T1_BLOCKED)]))
    expect(order(twice)).toEqual([
      `blocked ${entryKey(T1_BLOCKED)}`,
      `blocked ${entryKey(T1_BLOCKED)}#2`,
      `blocked ${entryKey(T1_BLOCKED)}#3`,
      `pending ${entryKey(H1)}`,
    ])
    expect(twice.card.title).toBe("T1 can't reach the rates file.")
  })
})

describe('gate titles', () => {
  const URL = 'https://github.com/iamphduc/pod-trial/pull/9'
  it('says each autopilot halt in a plain sentence', () => {
    expect(gateTitle('gate 1 blocked-concern: T1 is blocked, the rates file is missing.')).toEqual({ title: 'Autopilot stopped: a slice is blocked' })
    expect(gateTitle('gate 2 plan-review-fail: round 2 still fails')).toEqual({ title: 'Autopilot stopped: the final review still fails' })
    expect(gateTitle(`gate 3 auto-merge-fail: wave PR ${URL} has no passing CI`)).toEqual({
      title: "Autopilot stopped: wave PR #9 couldn't merge",
      link: { text: 'PR #9', href: URL },
    })
    expect(gateTitle(`gate 3 auto-merge-fail: final PR ${URL} is behind`)).toEqual({
      title: "Autopilot stopped: final PR #9 couldn't merge",
      link: { text: 'PR #9', href: URL },
    })
    expect(gateTitle('gate 4 inter-wave-verify: the wave 2 check failed')).toEqual({ title: 'Autopilot stopped: the wave check failed' })
    expect(gateTitle('gate 5 safety-bound: 6 hours')).toEqual({ title: 'Autopilot stopped: it hit a safety limit' })
    expect(gateTitle(`gate 6 escalation-valve: ${URL} is mergeable`)).toEqual({
      title: 'Autopilot held PR #9 for you to merge',
      link: { text: 'PR #9', href: URL },
    })
    expect(gateTitle('gate 7 plan-complete: staging PR open')).toEqual({ title: 'Plan complete: review and merge the staging PR' })
    // By name alone.
    expect(gateTitle('safety-bound: 6 hours')).toEqual({ title: 'Autopilot stopped: it hit a safety limit' })
  })

  it('names a PR given as #N without a link, and leaves wave/final out when the entry says neither', () => {
    expect(gateTitle('gate 3 auto-merge-fail: PR #78 has no passing CI')).toEqual({ title: "Autopilot stopped: PR #78 couldn't merge" })
    expect(gateTitle('gate 6 escalation-valve: #12 waits')).toEqual({ title: 'Autopilot held PR #12 for you to merge' })
  })

  it('falls back to the cut text when the gate or its PR cannot be read', () => {
    // Gates 3 and 6 need their PR.
    expect(gateTitle('gate 3 auto-merge-fail: CI is red')).toBeUndefined()
    expect(gateTitle('gate 6 escalation-valve: held')).toBeUndefined()
    // Not a halt.
    expect(gateTitle('Pick the step size.')).toBeUndefined()
    expect(gateTitle('now: gate 3 later')).toBeUndefined()
  })

  it('the card uses the sentence for a gate entry; other entries keep their text', () => {
    const halt = `- \`[2026-10-19 · BLOCKED · orchestrator → human · plan: ${PLAN}]\` gate 3 auto-merge-fail: wave PR ${URL} has no passing CI and more words that go on past the cut **Resolution:** pending`
    const s = steps(chess([onlyQueue(halt)]))
    expect(s.card.title).toBe("Autopilot stopped: wave PR #9 couldn't merge")
    expect(s.card.titleLink).toEqual({ text: 'PR #9', href: URL })
    // The full text stays on the entry, for the Waiting tab and the open Answer form.
    expect(s.card.entry?.body).toContain('has no passing CI and more words')
    // A non-gate entry keeps its own text and has no link.
    const plain = steps(chess([onlyQueue(T1_BLOCKED)]))
    expect(plain.card.title).toBe("T1 can't reach the rates file.")
    expect(plain.card).not.toHaveProperty('titleLink')
  })
})
