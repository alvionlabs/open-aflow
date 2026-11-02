import { describe, expect, test } from 'vitest'
import { createExec, createGhReader, type ExecResult, type GhExec } from './gh.ts'

const REPO = 'E:\\Projects\\chess-web'
const PR_FIELDS = 'number,state,url,statusCheckRollup,baseRefName,mergedAt'

type Call = { args: string[]; cwd: string }

function prJson(n: number, state: string, rollup: unknown[] | null = [], url = `https://github.com/o/r/pull/${n}`) {
  return JSON.stringify({ number: n, state, url, statusCheckRollup: rollup })
}

const run = (conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name: 'verify',
  status,
  conclusion: conclusion ?? '',
})
const ctx = (state: string) => ({ __typename: 'StatusContext', context: 'ci', state })

/** A fake `gh`: records every call; answers auth and pr view from mutable settings. */
type FakeGh = {
  calls: Call[]
  auth: ExecResult['status']
  prs: Map<number, ExecResult>
  hold: boolean
  waiting: (() => void)[]
  release(): void
  prViews(): number
  authCalls(): number
  exec: GhExec
}

function fakeGh(): FakeGh {
  const calls: Call[] = []
  const gh: FakeGh = {
    calls,
    auth: 'ok',
    prs: new Map<number, ExecResult>(),
    /** When set, pr view calls wait until `release()` is called. */
    hold: false,
    waiting: [],
    release() {
      for (const w of gh.waiting.splice(0)) w()
    },
    prViews: () => calls.filter((c) => c.args[0] === 'pr').length,
    authCalls: () => calls.filter((c) => c.args[0] === 'auth').length,
    exec: async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'auth') return { status: gh.auth, stdout: '' }
      if (gh.hold) await new Promise<void>((r) => gh.waiting.push(r))
      const n = Number(args[2])
      return gh.prs.get(n) ?? { status: 'failed', stdout: '' }
    },
  }
  return gh
}

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) }
  return c
}

const ok = (stdout: string): ExecResult => ({ status: 'ok', stdout })

