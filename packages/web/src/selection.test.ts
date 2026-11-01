import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSummary } from '@pod-board/model'
import { hashFor, parseHash, resolveSelection, startClock, LIVE_TICK_MS } from './selection.ts'

const run = (repoId: string, plan?: string): RunSummary => ({
  repoId,
  repo: repoId,
  where: 'x',
  state: plan ? 'running' : 'idle',
  ...(plan ? { plan } : {}),
})

const runs = [run('e--projects-a', 'alpha'), run('e--projects-a', 'beta'), run('e--projects-b')]

describe('selected run', () => {
  it('the hash picks the run', () => {
    expect(resolveSelection(runs, '#/e--projects-a/beta').run).toBe(runs[1])
    expect(resolveSelection(runs, '#/e--projects-b').run).toBe(runs[2])
  })

  it('an unknown, empty, or malformed hash gives the first run', () => {
    for (const hash of ['', '#', '#/', '#/nope/alpha', '#/e--projects-a/gamma', '#/e--projects-a', 'garbage', '#/%E0%A4%A']) {
      expect(resolveSelection(runs, hash).run).toBe(runs[0])
    }
  })

  it('a repo hash with a plan does not pick that repo’s plan-less run', () => {
    expect(resolveSelection(runs, '#/e--projects-b/alpha').run).toBe(runs[0])
  })

  it('no runs gives none, and an empty hash, so a removed run hash leaves the URL', () => {
    expect(resolveSelection([], '#/e--projects-a/alpha')).toEqual({ run: undefined, view: 'pipeline', slice: undefined, hash: '' })
    expect(resolveSelection([], '').hash).toBe('')
  })

  it('when the selected run vanishes, the selection moves to the first and the hash follows', () => {
    const before = resolveSelection(runs, '#/e--projects-a/beta')
    expect(before.hash).toBe('#/e--projects-a/beta')
    const after = resolveSelection([runs[0]!, runs[2]!], before.hash!)
    expect(after.run).toBe(runs[0])
    expect(after.hash).toBe('#/e--projects-a/alpha')
  })

  it('hashFor and parseHash round-trip, plan or no plan', () => {
    for (const r of runs) expect(parseHash(hashFor(r))).toEqual({ repoId: r.repoId, plan: r.plan, view: 'pipeline' })
    expect(hashFor(run('a b', 'p/q'))).toBe('#/a%20b/p%2Fq')
    expect(parseHash('#/a%20b/p%2Fq')).toEqual({ repoId: 'a b', plan: 'p/q', view: 'pipeline' })
  })
})

describe('routes', () => {
  const slicesOf = (r: RunSummary) => (r.plan === 'alpha' ? ['L1', 'H 1'] : [])

  it('every hash form parses', () => {
    expect(parseHash('#/r')).toEqual({ repoId: 'r', view: 'pipeline' })
    expect(parseHash('#/r/p')).toEqual({ repoId: 'r', plan: 'p', view: 'pipeline' })
    expect(parseHash('#/r/p/board')).toEqual({ repoId: 'r', plan: 'p', view: 'board' })
    expect(parseHash('#/r/p/board/L1')).toEqual({ repoId: 'r', plan: 'p', view: 'board', slice: 'L1' })
    expect(parseHash('#/r/p/board/H%201')).toEqual({ repoId: 'r', plan: 'p', view: 'board', slice: 'H 1' })
    for (const bad of ['#/r/p/pipeline', '#/r/p/board/L1/x', '#/r/p/x/L1', '#/r/p/board/', '#/r//board', '#/r/p/board/%E0%A4%A']) {
      expect(parseHash(bad), bad).toBeUndefined()
    }
  })

  it('a plan slug "board" is a plan in the two-segment form', () => {
    expect(parseHash('#/r/board')).toEqual({ repoId: 'r', plan: 'board', view: 'pipeline' })
    const own = [run('r', 'board')]
    expect(resolveSelection(own, '#/r/board')).toMatchObject({ run: own[0], view: 'pipeline', hash: '#/r/board' })
    expect(resolveSelection(own, '#/r/board/board')).toMatchObject({ run: own[0], view: 'board', hash: '#/r/board/board' })
  })

  it('the board hash picks the board view, and a slice on the board opens it', () => {
    expect(resolveSelection(runs, '#/e--projects-a/alpha/board', slicesOf)).toEqual({
      run: runs[0],
      view: 'board',
      slice: undefined,
      hash: '#/e--projects-a/alpha/board',
    })
    expect(resolveSelection(runs, '#/e--projects-a/alpha/board/H%201', slicesOf)).toEqual({
      run: runs[0],
      view: 'board',
      slice: 'H 1',
      hash: '#/e--projects-a/alpha/board/H%201',
    })
  })

  it('a code not on the shown board is dropped, and the hash follows', () => {
    expect(resolveSelection(runs, '#/e--projects-a/alpha/board/Z9', slicesOf)).toMatchObject({
      view: 'board',
      slice: undefined,
      hash: '#/e--projects-a/alpha/board',
    })
    expect(resolveSelection(runs, '#/e--projects-a/beta/board/L1', slicesOf)).toMatchObject({
      run: runs[1],
      slice: undefined,
      hash: '#/e--projects-a/beta/board',
    })
  })

  it('a plan-less run never gets the board view', () => {
    expect(hashFor(runs[2]!, 'board', 'L1')).toBe('#/e--projects-b')
    // `#/e--projects-b/board` names plan "board", which repo b doesn't have.
    expect(resolveSelection(runs, '#/e--projects-b/board').run).toBe(runs[0])
    expect(resolveSelection(runs, '#/e--projects-b/board').view).toBe('pipeline')
  })

  it('a hash naming no run gives the first run’s pipeline', () => {
    expect(resolveSelection(runs, '#/nope/alpha/board/L1', slicesOf)).toEqual({
      run: runs[0],
      view: 'pipeline',
      slice: undefined,
      hash: '#/e--projects-a/alpha',
    })
  })

  it('hashFor builds each form, encoded', () => {
    expect(hashFor(runs[0]!)).toBe('#/e--projects-a/alpha')
    expect(hashFor(runs[0]!, 'pipeline', 'L1')).toBe('#/e--projects-a/alpha')
    expect(hashFor(runs[0]!, 'board')).toBe('#/e--projects-a/alpha/board')
    expect(hashFor(run('a b', 'p/q'), 'board', 'C/1')).toBe('#/a%20b/p%2Fq/board/C%2F1')
    expect(parseHash('#/a%20b/p%2Fq/board/C%2F1')).toEqual({ repoId: 'a b', plan: 'p/q', view: 'board', slice: 'C/1' })
  })
})

