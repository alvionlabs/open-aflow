import { describe, expect, it } from 'vitest'
import { buildRepoModel, runReplies, type AgentRun, type BoardRepo, type Claim, type PrStatus, type ReplySignal, type RunSummary } from '@open-aflow/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NO_SESSION, replyPanel } from './reply-view.ts'
import { ReplyChat, ReplyPanel } from './ReplyPanel.tsx'

const NOW = Date.UTC(2026, 9, 21, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

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

const SPRINT = [
  '# Sprint: one',
  '',
  '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-10-21_',
  '',
  '## Status board',
  '',
  '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
  '|------|-------|-------|--------|----|--------|------------|------------|',
  '| 1 | A1 | Title | one-A1 | [#7](https://github.com/o/r/pull/7) | pushed | medium | — |',
  '',
].join('\n')

const PATH = 'E:\\Projects\\some repo with a long folder name'

function repo(agents: AgentRun[] = [], path = PATH): BoardRepo {
  const model = buildRepoModel({ 'pod-docs/README.md': README, 'pod-docs/plans/alpha.md': PLAN, 'pod-docs/sprints/one.md': SPRINT })
  return { id: 'id-r', name: 'r', path, source: 'registered', model, agents, prs: [], claims: [] }
}

const agent = (over: Partial<AgentRun>): AgentRun => ({ id: 'a1', session: 's', type: 'pod:engineer', tokens: 0, ended: true, plan: 'alpha', ...over })
const run = (over: Partial<RunSummary> = {}): RunSummary => ({ repoId: 'id-r', repo: 'r', plan: 'alpha', where: 'one · wave 1/1', state: 'needs-you', ...over })

const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('reply panel', () => {
  it('offers no send button for a session the board cannot prove is the repo’s', () => {
    const view = replyPanel(run(), repo([agent({ session: 's1', lastAt: NOW - 40 * MIN, sessionUnproven: true })]), NOW)
    expect(view?.rows.every((r) => r.send === undefined)).toBe(true)
    expect(view?.session?.resume).toBeUndefined()
  })

  describe('the copied cd command', () => {
    const cdFor = (path: string) => replyPanel(run(), repo([agent({ session: 's1', lastAt: NOW - 40 * MIN })], path), NOW)?.session?.cd

    it('a Windows path keeps its double quotes', () => {
      expect(cdFor(PATH)).toBe('cd "E:\\Projects\\some repo with a long folder name"')
      expect(cdFor('C:/work/repo')).toBe('cd "C:/work/repo"')
    })

    it('a Windows path a shell could run part of gets no cd line', () => {
      for (const ch of ['$', '(', ')', '`']) {
        expect(cdFor(`E:\\Projects\\a${ch}b`), ch).toBeUndefined()
      }
      expect(cdFor('E:\\Projects\\$(calc)')).toBeUndefined()
      expect(cdFor('C:/work/a$b')).toBeUndefined()
    })

    it('a Windows path with a curly double quote gets no cd line: PowerShell reads it as closing the string', () => {
      for (const ch of ['\u201C', '\u201D', '\u201E']) {
        expect(cdFor(`E:\\Projects\\x${ch}; calc; ${ch}y`), ch).toBeUndefined()
      }
    })

    it('other characters that are plain inside the quotes keep the cd line', () => {
      for (const p of ['E:\\a&b', 'E:\\a;b', 'E:\\a%b', 'E:\\a%USERNAME%b', "E:\\it's", 'E:\\a!b', 'E:\\a\u2019b']) {
        expect(cdFor(p), p).toBe(`cd "${p}"`)
      }
    })

    it('an unsafe Windows path shows the folder, no cd in any row, and no empty row', () => {
      const unsafe = 'E:\\Projects\\a$(calc)'
      const panel = (id: string) => replyPanel(run(), repo([agent({ session: id, lastAt: NOW - 40 * MIN })], unsafe), NOW)!
      const withResume = renderToStaticMarkup(createElement(ReplyChat, { view: panel('s1') }))
      expect(withResume).not.toContain('aria-label="Copy cd command"')
      expect(withResume).not.toContain('cd &quot;')
      expect(withResume).toContain(unsafe)
      expect(withResume).toContain('claude --resume s1')
      // One row per command that exists: the resume line only.
      expect(withResume.match(/class="reply-cmd"/g)).toHaveLength(1)
      // Neither command: no row at all, only the session line and the folder.
      const bare = renderToStaticMarkup(createElement(ReplyChat, { view: panel('odd id') }))
      expect(bare).not.toContain('class="reply-cmd"')
      expect(bare).toContain(unsafe)
    })

    it('a safe path keeps its cd row and shows no extra folder line', () => {
      const chat = renderToStaticMarkup(createElement(ReplyChat, { view: replyPanel(run(), repo([agent({ session: 's1', lastAt: NOW - 40 * MIN })]), NOW)! }))
      expect(chat).toContain('aria-label="Copy cd command"')
      expect(chat).not.toContain('reply-folder')
    })

    it('a POSIX path is single-quoted, so the shell runs nothing in it', () => {
      expect(cdFor('/home/me/some repo')).toBe("cd '/home/me/some repo'")
      // `$(x)`, a backtick, `"` and `!` are plain text inside single quotes; a `'` closes, escapes, and reopens.
      expect(cdFor('/tmp/a$(touch x)`id`"b"!c')).toBe(`cd '/tmp/a$(touch x)\`id\`"b"!c'`)
      const Q = "'\\''" // a `'` inside single quotes: close, escaped quote, reopen
      expect(cdFor("/tmp/it's here")).toBe(`cd '/tmp/it${Q}s here'`)
      expect(cdFor("/tmp/''")).toBe(`cd '/tmp/${Q}${Q}'`)
    })
  })

  it('rows keep word, why, and session lines', () => {
    const start = NOW - 50 * MIN
    const id = '0f6c1e2a-5b7d-4c11-9a3e-2d4f6b8c0e1a'
    const view = replyPanel(run(), repo([agent({ session: id, startedAt: start, lastAt: NOW - 40 * MIN })]), NOW)
    // The word, its why, and the chat: session line, its first agent's time, cd and resume.
    expect(view).toEqual({
      target: { repoId: 'id-r', run: 'alpha' },
      rows: [{ key: 'continue', word: 'continue', why: 'Merge PR #7, then reply continue.' }],
      session: { line: `Session ${id}`, time: `first agent ${clock(start)}`, path: PATH, cd: `cd "${PATH}"`, resume: `claude --resume ${id}` },
    })

    // No start known: no time. An id outside the pattern: no resume line, only the id.
    const odd = replyPanel(run(), repo([agent({ session: 'odd id', startedAt: undefined, lastAt: NOW - 40 * MIN })]), NOW)
    expect(odd?.session).toEqual({ line: 'Session odd id', path: PATH, cd: `cd "${PATH}"` })

    // No session: the no-session text instead.
    const none = replyPanel(run(), repo(), NOW)
    expect(none).toEqual({ target: { repoId: 'id-r', run: 'alpha' }, rows: [{ key: 'continue', word: 'continue', why: 'Merge PR #7, then reply continue.' }], noSession: NO_SESSION })

    // A row with a send button keeps its word and why, and the session lines stay as they were.
    const sendable = repo([agent({ session: id, startedAt: start, lastAt: NOW - 40 * MIN })])
    sendable.prs = [{ number: 7, state: 'merged', checks: 'pass', checkedAt: NOW }]
    expect(replyPanel(run(), sendable, NOW)).toEqual({
      target: { repoId: 'id-r', run: 'alpha' },
      rows: [{ key: 'continue', word: 'continue', why: 'PR #7 merged.', send: 'continue' }],
      session: { line: `Session ${id}`, time: `first agent ${clock(start)}`, path: PATH, cd: `cd "${PATH}"`, resume: `claude --resume ${id}` },
    })
    expect(NO_SESSION).toBe('No pod session found for this run. Paste it in the chat that runs it.')

    // A sendable row with no session gets no button: the route could only answer no session.
    const lone = repo()
    lone.prs = [{ number: 7, state: 'merged', checks: 'pass', checkedAt: NOW }]
    expect(replyPanel(run(), lone, NOW)).toEqual({
      target: { repoId: 'id-r', run: 'alpha' },
      rows: [{ key: 'continue', word: 'continue', why: 'PR #7 merged.' }],
      noSession: NO_SESSION,
    })

    // Nothing for a repo row, no run, no repo, or a run with no reply.
    expect(replyPanel(run({ plan: undefined, where: 'no active plan', state: 'idle' }), repo(), NOW)).toBeUndefined()
    expect(replyPanel(undefined, repo(), NOW)).toBeUndefined()
    expect(replyPanel(run(), undefined, NOW)).toBeUndefined()
    const working = repo([agent({ sprint: 'one', slice: 'A1', ended: false, startedAt: NOW - 5 * MIN, lastAt: NOW - MIN })])
    expect(replyPanel(run(), working, NOW)).toBeUndefined()
  })
})

// One fixture per signal, the same shapes as the model's auto-continue tests.

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string]