describe('createGhReader', () => {
  test('runs only read-only commands', async () => {
    const gh = fakeGh()
    const c = clock()
    gh.prs.set(7, ok(prJson(7, 'OPEN')))
    gh.prs.set(9, ok(prJson(9, 'MERGED')))
    const reader = createGhReader({ exec: gh.exec, now: c.now })

    await reader.refresh(REPO, [7, 9])
    c.advance(61_000)
    await reader.refresh(REPO, [7, 9, 7])
    gh.auth = 'failed'
    c.advance(61_000)
    await reader.refresh(REPO, [7])

    expect(gh.calls.length).toBeGreaterThan(0)
    for (const call of gh.calls) {
      expect(call.cwd).toBe(REPO)
      const isAuth = call.args.length === 2 && call.args[0] === 'auth' && call.args[1] === 'status'
      const isView =
        call.args.length === 5 &&
        call.args[0] === 'pr' &&
        call.args[1] === 'view' &&
        /^[1-9]\d*$/.test(call.args[2] ?? '') &&
        call.args[3] === '--json' &&
        call.args[4] === PR_FIELDS
      expect(isAuth || isView, JSON.stringify(call.args)).toBe(true)
    }
    expect(gh.prViews()).toBe(3)
  })

  test('never passes a bad PR number to gh', async () => {
    const gh = fakeGh()
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(gh.prViews()).toBe(0)
  })

  describe('gh status', () => {
    test('starts unknown with no check time', () => {
      const reader = createGhReader({ exec: fakeGh().exec, now: clock().now })
      expect(reader.status()).toBe('unknown')
      expect(reader.checkedAt()).toBeUndefined()
    })

    test('ok after a passing auth status, with its check time', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.prs.set(1, ok(prJson(1, 'OPEN')))
      const reader = createGhReader({ exec: gh.exec, now: c.now })
      expect(await reader.refresh(REPO, [1])).toBe(true)
      expect(reader.status()).toBe('ok')
      expect(reader.checkedAt()).toBe(c.t)
    })

    test('gh not found → missing, and no pr view runs', async () => {
      const gh = fakeGh()
      gh.auth = 'not-found'
      const reader = createGhReader({ exec: gh.exec, now: clock().now })
      expect(await reader.refresh(REPO, [1])).toBe(true)
      expect(reader.status()).toBe('missing')
      expect(gh.prViews()).toBe(0)
    })

    test('auth fails → logged-out with no pr view; recheck after 60 s, not before', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.auth = 'failed'
      gh.prs.set(1, ok(prJson(1, 'OPEN')))
      const reader = createGhReader({ exec: gh.exec, now: c.now })

      expect(await reader.refresh(REPO, [1])).toBe(true)
      expect(reader.status()).toBe('logged-out')
      expect(reader.checkedAt()).toBe(c.t)
      expect(gh.prViews()).toBe(0)
      expect(gh.authCalls()).toBe(1)

      gh.auth = 'ok'
      c.advance(59_999)
      expect(await reader.refresh(REPO, [1])).toBe(false)
      expect(reader.status()).toBe('logged-out')
      expect(gh.authCalls()).toBe(1)
      expect(gh.prViews()).toBe(0)

      c.advance(1)
      expect(await reader.refresh(REPO, [1])).toBe(true)
      expect(reader.status()).toBe('ok')
      expect(gh.authCalls()).toBe(2)
      expect(gh.prViews()).toBe(1)
      expect(reader.get(REPO, 1)?.state).toBe('open')
    })

    test('a missing gh is rechecked after 60 s too', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.auth = 'not-found'
      const reader = createGhReader({ exec: gh.exec, now: c.now })
      await reader.refresh(REPO, [])
      c.advance(30_000)
      await reader.refresh(REPO, [])
      expect(gh.authCalls()).toBe(1)
      gh.auth = 'ok'
      c.advance(30_000)
      await reader.refresh(REPO, [])
      expect(reader.status()).toBe('ok')
    })

    test('logging out later is noticed within 60 s, and the last PR values stay', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.prs.set(1, ok(prJson(1, 'OPEN')))
      const reader = createGhReader({ exec: gh.exec, now: c.now })
      await reader.refresh(REPO, [1])
      gh.auth = 'failed'
      c.advance(60_000)
      expect(await reader.refresh(REPO, [1])).toBe(true)
      expect(reader.status()).toBe('logged-out')
      expect(gh.prViews()).toBe(1)
      expect(reader.get(REPO, 1)?.state).toBe('open')
    })

    test('gh vanishing during pr view → missing', async () => {
      const gh = fakeGh()
      gh.prs.set(1, { status: 'not-found', stdout: '' })
      const reader = createGhReader({ exec: gh.exec, now: clock().now })
      await reader.refresh(REPO, [1])
      expect(reader.status()).toBe('missing')
      expect(reader.get(REPO, 1)).toBeUndefined()
    })

    test('two refreshes at once share one auth status call', async () => {
      const gh = fakeGh()
      const reader = createGhReader({ exec: gh.exec, now: clock().now })
      await Promise.all([reader.refresh(REPO, []), reader.refresh(REPO, [])])
      expect(gh.authCalls()).toBe(1)
    })
  })

  test('caches each PR for 30 seconds', async () => {
    const gh = fakeGh()
    const c = clock()
    gh.prs.set(5, ok(prJson(5, 'OPEN', [run(null, 'IN_PROGRESS')])))
    const reader = createGhReader({ exec: gh.exec, now: c.now })

    expect(await reader.refresh(REPO, [5])).toBe(true)
    expect(gh.prViews()).toBe(1)
    expect(reader.get(REPO, 5)).toEqual({
      number: 5,
      state: 'open',
      checks: 'pending',
      url: 'https://github.com/o/r/pull/5',
      checkedAt: c.t,
    })

    // A second ask within 30 s makes no call.
    c.advance(29_999)
    expect(await reader.refresh(REPO, [5])).toBe(false)
    expect(gh.prViews()).toBe(1)

    // After 30 s it does; unchanged values report no change but update checkedAt.
    c.advance(1)
    expect(await reader.refresh(REPO, [5])).toBe(false)
    expect(gh.prViews()).toBe(2)
    expect(reader.get(REPO, 5)?.checkedAt).toBe(c.t)

    // A changed value reports a change.
    gh.prs.set(5, ok(prJson(5, 'OPEN', [run('SUCCESS')])))
    c.advance(30_000)
    expect(await reader.refresh(REPO, [5])).toBe(true)
    expect(reader.get(REPO, 5)?.checks).toBe('pass')

    // Two asks at once make one call, and both see the value.
    gh.hold = true
    c.advance(30_000)
    const a = reader.refresh(REPO, [5])
    const b = reader.refresh(REPO, [5])
    await new Promise((r) => setTimeout(r, 0))
    gh.release()
    await Promise.all([a, b])
    expect(gh.prViews()).toBe(4)

    // Duplicates in one ask make one call.
    gh.hold = false
    c.advance(30_000)
    await reader.refresh(REPO, [5, 5, 5])
    expect(gh.prViews()).toBe(5)
  })

  test('caches per repo folder', async () => {
    const gh = fakeGh()
    gh.prs.set(1, ok(prJson(1, 'OPEN')))
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [1])
    expect(reader.get('E:\\Projects\\other', 1)).toBeUndefined()
    await reader.refresh('E:\\Projects\\other', [1])
    expect(gh.prViews()).toBe(2)
    expect(gh.calls.at(-1)?.cwd).toBe('E:\\Projects\\other')
  })

  describe('final and failed PRs', () => {
    test('a merged or closed PR is never fetched again', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.prs.set(1, ok(prJson(1, 'MERGED')))
      gh.prs.set(2, ok(prJson(2, 'CLOSED')))
      const reader = createGhReader({ exec: gh.exec, now: c.now })
      await reader.refresh(REPO, [1, 2])
      expect(gh.prViews()).toBe(2)
      for (let i = 0; i < 5; i++) {
        c.advance(10 * 60_000)
        expect(await reader.refresh(REPO, [1, 2])).toBe(false)
      }
      expect(gh.prViews()).toBe(2)
      expect(reader.get(REPO, 1)?.state).toBe('merged')
      expect(reader.get(REPO, 2)?.state).toBe('closed')
    })

    test('a failed fetch keeps the last value', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.prs.set(3, ok(prJson(3, 'OPEN', [run('SUCCESS')])))
      const reader = createGhReader({ exec: gh.exec, now: c.now })
      await reader.refresh(REPO, [3])
      const before = reader.get(REPO, 3)

      gh.prs.set(3, { status: 'failed', stdout: '' })
      c.advance(30_000)
      expect(await reader.refresh(REPO, [3])).toBe(false)
      expect(reader.get(REPO, 3)).toEqual(before)

      // Unparseable output counts as a failure too.
      gh.prs.set(3, ok('not json'))
      c.advance(30_000)
      expect(await reader.refresh(REPO, [3])).toBe(false)
      expect(reader.get(REPO, 3)).toEqual(before)

      gh.prs.set(3, ok(JSON.stringify({ number: 3, state: 'WEIRD' })))
      c.advance(30_000)
      expect(await reader.refresh(REPO, [3])).toBe(false)
      expect(reader.get(REPO, 3)).toEqual(before)
    })

    test('a failed fetch still waits 30 s before the next try', async () => {
      const gh = fakeGh()
      const c = clock()
      gh.prs.set(3, { status: 'failed', stdout: '' })
      const reader = createGhReader({ exec: gh.exec, now: c.now })
      await reader.refresh(REPO, [3])
      c.advance(10_000)
      await reader.refresh(REPO, [3])
      expect(gh.prViews()).toBe(1)
      expect(reader.get(REPO, 3)).toBeUndefined()
    })

    test('an exec that throws counts as a failed fetch', async () => {
      const gh = fakeGh()
      const exec: GhExec = async (args, cwd) => {
        if (args[0] === 'pr') throw new Error('boom')
        return gh.exec(args, cwd)
      }
      const reader = createGhReader({ exec, now: clock().now })
      await expect(reader.refresh(REPO, [3])).resolves.toBe(true)
      expect(reader.status()).toBe('ok')
      expect(reader.get(REPO, 3)).toBeUndefined()
    })
  })

  describe('maps pr view output', () => {
    async function view(stdout: string) {
      const gh = fakeGh()
      gh.prs.set(4, ok(stdout))
      const reader = createGhReader({ exec: gh.exec, now: clock().now })
      await reader.refresh(REPO, [4])
      return reader.get(REPO, 4)
    }
    const checks = async (rollup: unknown[] | null) => (await view(prJson(4, 'OPEN', rollup)))?.checks

    test('state', async () => {
      expect((await view(prJson(4, 'OPEN')))?.state).toBe('open')
      expect((await view(prJson(4, 'MERGED')))?.state).toBe('merged')
      expect((await view(prJson(4, 'CLOSED')))?.state).toBe('closed')
    })

    test('base branch', async () => {
      const gh = fakeGh()
      gh.prs.set(80, ok(JSON.stringify({ number: 80, state: 'OPEN', url: 'u', statusCheckRollup: [], baseRefName: 'pod-staging' })))
      const reader = createGhReader({ exec: gh.exec, now: clock().now })
      await reader.refresh(REPO, [80])
      expect(reader.get(REPO, 80)?.base).toBe('pod-staging')
    })

    test('merge time', async () => {
      const gh = fakeGh()
      gh.prs.set(80, ok(JSON.stringify({ number: 80, state: 'MERGED', url: 'u', statusCheckRollup: [], mergedAt: '2026-10-30T10:00:00Z' })))
      gh.prs.set(81, ok(JSON.stringify({ number: 81, state: 'OPEN', url: 'u', statusCheckRollup: [], mergedAt: null })))
      gh.prs.set(82, ok(JSON.stringify({ number: 82, state: 'MERGED', url: 'u', statusCheckRollup: [], mergedAt: 'soon' })))
      const reader = createGhReader({ exec: gh.exec, now: clock().now })
      await reader.refresh(REPO, [80, 81, 82])
      expect(reader.get(REPO, 80)?.mergedAt).toBe(Date.UTC(2026, 9, 30, 10))
      // No time, or one that isn't a date: left out.
      expect(reader.get(REPO, 81)).not.toHaveProperty('mergedAt')
      expect(reader.get(REPO, 82)).not.toHaveProperty('mergedAt')
    })

    test('url', async () => {
      expect((await view(prJson(4, 'OPEN')))?.url).toBe('https://github.com/o/r/pull/4')
      const noUrl = await view(JSON.stringify({ number: 4, state: 'OPEN', statusCheckRollup: [] }))
      expect(noUrl).toBeDefined()
      expect(noUrl?.url).toBeUndefined()
    })

    test('no rollup → none', async () => {
      expect(await checks([])).toBe('none')
      expect(await checks(null)).toBe('none')
      expect((await view(JSON.stringify({ number: 4, state: 'OPEN' })))?.checks).toBe('none')
    })

    test('any failed, errored, cancelled, or timed-out → fail', async () => {
      for (const c of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']) {
        expect(await checks([run('SUCCESS'), run(c)]), c).toBe('fail')
      }
      expect(await checks([ctx('SUCCESS'), ctx('FAILURE')])).toBe('fail')
      expect(await checks([ctx('ERROR')])).toBe('fail')
      // A failure wins over a check still running.
      expect(await checks([run(null, 'IN_PROGRESS'), run('FAILURE')])).toBe('fail')
    })

    test('any not completed → pending', async () => {
      for (const s of ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']) {
        expect(await checks([run('SUCCESS'), run(null, s)]), s).toBe('pending')
      }
      expect(await checks([ctx('PENDING')])).toBe('pending')
      expect(await checks([ctx('EXPECTED')])).toBe('pending')
    })

    test('else pass', async () => {
      expect(await checks([run('SUCCESS'), run('NEUTRAL'), run('SKIPPED'), ctx('SUCCESS')])).toBe('pass')
    })

    test('real gh output', async () => {
      const real = JSON.stringify({
        number: 4,
        state: 'MERGED',
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            completedAt: '2026-10-19T05:30:10Z',
            conclusion: 'SUCCESS',
            name: 'verify (ubuntu-latest)',
            status: 'COMPLETED',
            workflowName: 'pod-ci',
          },
        ],
        url: 'https://github.com/iamphduc/pod-board/pull/3',
      })
      expect(await view(real)).toMatchObject({ number: 4, state: 'merged', checks: 'pass' })
    })
  })
})

