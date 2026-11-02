import { describe, expect, it } from 'vitest'
import * as model from './index.ts'
import type { AgentRun, Board, BoardRepo, Claim, PrStatus } from './board.ts'
import { autoSends, sendableFrom, sendableReply, type AutoToggle, repoPathKey } from './auto-continue.ts'
import { SEND_SIGNALS, runReplies, type ReplySignal, type ReplyWord, type RunReply } from './replies.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 9, 22, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string]

function planDoc(slug: string, sprints: SprintRow[], status = 'active'): string {
  return [
    `# Plan: ${slug}`,
    '',
    `_Generated: 2026-10-22 · Status: ${status} · Grilled-with: grilling_`,
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
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-10-22_`,
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

function files(opts: Opts = {}, plan = 'alpha'): RepoFiles {
  const out: RepoFiles = {
    'pod-docs/README.md': README,
    [`pod-docs/plans/${plan}.md`]: planDoc(plan, opts.sprints ?? [['one', 'active']], opts.status),
    'pod-docs/handoff-queue.md': (opts.queue ?? []).join('\n'),
  }
  for (const [s, rows] of Object.entries(opts.docs ?? {})) out[`pod-docs/sprints/${s}.md`] = sprintDoc(s, plan, rows)
  return out
}

let seq = 0
function ended(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: true, startedAt: NOW - 60 * MIN, lastAt: NOW - 40 * MIN, ...over }
}

const link = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })
const claim = (plan: string): Claim => ({ portBase: 3100, repoPath: '/r', plan })
const handBack = (n: number) =>
  `- \`[2026-10-22 · PENDING · orchestrator → human · plan: alpha]\` Plan complete: merge https://github.com/o/r/pull/${n} **Resolution:** pending`

/** A pod halt, as the orchestrator writes it, and the same line with your answer at its end. */
const HALT = '- `[2026-10-22 · BLOCKED · orchestrator → human · plan: alpha]` Halted at gate 1. **Resolution:** pending'
const answered = (line: string, text = 'retry') => `${line} **Answer (human):** ${text}`
const DECISION = '- `[2026-10-22 · PENDING · orchestrator → human · plan: alpha · sprint: one]` Pick a format. **Resolution:** pending'
/** Sprint one in progress: no other reply. */
const WORK: BoardRow[] = [[1, 'A1', '—', 'in progress']]

const PUSHED: BoardRow[] = [
  [1, 'A1', `${link(5)} merged`, 'done'],
  [2, 'B1', link(7), 'pushed'],
]
const DONE: Opts = { sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] }, queue: [handBack(12)] }
const BETWEEN: Opts = { sprints: [['one', 'done'], ['two', 'planned']], docs: { one: [[1, 'A1', 'merged', 'done']] } }
const FRESH: Opts = { sprints: [['one', 'planned'], ['two', 'planned']] }

/** A repo whose plan alpha has one ended agent in `session`. */
function planRepo(opts: Opts, extra: Partial<BoardRepo> = {}, session = 'sess-1', id = 'id-r'): BoardRepo {
  return {
    id,
    name: 'r',
    path: '/r',
    source: 'registered',
    model: buildRepoModel(files(opts)),
    agents: [ended({ plan: 'alpha', session })],
    prs: [],
    claims: [],
    ...extra,
  }
}

