import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildRepoModel, type AgentRun, type Board, type BoardRepo, type PrStatus } from '@pod-board/model'
import { LIVE_TICK_MS } from '@pod-board/web/selection'
import { loadFixture } from '../../model/test/load-fixture.ts'
import { bundleDesktop } from './bundle-desktop.ts'
import { createNotifier, GH_HOLD_MS, type Toast } from './notifier.ts'

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
/** A Board at this gh state, with entries and with one PR item that only gh can name. */
const ghBoard = (gh: Board['gh'], names: string[], pr?: number): Board => ({ ...boardOf(repoWith(names, pr === undefined ? {} : { pr: prOf(pr, 'open') })), gh })

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
    const s = setup()
    s.notifier.board(boardOf())
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
    n.notifier.board(boardOf(old))
    n.notifier.board(boardOf(old, repoWith(['B', 'C', 'D', 'E'], { id: 'bbb' })))
    expect(n.toasts).toHaveLength(1)
    expect(n.toasts[0]).toMatchObject({ title: '4 items need you', hash: `#/bbb/${PLAN}` })
    n.notifier.close()
  })

  test('what a toast says and opens', () => {
    const s = setup()
    s.notifier.board(boardOf())
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

  describe('the hold while gh has not answered', () => {
    test('an old PR that only gh can name sends nothing', () => {
      const s = setup()
      s.notifier.board(ghBoard('unknown', ['A']))
      s.notifier.board(ghBoard('ok', ['A'], 901))
      expect(s.toasts).toEqual([])
      expect(s.dot.at(-1)).toBe(true)
      s.notifier.close()
    })

    test('holds while gh is ok but a refresh may still be running', () => {
      // The server can rebuild between `gh auth status` and the PR reads.
      const s = setup()
      s.notifier.board(ghBoard('unknown', []))
      s.notifier.board(ghBoard('ok', []))
      vi.advanceTimersByTime(GH_HOLD_MS - 1000)
      s.notifier.board(ghBoard('ok', [], 901))
      expect(s.toasts).toEqual([])
      s.notifier.close()
    })

    test('a PR after the hold sends once', () => {
      const s = setup()
      s.notifier.board(ghBoard('unknown', []))
      s.notifier.board(ghBoard('ok', []))
      vi.advanceTimersByTime(GH_HOLD_MS)
      s.notifier.board(ghBoard('ok', [], 901))
      expect(s.toasts).toHaveLength(1)
      s.notifier.board(ghBoard('ok', [], 901))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()
    })

    test.each(['missing', 'logged-out'] as const)('gh %s ends the hold at once', (gh) => {
      const s = setup()
      s.notifier.board(ghBoard('unknown', []))
      s.notifier.board(ghBoard(gh, []))
      s.notifier.board(ghBoard(gh, [], 901))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()
    })

    test('a gh that never answers ends the hold at the time limit', () => {
      const s = setup()
      s.notifier.board(ghBoard('unknown', []))
      s.notifier.board(ghBoard('unknown', [], 901))
      expect(s.toasts).toEqual([])
      // The clock's pass ends the hold with nothing new: 901 stays old news.
      vi.advanceTimersByTime(Math.max(GH_HOLD_MS, LIVE_TICK_MS))
      expect(s.toasts).toEqual([])
      s.notifier.board(ghBoard('unknown', [], 902))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()
    })

    test('a new BLOCKED line sends during the hold', () => {
      const s = setup()
      s.notifier.board(ghBoard('unknown', ['A']))
      s.notifier.board(ghBoard('unknown', ['A', 'B']))
      expect(s.toasts).toHaveLength(1)
      expect(s.toasts[0]!.body).toContain('B')
      // With an old PR in the same pass: only the line sends.
      s.notifier.board(ghBoard('ok', ['A', 'B', 'C'], 901))
      expect(s.toasts).toHaveLength(2)
      expect(s.toasts[1]!.body).toContain('C')
      s.notifier.close()
    })

    test('a first Board where gh has answered has no hold', () => {
      const s = setup()
      s.notifier.board(ghBoard('ok', ['A']))
      s.notifier.board(ghBoard('ok', ['A'], 901))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()
    })

    test('a first Board where gh is unavailable has no hold', () => {
      const s = setup()
      s.notifier.board(ghBoard('missing', ['A']))
      s.notifier.board(ghBoard('missing', ['A'], 901))
      expect(s.toasts).toHaveLength(1)
      s.notifier.close()
    })
  })
})

describe('the bundle', () => {
  const REACT = /node_modules[\\/](?:\.pnpm[\\/])?react(?:-dom)?[@\\/]|react\.transitional\.element/
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-notifier-bundle-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('the main bundle holds no React', async () => {
    const outfile = join(dir, 'main.cjs')
    await bundleDesktop({ entry: join(here, 'main.ts'), outfile })
    const text = readFileSync(outfile, 'utf8')
    // The notifier is inside.
    expect(text).toContain('pod-board desktop: toast sent')
    expect(text).toContain('items need you')
    expect(text).not.toMatch(REACT)

    // The check does see React, in a component of the web package.
    const control = join(dir, 'control.cjs')
    await bundleDesktop({ entry: join(here, '..', '..', 'web', 'src', 'ErrorBoundary.tsx'), outfile: control })
    expect(readFileSync(control, 'utf8')).toMatch(REACT)
  }, 60_000)
})