const planDoc = (sprints: SprintRow[]) =>
  [
    '# Plan: alpha',
    '',
    '_Generated: 2026-10-22 · Status: active · Grilled-with: grilling_',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, st]) => `| ${s} | goal | ${st} | — |`),
    '',
  ].join('\n')

const sprintDoc = (slug: string, rows: BoardRow[]) =>
  [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/alpha.md · Slug: ${slug} · Status: active · Generated: 2026-10-22_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    ...rows.map(([w, code, pr, status]) => `| ${w} | ${code} | Title | ${slug}-${code} | ${pr} | ${status} | medium | — |`),
    '',
  ].join('\n')

type Opts = { sprints?: SprintRow[]; docs?: Record<string, BoardRow[]>; queue?: string[] }
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })
const claim = (plan: string): Claim => ({ portBase: 3100, repoPath: '/r', plan })
const link = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`
const handBack = (n: number) =>
  `- \`[2026-10-22 · PENDING · orchestrator → human · plan: alpha]\` Plan complete: merge https://github.com/o/r/pull/${n} **Resolution:** pending`

function planRepo(opts: Opts, extra: Partial<BoardRepo> = {}): BoardRepo {
  const files: Record<string, string> = {
    'pod-docs/README.md': README,
    'pod-docs/plans/alpha.md': planDoc(opts.sprints ?? [['one', 'active']]),
    'pod-docs/handoff-queue.md': (opts.queue ?? []).join('\n'),
  }
  for (const [s, rows] of Object.entries(opts.docs ?? {})) files[`pod-docs/sprints/${s}.md`] = sprintDoc(s, rows)
  const a = agent({ session: 'sess-1', startedAt: NOW - 60 * MIN, lastAt: NOW - 40 * MIN })
  return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(files), agents: [a], prs: [], claims: [], ...extra }
}