const FIX = 'fix-scroll'
function fixRepo(state: PrStatus['state'], session = 'sess-1'): BoardRepo {
  const eng = ended({ branch: FIX, session, startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
  const rev = ended({ type: 'pod:reviewer', kind: 'fix', branch: FIX, session, startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })
  return {
    id: 'id-r',
    name: 'r',
    path: '/r',
    source: 'registered',
    model: buildRepoModel({ 'pod-docs/README.md': README }),
    agents: [eng, rev],
    prs: [gh(36, state, { branch: FIX })],
    claims: [claim(FIX)],
  }
}

/** One fixture per signal, each with the run it's on. */
const BY_SIGNAL: Record<ReplySignal, { repo: BoardRepo; run: string }> = {
  'wave-waiting': { repo: planRepo({ docs: { one: PUSHED } }), run: 'alpha' },
  'wave-merged': { repo: planRepo({ docs: { one: PUSHED } }, { prs: [gh(7, 'merged')] }), run: 'alpha' },
  'sprint-done': { repo: planRepo(BETWEEN), run: 'alpha' },
  'final-waiting': { repo: planRepo(DONE), run: 'alpha' },
  'final-merged': { repo: planRepo(DONE, { claims: [claim('alpha')], prs: [gh(12, 'merged')] }), run: 'alpha' },
  'not-started': { repo: planRepo(FRESH), run: 'alpha' },
  'fix-waiting': { repo: fixRepo('open'), run: FIX },
  'fix-merged': { repo: fixRepo('merged'), run: FIX },
  answered: { repo: planRepo({ docs: { one: WORK }, queue: [answered(HALT)] }), run: 'alpha' },
}
const SIGNALS = Object.keys(BY_SIGNAL) as ReplySignal[]
const WORDS: ReplyWord[] = ['continue', 'go', 'try']

const board = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos })
const always = () => true
const keyOf = (s: ReplySignal) => {
  const { repo, run } = BY_SIGNAL[s]
  return runReplies(repo, run, NOW).find((r) => r.signal === s)!.key
}

describe('fixtures', () => {
  it('give each signal', () => {
    for (const s of SIGNALS) {
      const { repo, run } = BY_SIGNAL[s]
      expect(runReplies(repo, run, NOW).map((r) => r.signal), s).toContain(s)
    }
  })
})

describe('sendableReply', () => {
  it('continue only where pod waits for it', () => {
    for (const s of SIGNALS) {
      const { repo, run } = BY_SIGNAL[s]
      const got = sendableReply(repo, run, 'continue', NOW)
      if (SEND_SIGNALS.has(s)) {
        expect(got, s).toMatchObject({ reply: 'continue', signal: s })
        expect(got?.key, s).toBe(keyOf(s))
      } else expect(got, s).toBeUndefined()
    }
    for (const s of ['wave-waiting', 'final-waiting', 'fix-waiting'] as const) {
      expect(sendableReply(BY_SIGNAL[s].repo, BY_SIGNAL[s].run, 'continue', NOW), s).toBeUndefined()
    }
    // Not a run, or a run with no replies: nothing.
    expect(sendableReply(BY_SIGNAL['wave-merged'].repo, 'beta', 'continue', NOW)).toBeUndefined()
  })

  it('go only on a fresh plan, try never', () => {
    for (const s of SIGNALS) {
      const { repo, run } = BY_SIGNAL[s]
      const got = sendableReply(repo, run, 'go', NOW)
      if (s === 'not-started') expect(got, s).toEqual({ reply: 'go', signal: 'not-started', why: 'Only if pod asked for go.', key: 'not-started:alpha' })
      else expect(got, s).toBeUndefined()
      // try is never a sendable word, even where pod offers it; the type forbids it, so cast.
      expect(sendableReply(repo, run, 'try' as 'go', NOW), s).toBeUndefined()
    }
    // final-waiting really offers try, and still nothing is sendable there.
    expect(runReplies(BY_SIGNAL['final-waiting'].repo, 'alpha', NOW).map((r) => r.reply)).toContain('try')
  })

  it('picks by word and signal over every reply kind', () => {
    // Every word × signal pair, even ones runReplies never gives.
    const all: RunReply[] = WORDS.flatMap((reply) => SIGNALS.map((signal) => ({ reply, signal, why: 'w', key: `${reply}-${signal}` })))
    for (const r of all) {
      const c = sendableFrom([r], 'continue')
      const g = sendableFrom([r], 'go')
      const t = sendableFrom([r], 'try' as 'go')
      expect(c, r.key).toEqual(r.reply === 'continue' && SEND_SIGNALS.has(r.signal) ? r : undefined)
      expect(g, r.key).toEqual(r.reply === 'go' && r.signal === 'not-started' ? r : undefined)
      expect(t, r.key).toBeUndefined()
    }
    // The whole list at once: continue finds a send-signal continue, go finds the go.
    expect(sendableFrom(all, 'continue')?.reply).toBe('continue')
    expect(SEND_SIGNALS.has(sendableFrom(all, 'continue')!.signal)).toBe(true)
    expect(sendableFrom(all, 'go')).toMatchObject({ reply: 'go', signal: 'not-started' })
    expect(sendableFrom([], 'continue')).toBeUndefined()
  })

  it('is exported from the package entry', () => {
    expect(model.sendableReply).toBe(sendableReply)
    expect(model.autoSends).toBe(autoSends)
  })
})

