import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildRepoModel, type AgentRun, type Board, type BoardRepo, type GhRead, type PrStatus } from '@openaflow/model'
import { LIVE_TICK_MS } from '@openaflow/web/selection'
import { loadFixture } from '../../model/test/load-fixture.ts'
import { bundleDesktop } from './bundle-desktop.ts'
import { createNotifier, type Toast } from './notifier.ts'

const here = dirname(fileURLToPath(import.meta.url))
const NOW = Date.UTC(2026, 9, 20, 12)
const PLAN = 'sparring-ladder'
const QUEUE = 'pod-docs/handoff-queue.md'
const LADDER = 'pod-docs/sprints/ladder.md'
const PLAN_DOC = 'pod-docs/plans/sparring-ladder.md'
/** Long enough for any running agent to count as stopped. */
const DAY_OF_TICKS = (24 * 60 * 60_000) / LIVE_TICK_MS

const blocked = (name: string) => `- \`[2026-10-19 · BLOCKED · engineer → human · sprint: ladder · slice: T1]\` ${name} is stuck. **Resolution:** pending`
const prOf = (number: number, state: PrStatus['state']): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW })
/** An engineer that wrote just now and never ended counts as running, so pod has no reply yet. */
const live: AgentRun = { id: 'e1', session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: false, plan: PLAN, sprint: 'ladder', slice: 'T1', startedAt: NOW - 3_600_000, lastAt: NOW }

function repoWith(names: string[], o: { pr?: PrStatus; agents?: AgentRun[]; id?: string } = {}): BoardRepo {
  const f = loadFixture('chess-web')
  f[QUEUE] = ['# Handoff Queue', '', ...names.map(blocked), ''].join('\n')
  for (const doc of [PLAN_DOC, LADDER]) f[doc] = f[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
  if (o.pr) f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', `| ladder-T1 | #${o.pr.number} | pushed | medium |`)
  const id = o.id ?? 'chess'
  return { id, name: id, path: `/${id}`, source: 'registered', model: buildRepoModel(f), agents: o.agents ?? [], prs: o.pr ? [o.pr] : [], claims: [] }
}
const boardOf = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos })
const withEntries = (...names: string[]) => boardOf(repoWith(names))
/** Stops being a merged-PR reply's blocker once `live` goes stale. */
const clockBoard = () => boardOf(repoWith([], { pr: prOf(78, 'merged'), agents: [live] }))

function setup(o: { supported?: () => boolean; send?: (t: Toast) => void } = {}) {
  const toasts: Toast[] = []
  const dot: boolean[] = []
  const onError = vi.fn()
  const notifier = createNotifier({
    now: () => Date.now(),
    supported: o.supported ?? (() => true),
    send: (t) => {
      o.send?.(t)
      toasts.push(t)
    },
    setAttention: (on) => dot.push(on),
    onError,
  })
  return { notifier, toasts, dot, onError }
}