const FIX = 'fix-scroll'
function fixRepo(state: PrStatus['state']): BoardRepo {
  const eng = agent({ id: 'e1', plan: undefined, branch: FIX, session: 'sess-1', startedAt: NOW - 90 * MIN, lastAt: NOW - 60 * MIN })
  const rev = agent({ id: 'r1', plan: undefined, type: 'pod:reviewer', kind: 'fix', branch: FIX, session: 'sess-1', startedAt: NOW - 50 * MIN, lastAt: NOW - 5 * MIN })
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

const HALT = '- `[2026-10-22 · BLOCKED · orchestrator → human · plan: alpha]` Halted at gate 1. **Resolution:** pending'

const PUSHED: BoardRow[] = [
  [1, 'A1', `${link(5)} merged`, 'done'],
  [2, 'B1', link(7), 'pushed'],
]
const DONE: Opts = { sprints: [['one', 'done']], docs: { one: [[1, 'A1', 'merged', 'done']] }, queue: [handBack(12)] }
const BETWEEN: Opts = { sprints: [['one', 'done'], ['two', 'planned']], docs: { one: [[1, 'A1', 'merged', 'done']] } }
const FRESH: Opts = { sprints: [['one', 'planned'], ['two', 'planned']] }

type Sends = Partial<Record<string, 'continue' | 'go'>>
/** Each signal's repo and run, with the send each word's row gets. */
const BY_SIGNAL: Record<ReplySignal, { repo: BoardRepo; run: string; sends: Sends }> = {
  'wave-waiting': { repo: planRepo({ docs: { one: PUSHED } }), run: 'alpha', sends: {} },
  'wave-merged': { repo: planRepo({ docs: { one: PUSHED } }, { prs: [gh(7, 'merged')] }), run: 'alpha', sends: { continue: 'continue' } },
  'sprint-done': { repo: planRepo(BETWEEN), run: 'alpha', sends: { continue: 'continue' } },
  'final-waiting': { repo: planRepo(DONE), run: 'alpha', sends: {} },
  'final-merged': { repo: planRepo(DONE, { claims: [claim('alpha')], prs: [gh(12, 'merged')] }), run: 'alpha', sends: { continue: 'continue' } },
  'not-started': { repo: planRepo(FRESH), run: 'alpha', sends: { go: 'go' } },
  'fix-waiting': { repo: fixRepo('open'), run: FIX, sends: {} },
  'fix-merged': { repo: fixRepo('merged'), run: FIX, sends: { continue: 'continue' } },
  answered: { repo: planRepo({ docs: { one: [[1, 'A1', '—', 'in progress']] }, queue: [`${HALT} **Answer (human):** retry`] }), run: 'alpha', sends: { continue: 'continue' } },
}

const merged = (session: string): BoardRepo => {
  const r = repo([agent({ session, startedAt: NOW - 50 * MIN, lastAt: NOW - 40 * MIN })])
  r.prs = [{ number: 7, state: 'merged', checks: 'pass', checkedAt: NOW }]
  return r
}
const html = (r: BoardRepo) => {
  const view = replyPanel(run(), r, NOW)
  return renderToStaticMarkup(createElement(ReplyPanel, { view, target: view!.target }))
}
const SEND_BUTTON = /<button class="btn primary"[^>]*>Continue<\/button>/

describe('send buttons need a safe session', () => {
  it('no button without a safe session, Copy either way', () => {
    // The runner's rule: the id pattern, and no leading dash (it would read as a flag).
    const unsafe = ['odd id', '-bare', '--resume', 'a'.repeat(65), 'abc;calc', '../x', 'é']
    for (const id of unsafe) {
      const view = replyPanel(run(), merged(id), NOW)
      expect(view!.rows, id).toEqual([{ key: 'continue', word: 'continue', why: 'PR #7 merged.' }])
      expect(view!.session?.line, id).toBe(`Session ${id}`) // the chat to paste it in stays
      const page = html(merged(id))
      expect(page, id).toContain('aria-label="Copy continue"')
      expect(page, id).not.toMatch(SEND_BUTTON)
    }
    // No session at all: Copy, no button.
    const lone = repo()
    lone.prs = [{ number: 7, state: 'merged', checks: 'pass', checkedAt: NOW }]
    expect(html(lone)).toContain('aria-label="Copy continue"')
    expect(html(lone)).not.toMatch(SEND_BUTTON)
  })

  it('a safe session shows the button beside Copy', () => {
    for (const id of ['0f6c1e2a-5b7d-4c11-9a3e-2d4f6b8c0e1a', 'a', 'A-1', 'a'.repeat(64), 'x-']) {
      expect(replyPanel(run(), merged(id), NOW)!.rows, id).toEqual([{ key: 'continue', word: 'continue', why: 'PR #7 merged.', send: 'continue' }])
      const page = html(merged(id))
      expect(page, id).toContain('aria-label="Copy continue"')
      expect(page, id).toMatch(SEND_BUTTON)
    }
  })
})

describe('send buttons', () => {
  it('send buttons follow sendableReply', () => {
    for (const [signal, { repo: r, run: plan, sends }] of Object.entries(BY_SIGNAL)) {
      // The fixture gives the signal it names.
      expect(runReplies(r, plan, NOW).map((x) => x.signal), signal).toContain(signal)
      const fix = plan.startsWith('fix-') ? { fix: plan.slice(4) } : {}
      const view = replyPanel(run({ plan, ...fix }), r, NOW)
      expect(view, signal).toBeDefined()
      expect(view!.target, signal).toEqual({ repoId: 'id-r', run: plan })
      for (const row of view!.rows) {
        const want = sends[row.word]
        if (want === undefined) expect(row, `${signal} ${row.word}`).not.toHaveProperty('send')
        else expect(row.send, `${signal} ${row.word}`).toBe(want)
      }
    }
    // try never gets one: the final-waiting run shows continue and try, neither sendable.
    const fw = replyPanel(run(), BY_SIGNAL['final-waiting'].repo, NOW)
    expect(fw!.rows.map((r) => r.word)).toEqual(['continue', 'try'])
    expect(fw!.rows.some((r) => r.send !== undefined)).toBe(false)
    // A fresh plan's one row gets Go.
    expect(replyPanel(run(), BY_SIGNAL['not-started'].repo, NOW)!.rows).toEqual([{ key: 'go', word: 'go', why: 'Only if pod asked for go.', send: 'go' }])
    // Each sending row's word sends: continue on the merged wave.
    expect(replyPanel(run(), BY_SIGNAL['wave-merged'].repo, NOW)!.rows).toEqual([{ key: 'continue', word: 'continue', why: 'PR #7 merged.', send: 'continue' }])
  })
})

describe('answered stop', () => {
  it('offers continue with its why once you answered the halt', () => {
    const view = replyPanel(run(), BY_SIGNAL.answered.repo, NOW)
    expect(view!.rows).toEqual([{ key: 'continue', word: 'continue', why: 'You answered 1 entry: reply continue so pod reads it.', send: 'continue' }])
    // The halt not answered yet: no panel.
    const open = planRepo({ docs: { one: [[1, 'A1', '—', 'in progress']] }, queue: [HALT] })
    expect(replyPanel(run(), open, NOW)).toBeUndefined()
  })
})

describe('run it yourself', () => {
  const ID = '0f6c1e2a-5b7d-4c11-9a3e-2d4f6b8c0e1a'
  const render = (r: BoardRepo, framed?: boolean) => {
    const view = replyPanel(run(), r, NOW)
    return renderToStaticMarkup(createElement(ReplyPanel, { view, target: view!.target, ...(framed === undefined ? {} : { framed }) }))
  }

  it('run it yourself', () => {
    const page = render(merged(ID))
    // The commands sit behind a closed Run it yourself.
    expect(page).toMatch(/<button[^>]*aria-expanded="false"[^>]*>(<svg[\s\S]*?<\/svg>)?Run it yourself(<svg[\s\S]*?<\/svg>)?<\/button>/)
    expect(page).not.toContain(`Session ${ID}`)
    expect(page).not.toContain('aria-label="Copy cd command"')
    expect(page).not.toContain('aria-label="Copy resume command"')
    expect(page).not.toContain(`claude --resume ${ID}`)
    // The rows stay in view: word, why, Copy, and Continue following send.
    expect(page).toContain('PR #7 merged.')
    expect(page).toContain('aria-label="Copy continue"')
    expect(page).toMatch(SEND_BUTTON)
    const waiting = repo([agent({ session: ID, startedAt: NOW - 50 * MIN, lastAt: NOW - 40 * MIN })])
    expect(render(waiting)).not.toMatch(SEND_BUTTON) // the PR isn't merged: no send, Copy only
    expect(render(waiting)).toContain('aria-label="Copy continue"')
    // Go follows send too.
    const go = replyPanel(run(), BY_SIGNAL['not-started'].repo, NOW)!
    expect(renderToStaticMarkup(createElement(ReplyPanel, { view: go, target: go.target }))).toMatch(/<button class="btn primary"[^>]*>Go<\/button>/)

    // Framed by default: the panel's frame and heading. framed={false} drops both, for use in the card.
    expect(page).toMatch(/<section class="inplace reply-panel"/)
    expect(page).toContain('Reply pod waits for</span>')
    expect(render(merged(ID), true)).toBe(page)
    const bare = render(merged(ID), false)
    expect(bare).not.toContain('inplace')
    expect(bare).not.toContain('Reply pod waits for</span>')
    expect(bare).toMatch(SEND_BUTTON)
    expect(bare).toMatch(/aria-expanded="false"[^>]*>(<svg[\s\S]*?<\/svg>)?Run it yourself/)

    // What opens: the session line, cd and claude --resume, each with Copy.
    const s = replyPanel(run(), merged(ID), NOW)!
    const chat = renderToStaticMarkup(createElement(ReplyChat, { view: s }))
    expect(chat).toContain(`Session ${ID}`)
    expect(chat).toContain('aria-label="Copy cd command"')
    expect(chat).toContain(`claude --resume ${ID}`)
    expect(chat).toContain('aria-label="Copy resume command"')
    // No session: the no-session note is what opens.
    const lone = repo()
    lone.prs = [{ number: 7, state: 'merged', checks: 'pass', checkedAt: NOW }]
    expect(renderToStaticMarkup(createElement(ReplyChat, { view: replyPanel(run(), lone, NOW)! }))).toContain(NO_SESSION)
    expect(render(lone)).not.toContain(NO_SESSION)
  })
})