describe('PRs found by head branch (fix runs)', () => {
  const LIST_FIELDS = 'number,state,url,statusCheckRollup,baseRefName,mergedAt,headRefName,title'
  const item = (n: number, state: string, head = 'fix-scroll') => ({ number: n, state, url: `https://github.com/o/r/pull/${n}`, statusCheckRollup: [], headRefName: head })

  /** A fake `gh` that answers `pr list --head <b>` from `lists`. */
  function listGh() {
    const calls: string[][] = []
    const lists = new Map<string, ExecResult>()
    const exec: GhExec = async (args) => {
      calls.push(args)
      if (args[0] === 'auth') return { status: 'ok', stdout: '' }
      return lists.get(args[3] ?? '') ?? { status: 'failed', stdout: '' }
    }
    return { calls, lists, exec, lists_: () => calls.filter((a) => a[0] === 'pr').length }
  }

  test('asks gh pr list for the branch, read-only, and keeps the PR with its branch', async () => {
    const gh = listGh()
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'OPEN')])))
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(true)
    expect(gh.calls.filter((a) => a[0] === 'pr')).toEqual([['pr', 'list', '--head', 'fix-scroll', '--state', 'all', '--json', LIST_FIELDS, '--limit', '10']])
    expect(reader.getBranch(REPO, 'fix-scroll')).toEqual({ number: 36, state: 'open', checks: 'none', url: 'https://github.com/o/r/pull/36', checkedAt: 1_000_000, branch: 'fix-scroll' })
  })

  test('an open PR wins; else the newest; entries for another head are ignored', async () => {
    const gh = listGh()
    gh.lists.set('fix-a', ok(JSON.stringify([item(40, 'CLOSED', 'fix-a'), item(38, 'OPEN', 'fix-a'), item(41, 'MERGED', 'fix-a')])))
    gh.lists.set('fix-b', ok(JSON.stringify([item(30, 'CLOSED', 'fix-b'), item(33, 'MERGED', 'fix-b'), item(99, 'OPEN', 'other')])))
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [], ['fix-a', 'fix-b'])
    expect(reader.getBranch(REPO, 'fix-a')?.number).toBe(38)
    expect(reader.getBranch(REPO, 'fix-b')?.number).toBe(33)
  })

  test('no PR yet: nothing, asked again only after the cache time, and true once one opens', async () => {
    const gh = listGh()
    const c = clock()
    gh.lists.set('fix-scroll', ok('[]'))
    const reader = createGhReader({ exec: gh.exec, now: c.now })
    await reader.refresh(REPO, []) // settles gh auth, which counts as a change
    expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(false)
    expect(reader.getBranch(REPO, 'fix-scroll')).toBeUndefined()
    c.advance(10_000)
    await reader.refresh(REPO, [], ['fix-scroll'])
    expect(gh.lists_()).toBe(1)
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'OPEN')])))
    c.advance(30_000)
    expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(true)
    expect(gh.lists_()).toBe(2)
  })

  test('a merged PR is never asked about again; an open one is, and its change is reported', async () => {
    const gh = listGh()
    const c = clock()
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'OPEN')])))
    const reader = createGhReader({ exec: gh.exec, now: c.now })
    await reader.refresh(REPO, [], ['fix-scroll'])
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'MERGED')])))
    c.advance(30_000)
    expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(true)
    expect(reader.getBranch(REPO, 'fix-scroll')?.state).toBe('merged')
    c.advance(10 * 60_000)
    expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(false)
    expect(gh.lists_()).toBe(2)
  })

  test('keeps the base branch, so the board can tell a staging merge target', async () => {
    const gh = listGh()
    gh.lists.set('alpha', ok(JSON.stringify([{ ...item(80, 'MERGED', 'alpha'), baseRefName: 'pod-staging' }])))
    gh.lists.set('fix-b', ok(JSON.stringify([{ ...item(81, 'OPEN', 'fix-b'), baseRefName: 42 }])))
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [], ['alpha', 'fix-b'])
    expect(reader.getBranch(REPO, 'alpha')?.base).toBe('pod-staging')
    // A base that isn't a string is left out.
    expect(reader.getBranch(REPO, 'fix-b')).not.toHaveProperty('base')
  })

  test("keeps the PR's title, so a fix run's header can name it", async () => {
    const gh = listGh()
    gh.lists.set('fix-a', ok(JSON.stringify([{ ...item(80, 'OPEN', 'fix-a'), title: 'fix(runs): calm the header' }])))
    gh.lists.set('fix-b', ok(JSON.stringify([{ ...item(81, 'OPEN', 'fix-b'), title: 7 }])))
    gh.lists.set('fix-c', ok(JSON.stringify([{ ...item(82, 'OPEN', 'fix-c'), title: '' }])))
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [], ['fix-a', 'fix-b', 'fix-c'])
    expect(reader.getBranch(REPO, 'fix-a')?.title).toBe('fix(runs): calm the header')
    // A title that isn't a string, or an empty one, is left out.
    expect(reader.getBranch(REPO, 'fix-b')).not.toHaveProperty('title')
    expect(reader.getBranch(REPO, 'fix-c')).not.toHaveProperty('title')
  })

  test('a staging branch is asked about again after a merge, since every plan reuses it', async () => {
    const gh = listGh()
    const c = clock()
    gh.lists.set('pod-staging', ok(JSON.stringify([item(70, 'MERGED', 'pod-staging')])))
    const reader = createGhReader({ exec: gh.exec, now: c.now })
    await reader.refresh(REPO, [], [], ['pod-staging'])
    expect(reader.getBranch(REPO, 'pod-staging')?.number).toBe(70)
    // Within the cache time: not asked.
    c.advance(10_000)
    await reader.refresh(REPO, [], [], ['pod-staging'])
    expect(gh.lists_()).toBe(1)
    // After it: asked again, and the next plan's open PR shows.
    gh.lists.set('pod-staging', ok(JSON.stringify([item(70, 'MERGED', 'pod-staging'), item(91, 'OPEN', 'pod-staging')])))
    c.advance(30_000)
    expect(await reader.refresh(REPO, [], [], ['pod-staging'])).toBe(true)
    expect(reader.getBranch(REPO, 'pod-staging')?.number).toBe(91)
    expect(gh.lists_()).toBe(2)
    // A bad branch name is never passed.
    await reader.refresh(REPO, [], [], ['--web'])
    expect(gh.calls.some((a) => a.includes('--web'))).toBe(false)
  })

  test('a closed PR found by branch is asked about again, so a reopen or a new PR shows', async () => {
    const gh = listGh()
    const c = clock()
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'CLOSED')])))
    const reader = createGhReader({ exec: gh.exec, now: c.now })
    await reader.refresh(REPO, [], ['fix-scroll'])
    expect(reader.getBranch(REPO, 'fix-scroll')?.state).toBe('closed')
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'OPEN')])))
    c.advance(10_000)
    await reader.refresh(REPO, [], ['fix-scroll'])
    expect(gh.lists_()).toBe(1) // still within the 30 s cache
    c.advance(110_000)
    expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(true)
    expect(reader.getBranch(REPO, 'fix-scroll')?.state).toBe('open')
    // A new PR on the branch after a closed one shows too.
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'CLOSED'), item(37, 'OPEN')])))
    c.advance(30_000)
    await reader.refresh(REPO, [], ['fix-scroll'])
    expect(reader.getBranch(REPO, 'fix-scroll')?.number).toBe(37)
  })

  test('a failed or unreadable list keeps the last value', async () => {
    const gh = listGh()
    const c = clock()
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'OPEN')])))
    const reader = createGhReader({ exec: gh.exec, now: c.now })
    await reader.refresh(REPO, [], ['fix-scroll'])
    for (const bad of [{ status: 'failed' as const, stdout: '' }, ok('nope'), ok('{"number":1}')]) {
      gh.lists.set('fix-scroll', bad)
      c.advance(30_000)
      expect(await reader.refresh(REPO, [], ['fix-scroll'])).toBe(false)
      expect(reader.getBranch(REPO, 'fix-scroll')?.number).toBe(36)
    }
  })

  test('never passes a branch gh could read as a flag or that holds odd characters', async () => {
    const gh = listGh()
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [], ['--web', '-x', '', 'fix a', 'fix;rm', 'fix-\nx', 'fix-ok'])
    expect(gh.calls.filter((a) => a[0] === 'pr').map((a) => a[3])).toEqual(['fix-ok'])
  })

  test('branch and number entries of the same repo do not mix', async () => {
    const gh = listGh()
    gh.lists.set('fix-scroll', ok(JSON.stringify([item(36, 'OPEN')])))
    const reader = createGhReader({ exec: gh.exec, now: clock().now })
    await reader.refresh(REPO, [], ['fix-scroll'])
    expect(reader.get(REPO, 36)).toBeUndefined()
    expect(reader.getBranch('E:\Projects\other', 'fix-scroll')).toBeUndefined()
  })
})