describe('notifier', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('the first Board is the baseline', () => {
    const s = setup()
    s.notifier.board(withEntries('A'))
    expect(s.toasts).toEqual([])
    expect(s.dot.at(-1)).toBe(true)
    s.notifier.close()

    // A first Board with nothing: the dot is off, and the baseline is spent.
    const t = setup()
    t.notifier.board(withEntries())
    expect(t.dot.at(-1)).toBe(false)
    t.notifier.board(withEntries('A'))
    expect(t.toasts).toHaveLength(1)
    expect(t.dot.at(-1)).toBe(true)
    t.notifier.close()
  })

  test('once per item', () => {
    const s = setup()
    s.notifier.board(withEntries('A'))
    s.notifier.board(withEntries('A', 'B'))
    expect(s.toasts).toHaveLength(1)
    // A later Board, a reconnect, and a server restart's first Board all say the same thing.
    s.notifier.board(withEntries('A', 'B'))
    s.notifier.lost()
    s.notifier.board(withEntries('A', 'B'))
    s.notifier.lost()
    s.notifier.board(withEntries('A', 'B'))
    vi.advanceTimersByTime(LIVE_TICK_MS * 3)
    expect(s.toasts).toHaveLength(1)
    s.notifier.close()
  })

  test('a returning item stays quiet', () => {
    const s = setup()
    s.notifier.board(withEntries())
    s.notifier.board(withEntries('A'))
    expect(s.toasts).toHaveLength(1)
    expect(s.dot.at(-1)).toBe(true)
    s.notifier.board(withEntries())
    expect(s.dot.at(-1)).toBe(false)
    s.notifier.board(withEntries('A'))
    expect(s.dot.at(-1)).toBe(true)
    expect(s.toasts).toHaveLength(1)
    s.notifier.close()
  })

  test('the clock can raise an item', () => {
    const s = setup()
    s.notifier.board(clockBoard())
    expect(s.dot.at(-1)).toBe(false)
    // Time passes with no new Board: the engineer stops counting as running, and the reply is due.
    vi.advanceTimersByTime(LIVE_TICK_MS * DAY_OF_TICKS)
    expect(s.toasts).toMatchObject([{ body: 'Send continue' }])
    expect(s.dot.at(-1)).toBe(true)
    s.notifier.close()
  })

  test('a lost stream holds the dot and raises nothing', () => {
    const s = setup()
    s.notifier.board(clockBoard())
    s.notifier.lost()
    // Long past the time the reply would be due: the Board is stale, so nothing moves.
    vi.advanceTimersByTime(LIVE_TICK_MS * DAY_OF_TICKS)
    expect(s.toasts).toEqual([])
    expect(s.dot.at(-1)).toBe(false)
    // The next Board goes on.
    s.notifier.board(clockBoard())
    expect(s.toasts).toHaveLength(1)
    s.notifier.close()

    // An on dot stays on while lost.
    const on = setup()
    on.notifier.board(withEntries('A'))
    on.notifier.lost()
    vi.advanceTimersByTime(LIVE_TICK_MS * 4)
    expect(on.dot.at(-1)).toBe(true)
    on.notifier.close()
  })

  test('a burst is one toast', () => {
    const three = setup()
    three.notifier.board(withEntries())
    three.notifier.board(withEntries('A', 'B', 'C'))
    expect(three.toasts.map((t) => t.body)).toEqual(['A is stuck.', 'B is stuck.', 'C is stuck.'])
    three.notifier.close()

    // Four new items: one summary. The top tier opens, not the first run: a merge in `aaa`, blocked entries in `bbb`.
    // Both repos are on the first Board, so their items are new: a repo's own first Board is its baseline.
    const s = setup()
    s.notifier.board(boardOf(repoWith([], { id: 'aaa' }), repoWith([], { id: 'bbb' })))
    const four = boardOf(repoWith([], { pr: prOf(78, 'open'), id: 'aaa' }), repoWith(['B', 'C', 'D'], { id: 'bbb' }))
    s.notifier.board(four)
    expect(s.toasts).toHaveLength(1)
    const run = repoWith([]).model.plans.find((p) => p.slug === PLAN)?.title
    expect(s.toasts[0]).toEqual({ title: '4 items need you', body: run, hash: `#/bbb/${PLAN}` })
    // All are seen now.
    s.notifier.board(four)
    vi.advanceTimersByTime(LIVE_TICK_MS)
    expect(s.toasts).toHaveLength(1)
    s.notifier.close()

    // New items only: an old blocked item isn't counted and doesn't pick the target.
    const n = setup()
    const old = repoWith(['Old'], { id: 'aaa' })
    n.notifier.board(boardOf(old, repoWith([], { id: 'bbb' })))
    n.notifier.board(boardOf(old, repoWith(['B', 'C', 'D', 'E'], { id: 'bbb' })))
    expect(n.toasts).toHaveLength(1)
    expect(n.toasts[0]).toMatchObject({ title: '4 items need you', hash: `#/bbb/${PLAN}` })
    n.notifier.close()
  })

  test('what a toast says and opens', () => {
    const s = setup()
    s.notifier.board(withEntries())
    const repo = repoWith(['A'])
    s.notifier.board(boardOf(repo))
    const title = repo.model.plans.find((p) => p.slug === PLAN)?.title
    expect(title).toBeTruthy()
    expect(s.toasts).toEqual([{ title, body: 'A is stuck.', hash: `#/chess/${PLAN}` }])
    s.notifier.close()
  })

  test('no toast support', () => {
    let supported = false
    const s = setup({ supported: () => supported })
    s.notifier.board(withEntries())
    expect(() => s.notifier.board(withEntries('A'))).not.toThrow()
    expect(s.toasts).toEqual([])
    expect(s.dot.at(-1)).toBe(true)
    // Marked seen: support that comes back sends nothing for it, and a new item sends.
    supported = true
    s.notifier.board(withEntries('A'))
    expect(s.toasts).toEqual([])
    s.notifier.board(withEntries('A', 'B'))
    expect(s.toasts.map((t) => t.body)).toEqual(['B is stuck.'])
    s.notifier.close()
  })

  test('a failed send stops nothing', () => {
    let first = true
    const s = setup({
      send: () => {
        if (first) {
          first = false
          throw new Error('no toast')
        }
      },
    })
    s.notifier.board(withEntries())
    expect(() => s.notifier.board(withEntries('A', 'B'))).not.toThrow()
    expect(s.toasts.map((t) => t.body)).toEqual(['B is stuck.'])
    expect(s.onError).toHaveBeenCalledOnce()
    expect(s.dot.at(-1)).toBe(true)
    // Each item gets one try, so a broken send can't repeat on every tick.
    s.notifier.board(withEntries('A', 'B'))
    expect(s.toasts).toHaveLength(1)
    s.notifier.close()
  })

  test('a Board the rules cannot read changes nothing', () => {
    const s = setup()
    s.notifier.board(withEntries('A'))
    const dots = s.dot.length
    const bad = { generatedAt: NOW, gh: 'ok', repos: [{ id: 'x' }] } as unknown as Board
    expect(() => s.notifier.board(bad)).not.toThrow()
    expect(s.onError).toHaveBeenCalled()
    expect(s.dot).toHaveLength(dots)
    expect(() => vi.advanceTimersByTime(LIVE_TICK_MS)).not.toThrow()
    s.notifier.board(withEntries('A', 'B'))
    expect(s.toasts).toHaveLength(1)
    s.notifier.close()
  })

  test('close ends the clock and the sends', () => {
    const s = setup()
    s.notifier.board(clockBoard())
    expect(s.dot).toEqual([false])
    s.notifier.close()
    vi.advanceTimersByTime(LIVE_TICK_MS * DAY_OF_TICKS)
    s.notifier.board(withEntries('A'))
    expect(s.toasts).toEqual([])
    expect(s.dot).toEqual([false])
  })

  describe('a repo added after the first Board', () => {
    /** Three new items per repo: one pass each, so the burst rule alone never sums them up. */
    const three = (id: string) => repoWith([`${id} A`, `${id} B`, `${id} C`], { id })

    test('repos added one by one send no toast, and the dot shows their items', () => {
      const s = setup()
      s.notifier.board(boardOf(repoWith([], { id: 'base' })))
      const added: BoardRepo[] = [repoWith([], { id: 'base' })]
      for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
        added.push(three(id))
        s.notifier.board(boardOf(...added))
      }
      vi.advanceTimersByTime(LIVE_TICK_MS * 3)
      expect(s.toasts).toEqual([])
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()
    })

    test('a real new item in an added repo still sends one toast', () => {
      const s = setup()
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(three('r1')))
      s.notifier.board(boardOf(repoWith(['r1 A', 'r1 B', 'r1 C', 'r1 D'], { id: 'r1' })))
      expect(s.toasts.map((t) => t.body)).toEqual(['r1 D is stuck.'])
      s.notifier.close()
    })

    test("in one pass, the old repo's new item sends alone and the added repo's items don't count toward a burst", () => {
      const s = setup()
      s.notifier.board(boardOf(repoWith([], { id: 'old' })))
      s.notifier.board(boardOf(repoWith(['New'], { id: 'old' }), three('r1')))
      expect(s.toasts).toEqual([expect.objectContaining({ body: 'New is stuck.', hash: `#/old/${PLAN}` })])
      s.notifier.close()
    })

    test("an added repo's PRs that gh reads later are old news, and a later ask still sends", () => {
      const FIX = 'fix-scroll'
      const at = NOW
      const engineer: AgentRun = { id: 'f1', session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: true, branch: FIX, startedAt: at - 90 * 60_000, lastAt: at - 60 * 60_000 }
      const reviewer: AgentRun = { ...engineer, id: 'f2', type: 'pod:reviewer', kind: 'fix', startedAt: at - 50 * 60_000, lastAt: at - 5 * 60_000 }
      const fixRepo = (reads: GhRead[], pr: boolean): BoardRepo => {
        const base = repoWith([], { id: 'r1' })
        return { ...base, claims: [{ portBase: 3100, repoPath: base.path, plan: FIX }], agents: [engineer, reviewer], prs: pr ? [{ ...prOf(36, 'open'), branch: FIX }] : [], ghReads: reads }
      }
      const s = setup()
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(fixRepo([{ branch: FIX, read: false }], false)))
      // gh's first read lands on a later Board: the PR was there before the add.
      s.notifier.board(boardOf(fixRepo([{ branch: FIX, read: true }], true)))
      expect(s.toasts).toEqual([])
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()

      // Control: the ask comes up after the repo's first Board, so the PR its first read finds is new.
      const t = setup()
      t.notifier.board(boardOf())
      t.notifier.board(boardOf(fixRepo([{ pr: 99, read: true }], false)))
      t.notifier.board(boardOf(fixRepo([{ pr: 99, read: true }, { branch: FIX, read: false }], false)))
      t.notifier.board(boardOf(fixRepo([{ pr: 99, read: true }, { branch: FIX, read: true }], true)))
      expect(t.toasts).toMatchObject([{ body: 'Merge PR #36' }])
      t.notifier.close()
    })

    test('a repo that first shows with an error is the baseline once it reads', () => {
      const s = setup()
      s.notifier.board(boardOf())
      const broken: BoardRepo = { ...three('r1'), error: 'folder missing', model: buildRepoModel({}), prs: [] }
      s.notifier.board(boardOf(broken))
      s.notifier.board(boardOf(three('r1')))
      expect(s.toasts).toEqual([])
      s.notifier.board(boardOf(repoWith(['r1 A', 'r1 B', 'r1 C', 'r1 D'], { id: 'r1' })))
      expect(s.toasts.map((t) => t.body)).toEqual(['r1 D is stuck.'])
      s.notifier.close()
    })

    test('a repo removed and added again is the baseline again: what arrived while it was gone sends nothing', () => {
      const s = setup()
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(three('r1')))
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(repoWith(['r1 A', 'r1 B', 'r1 C', 'r1 D', 'r1 E'], { id: 'r1' })))
      // Re-added one by one, several repos can't add up to a flood either.
      s.notifier.board(boardOf(three('r2')))
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(repoWith(['r2 A', 'r2 B', 'r2 C', 'r2 D'], { id: 'r2' })))
      expect(s.toasts).toEqual([])
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()
    })

    test('a new item after a re-add still sends one toast', () => {
      const s = setup()
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(three('r1')))
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(repoWith(['r1 A', 'r1 B', 'r1 C', 'r1 D'], { id: 'r1' })))
      s.notifier.board(boardOf(repoWith(['r1 A', 'r1 B', 'r1 C', 'r1 D', 'r1 E'], { id: 'r1' })))
      expect(s.toasts.map((t) => t.body)).toEqual(['r1 E is stuck.'])
      s.notifier.close()
    })

    test('a repo that shows with a read error for a Board has not left: its new items send when it reads again', () => {
      const s = setup()
      s.notifier.board(boardOf())
      s.notifier.board(boardOf(three('r1')))
      s.notifier.board(boardOf({ ...three('r1'), error: 'folder missing', model: buildRepoModel({}), prs: [] }))
      s.notifier.board(boardOf(repoWith(['r1 A', 'r1 B', 'r1 C', 'r1 D'], { id: 'r1' })))
      expect(s.toasts.map((t) => t.body)).toEqual(['r1 D is stuck.'])
      s.notifier.close()
    })

    test('a repo added while the stream is lost is the baseline on the next Board', () => {
      const s = setup()
      s.notifier.board(boardOf())
      s.notifier.lost()
      s.notifier.board(boardOf(three('r1'), three('r2')))
      expect(s.toasts).toEqual([])
      s.notifier.close()
    })
  })

  describe("the PRs gh hadn't read at the first Board", () => {
    const FIX = 'fix-scroll'
    /** A reviewed fix run: its merge item exists only once gh names PR #36 on its branch. */
    const fixRun = (o: { names?: string[]; reads?: GhRead[]; pr?: boolean; reviewed?: boolean; gh?: Board['gh']; slicePr?: number } = {}): Board => {
      const at = Date.now()
      const engineer: AgentRun = { id: 'f1', session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: true, branch: FIX, startedAt: at - 90 * 60_000, lastAt: at - 60 * 60_000 }
      const reviewer: AgentRun = { ...engineer, id: 'f2', type: 'pod:reviewer', kind: 'fix', startedAt: at - 50 * 60_000, lastAt: at - 5 * 60_000 }
      const base = repoWith(o.names ?? [], o.slicePr === undefined ? {} : { pr: prOf(o.slicePr, 'open') })
      const repo: BoardRepo = {
        ...base,
        claims: [{ portBase: 3100, repoPath: base.path, plan: FIX }],
        agents: o.reviewed === false ? [{ ...engineer, ended: false, lastAt: at }] : [engineer, reviewer],
        prs: [...base.prs, ...(o.pr ? [{ ...prOf(36, 'open'), branch: FIX }] : [])],
        ...(o.reads ? { ghReads: o.reads } : {}),
      }
      return { ...boardOf(repo), gh: o.gh ?? 'ok' }
    }
    const unread: GhRead[] = [{ branch: FIX, read: false }]
    const read: GhRead[] = [{ branch: FIX, read: true }]
    const AFTER_THE_OLD_HOLD = 91_000

    test('the fixture: PR #36 is an item only when gh names it', () => {
      const s = setup()
      s.notifier.board(fixRun({ reads: read }))
      expect(s.dot.at(-1)).toBe(false)
      s.notifier.board(fixRun({ reads: read, pr: true }))
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()
    })

    test('gh offline at the start: an old PR stays quiet when gh comes back', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'unknown', reads: unread }))
      // `gh auth status` fails through a dead network, which reads as logged-out for 60 s.
      s.notifier.board(fixRun({ gh: 'logged-out', reads: unread }))
      vi.advanceTimersByTime(AFTER_THE_OLD_HOLD)
      s.notifier.board(fixRun({ gh: 'ok', reads: read, pr: true }))
      vi.advanceTimersByTime(LIVE_TICK_MS)
      expect(s.toasts).toEqual([])
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()
    })

    test('a failed first PR read counts as not read: asked again later, the PR stays quiet', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'unknown', reads: unread }))
      s.notifier.board(fixRun({ gh: 'ok', reads: unread }))
      vi.advanceTimersByTime(AFTER_THE_OLD_HOLD)
      s.notifier.board(fixRun({ gh: 'ok', reads: unread }))
      s.notifier.board(fixRun({ gh: 'ok', reads: read, pr: true }))
      expect(s.toasts).toEqual([])
      s.notifier.close()
    })

    test('a merge item the docs alone name sends at once, while gh is out', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'logged-out', reads: unread }))
      vi.advanceTimersByTime(8000)
      const next = fixRun({ gh: 'logged-out', reads: unread, slicePr: 78 })
      // The docs name it, so a Board with no gh answer has it: no PR on the repo backs it.
      next.repos[0]!.prs = []
      s.notifier.board(next)
      expect(s.toasts).toMatchObject([{ body: 'Merge PR #78' }])
      s.notifier.close()
    })

    test('hours of gh offline silence neither a doc-named item nor a BLOCKED', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'logged-out', reads: unread }))
      vi.advanceTimersByTime(3 * 3_600_000)
      s.notifier.board(fixRun({ gh: 'logged-out', reads: unread, names: ['A'] }))
      expect(s.toasts.map((t) => t.body)).toEqual(['A is stuck.'])
      vi.advanceTimersByTime(3 * 3_600_000)
      s.notifier.board(fixRun({ gh: 'ok', reads: read, names: ['A'], pr: true }))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()
    })

    test('in one pass, the new line sends and the old PR does not', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'unknown', reads: unread }))
      s.notifier.board(fixRun({ gh: 'ok', reads: read, pr: true, names: ['B'] }))
      expect(s.toasts.map((t) => t.body)).toEqual(['B is stuck.'])
      s.notifier.close()
    })

    test('a first read that finds no PR ends the wait: a PR opened later sends', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'unknown', reads: unread }))
      s.notifier.board(fixRun({ gh: 'ok', reads: read }))
      expect(s.toasts).toEqual([])
      s.notifier.board(fixRun({ gh: 'ok', reads: read, pr: true }))
      expect(s.toasts).toMatchObject([{ body: 'Merge PR #36' }])
      s.notifier.close()
    })

    test('a read asked for only after the first Board finds a new PR: it sends', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'ok', reads: [{ pr: 99, read: true }] }))
      // A run that started later: not in the baseline, whenever its first read lands.
      s.notifier.board(fixRun({ gh: 'ok', reads: [{ pr: 99, read: true }, ...unread] }))
      s.notifier.board(fixRun({ gh: 'ok', reads: [{ pr: 99, read: true }, ...read], pr: true }))
      expect(s.toasts).toMatchObject([{ body: 'Merge PR #36' }])
      s.notifier.close()
    })

    test('a late PR that later changes sends: only its first read is old news', () => {
      const s = setup()
      s.notifier.board(fixRun({ gh: 'unknown', reads: unread, reviewed: false }))
      s.notifier.board(fixRun({ gh: 'ok', reads: read, pr: true, reviewed: false }))
      expect(s.dot.at(-1)).toBe(false)
      s.notifier.board(fixRun({ gh: 'ok', reads: read, pr: true }))
      expect(s.toasts).toMatchObject([{ body: 'Merge PR #36' }])
      s.notifier.close()
    })

    test('a reply only a late read can name stays quiet', () => {
      const s = setup()
      const repo = (prs: PrStatus[], reads: GhRead[]): BoardRepo => ({ ...repoWith([], { pr: prOf(78, 'merged') }), prs, ghReads: reads, agents: [{ ...live, ended: true, lastAt: NOW - 3_600_000 }] })
      // The docs name #78, so its merge item is in the baseline. gh then says it merged, which asks for a reply.
      s.notifier.board(boardOf(repo([], [{ pr: 78, read: false }])))
      s.notifier.board(boardOf(repo([prOf(78, 'merged')], [{ pr: 78, read: true }])))
      vi.advanceTimersByTime(LIVE_TICK_MS)
      expect(s.toasts).toEqual([])
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()

      // Control: with that PR not awaited, the same reply sends.
      const t = setup()
      t.notifier.board(boardOf(repo([], [{ pr: 78, read: true }])))
      t.notifier.board(boardOf(repo([prOf(78, 'merged')], [{ pr: 78, read: true }])))
      expect(t.toasts).toMatchObject([{ body: 'Send continue' }])
      t.notifier.close()
    })

    test('an ask that leaves the Board and comes back is still unread', () => {
      const s = setup()
      s.notifier.board(fixRun({ reads: unread }))
      // A half-saved doc, say: the Board asks for nothing this time.
      s.notifier.board(fixRun({}))
      s.notifier.board(fixRun({ reads: read, pr: true }))
      expect(s.toasts).toEqual([])
      s.notifier.close()
    })

    test('a staging ask that a late read found waits too', () => {
      const parent: GhRead = { pr: 99, read: false }
      const staging: GhRead = { branch: FIX, staging: true, read: false }
      const first = setup()
      first.notifier.board(fixRun({ reads: [parent] }))
      const found = fixRun({ reads: [{ ...parent, read: true }, staging] })
      found.repos[0]!.prs = [prOf(99, 'merged')]
      first.notifier.board(found)
      const done = fixRun({ reads: [{ ...parent, read: true }, { ...staging, read: true }], pr: true })
      done.repos[0]!.prs.push(prOf(99, 'merged'))
      first.notifier.board(done)
      expect(first.toasts).toEqual([])
      first.notifier.close()

      // Control: no late read found anything, so a staging ask that shows up later is really new.
      const second = setup()
      second.notifier.board(fixRun({ reads: [{ ...parent, read: true }] }))
      second.notifier.board(fixRun({ reads: [{ ...parent, read: true }, staging] }))
      second.notifier.board(fixRun({ reads: [{ ...parent, read: true }, { ...staging, read: true }], pr: true }))
      expect(second.toasts).toMatchObject([{ body: 'Merge PR #36' }])
      second.notifier.close()
    })

    test('a server restart resets its reads, and the notifier does not wait again', () => {
      const s = setup()
      s.notifier.board(fixRun({ reads: read }))
      s.notifier.lost()
      s.notifier.board(fixRun({ gh: 'unknown', reads: unread }))
      s.notifier.board(fixRun({ reads: read, pr: true }))
      expect(s.toasts).toMatchObject([{ body: 'Merge PR #36' }])
      s.notifier.close()
    })

    test('the wait is per repo', () => {
      const s = setup()
      const of = (id: string, o: Parameters<typeof fixRun>[0]) => ({ ...fixRun(o).repos[0]!, id })
      s.notifier.board(boardOf(of('aaa', { reads: unread }), of('bbb', { reads: read })))
      s.notifier.board(boardOf(of('aaa', { reads: read, pr: true }), of('bbb', { reads: read, pr: true })))
      expect(s.toasts).toMatchObject([{ body: 'Merge PR #36', hash: `#/bbb/${FIX}` }])
      s.notifier.close()
    })

    test('a first Board where every read is done has no wait, and one with no field has none', () => {
      const s = setup()
      s.notifier.board(fixRun({ reads: read, names: ['A'] }))
      s.notifier.board(fixRun({ reads: read, names: ['A'], pr: true }))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()

      const t = setup()
      t.notifier.board(fixRun({}))
      t.notifier.board(fixRun({ pr: true }))
      expect(t.toasts).toHaveLength(1)
      t.notifier.close()
    })
  })
})

describe('the bundle', () => {
  const REACT = /node_modules[\\/](?:\.pnpm[\\/])?react(?:-dom)?[@\\/]|react\.transitional\.element/
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-notifier-bundle-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('the main bundle holds no React', async () => {
    const outfile = join(dir, 'main.cjs')
    await bundleDesktop({ entry: join(here, 'main.ts'), outfile })
    const text = readFileSync(outfile, 'utf8')
    // The notifier is inside.
    expect(text).toContain('openaflow desktop: toast sent')
    expect(text).toContain('items need you')
    expect(text).not.toMatch(REACT)

    // The check does see React, in a component of the web package.
    const control = join(dir, 'control.cjs')
    await bundleDesktop({ entry: join(here, '..', '..', 'web', 'src', 'ErrorBoundary.tsx'), outfile: control })
    expect(readFileSync(control, 'utf8')).toMatch(REACT)
  }, 60_000)
})