describe('autoSends', () => {
  const toggle = (run: string, lastKey?: string, repoId = 'id-r'): AutoToggle => (lastKey === undefined ? { repoId, run } : { repoId, run, lastKey })

  it('a toggle acts only on the repo at its path, whatever the repo’s id is now', () => {
    const repo = planRepo(BETWEEN)
    expect(autoSends(board(repo), [{ path: '/r', run: 'alpha' }], NOW, always).map((s) => s.repoId)).toEqual(['id-r'])
    expect(autoSends(board({ ...repo, id: 'other-id' }), [{ path: '/r', run: 'alpha' }], NOW, always).map((s) => s.repoId)).toEqual(['other-id'])
    expect(autoSends(board({ ...repo, path: '/r_2' }), [{ path: '/r', run: 'alpha' }], NOW, always)).toEqual([])
  })

  it('repoPathKey folds case only where the file system ignores it', () => {
    expect(repoPathKey({ path: 'E:\\X', caseless: true })).toBe('e:\\x')
    expect(repoPathKey({ path: '/X' })).toBe('/X')
  })

  it('sends nothing on a session the board cannot prove is the repo’s', () => {
    const repo = planRepo(BETWEEN, { agents: [ended({ plan: 'alpha', session: 'sess-1', sessionUnproven: true })] })
    expect(autoSends(board(repo), [{ path: '/r', run: 'alpha' }], NOW, always)).toEqual([])
  })

  it('never sends go', () => {
    // Every signal, every kind of lastKey (none, its own key, another key, a go or try key): only send-signal continues.
    let sent = 0
    for (const s of SIGNALS) {
      const { repo, run } = BY_SIGNAL[s]
      const lastKeys = [undefined, 'other', 'not-started:alpha', 'try:alpha', ...runReplies(repo, run, NOW).map((r) => r.key)]
      for (const lastKey of lastKeys) {
        const out = autoSends(board(repo), [toggle(run, lastKey)], NOW, always)
        for (const a of out) {
          const reply = runReplies(repo, run, NOW).find((r) => r.key === a.key)
          expect(reply?.reply, `${s} ${lastKey}`).toBe('continue')
          expect(SEND_SIGNALS.has(reply!.signal), `${s} ${lastKey}`).toBe(true)
          expect(a.key).not.toMatch(/^(not-started|try):/)
        }
        sent += out.length
      }
    }
    // The toggle does send where it should, so the loop above checked real sends.
    expect(sent).toBeGreaterThan(0)
    // A fresh plan with the toggle on: nothing, however lastKey is set.
    const fresh = BY_SIGNAL['not-started'].repo
    expect(autoSends(board(fresh), [toggle('alpha'), toggle('alpha', 'not-started:alpha')], NOW, always)).toEqual([])
    // A pending hand-back offers try: nothing.
    expect(autoSends(board(BY_SIGNAL['final-waiting'].repo), [toggle('alpha')], NOW, always)).toEqual([])
  })

  it('sends only for toggled runs', () => {
    const { repo } = BY_SIGNAL['wave-merged']
    expect(autoSends(board(repo), [], NOW, always)).toEqual([])
    expect(autoSends(board(repo), [toggle('beta')], NOW, always)).toEqual([])
    expect(autoSends(board(repo), [toggle('alpha')], NOW, always)).toEqual([{ repoId: 'id-r', run: 'alpha', session: 'sess-1', key: 'wave-merged:7' }])
    // Each send signal sends with its own key; a fix run too.
    for (const s of [...SEND_SIGNALS]) {
      const f = BY_SIGNAL[s]
      expect(autoSends(board(f.repo), [toggle(f.run)], NOW, always), s).toEqual([{ repoId: 'id-r', run: f.run, session: 'sess-1', key: keyOf(s) }])
    }
  })

  it('sends final-merged on an archived close-out', () => {
    // pod archives the plan before the final merge; the merge comes long after the plan's last agent wrote.
    const old = [ended({ plan: 'alpha', session: 'sess-1', lastAt: NOW - 120 * MIN })]
    const closing = (state: PrStatus['state']) => planRepo({ ...DONE, status: 'archived' }, { claims: [claim('alpha')], agents: old, prs: [gh(12, state)] })
    expect(sendableReply(closing('merged'), 'alpha', 'continue', NOW)).toMatchObject({ reply: 'continue', signal: 'final-merged', key: 'final-merged:12' })
    expect(autoSends(board(closing('merged')), [toggle('alpha')], NOW, always)).toEqual([{ repoId: 'id-r', run: 'alpha', session: 'sess-1', key: 'final-merged:12' }])
    expect(autoSends(board(closing('merged')), [toggle('alpha', 'final-merged:12')], NOW, always)).toEqual([])
    // Not merged yet: nothing to send.
    expect(autoSends(board(closing('open')), [toggle('alpha')], NOW, always)).toEqual([])
  })

  it('one send per stop', () => {
    const { repo } = BY_SIGNAL['wave-merged']
    expect(autoSends(board(repo), [toggle('alpha', 'wave-merged:7')], NOW, always)).toEqual([])
    // The next stop has a new key: sent.
    expect(autoSends(board(repo), [toggle('alpha', 'wave-merged:5')], NOW, always)).toHaveLength(1)
    const done = BY_SIGNAL['sprint-done'].repo
    expect(autoSends(board(done), [toggle('alpha', 'wave-merged:7')], NOW, always)).toEqual([
      { repoId: 'id-r', run: 'alpha', session: 'sess-1', key: 'sprint-done:one' },
    ])
    expect(autoSends(board(done), [toggle('alpha', 'sprint-done:one')], NOW, always)).toEqual([])
  })

  it('sends an answered stop once per set of answers', () => {
    const at = (queue: string[]) => planRepo({ docs: { one: WORK }, queue })
    const first = autoSends(board(at([answered(HALT)])), [toggle('alpha')], NOW, always)
    expect(first).toHaveLength(1)
    expect(first[0]!.key).toMatch(/^answered:alpha:1:/)
    // The same answers after a send: nothing again.
    expect(autoSends(board(at([answered(HALT)])), [toggle('alpha', first[0]!.key)], NOW, always)).toEqual([])
    // pod resumed, applied them, and stopped on a new gate you answered: a new key, sent.
    const applied = answered(HALT).replace('**Resolution:** pending', '**Resolution:** 2026-10-22 — retried')
    const next = autoSends(board(at([applied, answered(DECISION, 'json')])), [toggle('alpha', first[0]!.key)], NOW, always)
    expect(next).toHaveLength(1)
    expect(next[0]!.key).not.toBe(first[0]!.key)
    // The halt not answered yet: nothing, even with an answered PENDING.
    expect(autoSends(board(at([HALT, answered(DECISION)])), [toggle('alpha')], NOW, always)).toEqual([])
    // An open PENDING beside the answered halt doesn't hold it back, nor change its key.
    expect(autoSends(board(at([answered(HALT), DECISION])), [toggle('alpha')], NOW, always)).toEqual(first)
    // Busy session: nothing.
    expect(autoSends(board(at([answered(HALT)])), [toggle('alpha')], NOW, () => false)).toEqual([])
  })

  it('never auto-sends the same answered key twice', () => {
    // A pod that never rewrites the Resolution shows the same answered key at every later stop.
    const repo = planRepo({ docs: { one: WORK }, queue: [answered(HALT)] })
    const key = keyOf('answered')
    // It sent the answered key, then another stop (lastKey moved on): still not sent again.
    const sent: AutoToggle = { repoId: 'id-r', run: 'alpha', lastKey: 'sprint-done:one', answeredKeys: [key] }
    expect(autoSends(board(repo), [sent], NOW, always)).toEqual([])
    // Another answered key on record doesn't stop this one.
    expect(autoSends(board(repo), [{ ...sent, answeredKeys: ['answered:alpha:1:00000000'] }], NOW, always)).toEqual([
      { repoId: 'id-r', run: 'alpha', session: 'sess-1', key },
    ])
    // Other signals don't read the record.
    const merged = BY_SIGNAL['wave-merged']
    expect(autoSends(board(merged.repo), [{ repoId: 'id-r', run: 'alpha', answeredKeys: ['wave-merged:7'] }], NOW, always)).toHaveLength(1)
  })

  it('skips busy or unknown sessions', () => {
    const { repo } = BY_SIGNAL['wave-merged']
    const t = [toggle('alpha')]
    // Sanity: this fixture sends when idle.
    expect(autoSends(board(repo), t, NOW, always)).toHaveLength(1)
    // Not idle.
    expect(autoSends(board(repo), t, NOW, () => false)).toEqual([])
    // The idle check gets the repo and the session.
    const asked: [string, string][] = []
    autoSends(board(repo), t, NOW, (r, s) => (asked.push([r.id, s]), true))
    expect(asked).toEqual([['id-r', 'sess-1']])
    // No session: no agent wrote.
    expect(autoSends(board({ ...repo, agents: [] }), t, NOW, always)).toEqual([])
    // An unsafe id has no resume: no send, and the idle check never sees it.
    for (const id of ['bad id', '$(whoami)', 'a'.repeat(65), '../x']) {
      const calls: string[] = []
      const r = planRepo({ docs: { one: PUSHED } }, { prs: [gh(7, 'merged')] }, id)
      expect(autoSends(board(r), t, NOW, (_r, s) => (calls.push(s), true)), id).toEqual([])
      expect(calls, id).toEqual([])
    }
    // Run not listed (no such plan), or the repo is gone from the Board.
    expect(autoSends(board(repo), [toggle('gone')], NOW, always)).toEqual([])
    expect(autoSends(board(repo), [toggle('alpha', undefined, 'id-gone')], NOW, always)).toEqual([])
    expect(autoSends(board(), t, NOW, always)).toEqual([])
  })

  it('one send per session', () => {
    // Two repos' runs on one session: the first toggle wins.
    const a = BY_SIGNAL['wave-merged'].repo
    const b = { ...planRepo(BETWEEN), id: 'id-b' }
    const out = autoSends(board(a, b), [toggle('alpha'), toggle('alpha', undefined, 'id-b')], NOW, always)
    expect(out).toEqual([{ repoId: 'id-r', run: 'alpha', session: 'sess-1', key: 'wave-merged:7' }])
    // The same run toggled twice: one send.
    expect(autoSends(board(a), [toggle('alpha'), toggle('alpha')], NOW, always)).toHaveLength(1)
    // Different sessions: one each.
    const c = { ...planRepo(BETWEEN, {}, 'sess-2'), id: 'id-b' }
    expect(autoSends(board(a, c), [toggle('alpha'), toggle('alpha', undefined, 'id-b')], NOW, always).map((x) => x.session)).toEqual(['sess-1', 'sess-2'])
    // A busy first session doesn't stop the second.
    expect(autoSends(board(a, c), [toggle('alpha'), toggle('alpha', undefined, 'id-b')], NOW, (_r, s) => s === 'sess-2').map((x) => x.session)).toEqual(['sess-2'])
  })
})