describe('forget and stderr', () => {
  test('forget re-fetches a PR', async () => {
    // stderr is captured, and a timeout counts as failed: a real child process stands in for gh.
    const node = createExec(process.execPath)
    const failed = await node(['-e', "process.stdout.write('out'); process.stderr.write('\u001b[31mboom\u001b[0m'); process.exit(1)"], process.cwd())
    expect(failed).toEqual({ status: 'failed', stdout: 'out', stderr: '\u001b[31mboom\u001b[0m' })
    const passed = await node(['-e', "process.stderr.write('warn')"], process.cwd())
    expect(passed).toEqual({ status: 'ok', stdout: '', stderr: 'warn' })
    const slow = await node(['-e', 'setTimeout(() => {}, 10000)'], process.cwd(), { timeoutMs: 200 })
    expect(slow.status).toBe('failed')

    // A merged PR is final, by number and by branch; forget makes the next refresh ask again.
    const calls: string[][] = []
    const exec: GhExec = async (args) => {
      calls.push(args)
      if (args[0] === 'auth') return ok('')
      if (args[1] === 'list') return ok(JSON.stringify([{ number: 36, state: 'MERGED', url: 'https://github.com/o/r/pull/36', statusCheckRollup: [], headRefName: 'fix-a' }]))
      return ok(prJson(Number(args[2]), args[2] === '36' ? 'MERGED' : 'OPEN'))
    }
    const c = clock()
    const reader = createGhReader({ exec, now: c.now })
    await reader.refresh(REPO, [36, 8], ['fix-a'])
    const prCalls = () => calls.filter((a) => a[0] === 'pr').length
    expect(prCalls()).toBe(3)
    await reader.refresh(REPO, [36, 8], ['fix-a'])
    expect(prCalls()).toBe(3)

    reader.forget(REPO, 36)
    expect(reader.get(REPO, 36)).toBeUndefined()
    expect(reader.getBranch(REPO, 'fix-a')).toBeUndefined()
    await reader.refresh(REPO, [36, 8], ['fix-a'])
    // 36 by number and fix-a by branch again; 8 (open, inside its 30 s) is left alone.
    expect(calls.filter((a) => a[0] === 'pr').slice(3).map((a) => a.slice(0, 4))).toEqual([
      ['pr', 'view', '36', '--json'],
      ['pr', 'list', '--head', 'fix-a'],
    ])
    expect(reader.get(REPO, 36)?.state).toBe('merged')

    // An open PR inside its cache time is fetched again too, and forget on another repo does nothing.
    reader.forget('E:\Projects\other', 8)
    await reader.refresh(REPO, [8])
    expect(prCalls()).toBe(5)
    reader.forget(REPO, 8)
    await reader.refresh(REPO, [8])
    expect(prCalls()).toBe(6)
  })
})