describe('live clock', () => {
  afterEach(() => vi.useRealTimers())

  it('ticks every 30 s until stopped', () => {
    vi.useFakeTimers()
    const ticks: number[] = []
    const stop = startClock((now) => ticks.push(now))
    expect(LIVE_TICK_MS).toBe(30_000)
    vi.advanceTimersByTime(29_999)
    expect(ticks).toHaveLength(0)
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(30_000)
    expect(ticks).toHaveLength(2)
    stop()
    vi.advanceTimersByTime(90_000)
    expect(ticks).toHaveLength(2)
  })
})

describe('fix run routes', () => {
  const fix: RunSummary = { repoId: 'r', repo: 'web', plan: 'fix-scroll', fix: 'scroll', where: 'build', state: 'running' }
  const plan: RunSummary = { repoId: 'r', repo: 'web', plan: 'alpha', where: 'x', state: 'idle' }
  const all = [fix, plan]
  const slicesOf = (r: RunSummary) => (r.plan === 'alpha' ? ['A1'] : [])
  const agentsOf = (r: RunSummary) => (r.fix === 'scroll' ? ['a1'] : [])

  it('a fix run is picked by its claim name', () => {
    expect(resolveSelection(all, '#/r/fix-scroll')).toMatchObject({ run: fix, view: 'pipeline', hash: '#/r/fix-scroll' })
  })

  it('a fix run never gets the wave board; the hash follows', () => {
    expect(resolveSelection(all, '#/r/fix-scroll/board', slicesOf, agentsOf)).toMatchObject({ run: fix, view: 'pipeline', slice: undefined, hash: '#/r/fix-scroll' })
    expect(hashFor(fix, 'board')).toBe('#/r/fix-scroll')
  })

  it('the agent route opens one of the run’s agents; an unknown one falls back to the pipeline', () => {
    expect(parseHash('#/r/fix-scroll/agent/a1')).toEqual({ repoId: 'r', plan: 'fix-scroll', view: 'agent', agent: 'a1' })
    expect(resolveSelection(all, '#/r/fix-scroll/agent/a1', slicesOf, agentsOf)).toEqual({ run: fix, view: 'agent', slice: undefined, agent: 'a1', hash: '#/r/fix-scroll/agent/a1' })
    expect(resolveSelection(all, '#/r/fix-scroll/agent/zz', slicesOf, agentsOf)).toMatchObject({ view: 'pipeline', agent: undefined, hash: '#/r/fix-scroll' })
    expect(parseHash('#/r/fix-scroll/agent')).toBeUndefined()
  })

  it('a plan run never gets the agent route', () => {
    expect(resolveSelection(all, '#/r/alpha/agent/a1', slicesOf, () => ['a1'])).toMatchObject({ run: plan, view: 'pipeline', agent: undefined, hash: '#/r/alpha' })
    expect(hashFor(plan, 'agent', 'a1')).toBe('#/r/alpha')
  })

  it('hashFor builds the agent route, encoded', () => {
    expect(hashFor(fix, 'agent', 'a/1')).toBe('#/r/fix-scroll/agent/a%2F1')
  })
})
