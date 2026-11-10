import { describe, expect, it } from 'vitest'
import type { AgentTimeline } from '@openaflow/model'
import { createTimelineLoader, timelineUrl, type FetchJson, type JsonReply, type TimelineKey, type TimelineState } from './timeline-loader.ts'

/** A fetch the test answers by hand, one request at a time. */
function fakeFetch() {
  const calls: { url: string; answer: (r: JsonReply) => Promise<void>; fail: () => Promise<void> }[] = []
  const fetchJson: FetchJson = (url) =>
    new Promise<JsonReply>((resolve, reject) => {
      const settle = async () => {
        // Let the loader's then-handlers run before the test looks.
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      calls.push({
        url,
        answer: async (r) => {
          resolve(r)
          await settle()
        },
        fail: async () => {
          reject(new Error('network down'))
          await settle()
        },
      })
    })
  return { fetchJson, calls }
}

const timeline = (agentId: string, n: number): AgentTimeline => ({
  agentId,
  events: Array.from({ length: n }, (_, i) => ({ at: 1000 + i, tool: 'Read', summary: `Read f${i}.ts`, result: 'ok' as const })),
  total: n,
  tests: { testFiles: 0, runs: 0, failedRuns: 0 },
})

const ok = (t: AgentTimeline): JsonReply => ({ status: 200, body: t })
const key = (agentId: string, lastAt?: number, ended = false): TimelineKey => ({
  repoId: 'repo1',
  agentId,
  ...(lastAt === undefined ? {} : { lastAt }),
  ended,
})

function setup() {
  const f = fakeFetch()
  const states: TimelineState[] = []
  const loader = createTimelineLoader(f.fetchJson, (s) => states.push(s))
  const last = () => states[states.length - 1]
  return { ...f, states, loader, last }
}

describe('fetches once per change', () => {
  it('fetches on a new key, then shows the timeline', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/agents/repo1/a1/timeline')
    expect(last()).toEqual({ kind: 'loading' })
    await calls[0]!.answer(ok(timeline('a1', 2)))
    expect(last()).toEqual({ kind: 'ready', timeline: timeline('a1', 2) })
  })

  it('the same key twice gives one request, before and after it returns', async () => {
    const { loader, calls } = setup()
    loader.show(key('a1', 10))
    loader.show(key('a1', 10))
    expect(calls).toHaveLength(1)
    await calls[0]!.answer(ok(timeline('a1', 1)))
    loader.show(key('a1', 10))
    expect(calls).toHaveLength(1)
  })

  it('a new lastAt or a change to ended is a new key', async () => {
    const { loader, calls } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.answer(ok(timeline('a1', 1)))
    loader.show(key('a1', 20))
    expect(calls).toHaveLength(2)
    await calls[1]!.answer(ok(timeline('a1', 2)))
    loader.show(key('a1', 20, true))
    expect(calls).toHaveLength(3)
  })

  it('a key change mid-flight waits, then fetches once more for the latest key; the older response is dropped', async () => {
    const { loader, calls, states, last } = setup()
    loader.show(key('a1', 10))
    loader.show(key('a1', 20))
    loader.show(key('a1', 30))
    expect(calls, 'at most one request in flight').toHaveLength(1)
    await calls[0]!.answer(ok(timeline('a1', 1)))
    expect(states.some((s) => s.kind === 'ready'), 'older response dropped').toBe(false)
    expect(calls).toHaveLength(2)
    await calls[1]!.answer(ok(timeline('a1', 3)))
    expect(calls).toHaveLength(2)
    expect(last()).toEqual({ kind: 'ready', timeline: timeline('a1', 3) })
  })

  it('a key that changes and comes back mid-flight takes the response, with no second request', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    loader.show(key('b2', 5))
    loader.show(key('a1', 10))
    await calls[0]!.answer(ok(timeline('a1', 1)))
    expect(calls).toHaveLength(1)
    expect(last()).toEqual({ kind: 'ready', timeline: timeline('a1', 1) })
  })

  it('a newer key of the same agent keeps the last timeline while loading; another agent starts empty', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.answer(ok(timeline('a1', 1)))
    loader.show(key('a1', 20))
    expect(last()).toEqual({ kind: 'loading', timeline: timeline('a1', 1) })
    await calls[1]!.answer(ok(timeline('a1', 2)))
    loader.show(key('b2', 20))
    expect(last()).toEqual({ kind: 'loading' })
  })

  it('URI-encodes both ids', () => {
    expect(timelineUrl({ repoId: 'a/b c', agentId: 'x?y', ended: false })).toBe('/api/agents/a%2Fb%20c/x%3Fy/timeline')
  })
})

describe('missing and errors', () => {
  it('404 → missing', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.answer({ status: 404, body: { error: 'not found' } })
    expect(last()).toEqual({ kind: 'missing' })
  })

  it('an error keeps the last timeline of the same agent', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.answer(ok(timeline('a1', 1)))
    loader.show(key('a1', 20))
    await calls[1]!.fail()
    expect(last()).toEqual({ kind: 'error', timeline: timeline('a1', 1) })
    loader.show(key('a1', 30))
    await calls[2]!.answer({ status: 500, body: undefined })
    expect(last()).toEqual({ kind: 'error', timeline: timeline('a1', 1) })
  })

  it('a 200 that is not a timeline, or is another agent’s, is an error', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.answer({ status: 200, body: { events: 'nope' } })
    expect(last()).toEqual({ kind: 'error' })
    loader.show(key('a1', 11))
    await calls[1]!.answer(ok(timeline('zz', 1)))
    expect(last()).toEqual({ kind: 'error' })
  })

  it('an error is not retried for the same key; the next key fetches again', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.fail()
    loader.show(key('a1', 10))
    expect(calls).toHaveLength(1)
    loader.show(key('a1', 11))
    expect(calls).toHaveLength(2)
    await calls[1]!.answer(ok(timeline('a1', 1)))
    expect(last()).toEqual({ kind: 'ready', timeline: timeline('a1', 1) })
  })

  it('show(undefined) → idle, and drops the response in flight', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    loader.show(undefined)
    expect(last()).toEqual({ kind: 'idle' })
    await calls[0]!.answer(ok(timeline('a1', 1)))
    expect(last()).toEqual({ kind: 'idle' })
    expect(calls).toHaveLength(1)
  })

  it('show(undefined) after a timeline forgets it', async () => {
    const { loader, calls, last } = setup()
    loader.show(key('a1', 10))
    await calls[0]!.answer(ok(timeline('a1', 1)))
    loader.show(undefined)
    loader.show(key('a1', 10))
    expect(calls).toHaveLength(2)
    expect(last()).toEqual({ kind: 'loading' })
  })

  it('stop cancels: no state after it, and no more requests', async () => {
    const { loader, calls, states } = setup()
    loader.show(key('a1', 10))
    loader.show(key('a1', 20))
    const before = states.length
    loader.stop()
    await calls[0]!.answer(ok(timeline('a1', 1)))
    expect(states).toHaveLength(before)
    expect(calls).toHaveLength(1)
    loader.show(key('b2', 1))
    expect(calls).toHaveLength(1)
    expect(states).toHaveLength(before)
  })
})
