import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Board } from '@openaflow/model'
import {
  createBoardStream,
  healthProbe,
  PROBE_EVERY_MS,
  PROBE_TIMEOUT_MS,
  type StreamSource,
  type StreamState,
} from './board-stream.ts'

type Listener = (ev: { data?: unknown }) => void

/** A stand-in EventSource: the test fires its events by hand. */
class FakeSource implements StreamSource {
  closed = false
  private listeners = new Map<string, Listener[]>()
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
  }
  fire(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data })
  }
}

const board = (generatedAt: number): Board => ({ generatedAt, gh: 'ok', repos: [] })

describe('reconnects and keeps the last board', () => {
  let sources: FakeSource[]
  let boards: Board[]
  let states: StreamState[]
  const last = () => {
    expect(sources.length, 'no source opened').toBeGreaterThan(0)
    return sources[sources.length - 1]!
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sources = []
    boards = []
    states = []
  })
  afterEach(() => vi.useRealTimers())

  const start = () =>
    createBoardStream(
      () => {
        const s = new FakeSource()
        sources.push(s)
        return s
      },
      (b) => boards.push(b),
      (s) => states.push(s),
    )

  it('starts connecting, then goes live on the first board', () => {
    start()
    expect(states).toEqual(['connecting'])
    expect(sources).toHaveLength(1)
    last().fire('board', JSON.stringify(board(1)))
    expect(boards).toEqual([board(1)])
    expect(states).toEqual(['connecting', 'live'])
    last().fire('board', JSON.stringify(board(2)))
    expect(boards).toEqual([board(1), board(2)])
    expect(states).toEqual(['connecting', 'live'])
  })

  it('on error shows lost, closes the source, and keeps the last board', () => {
    start()
    last().fire('board', JSON.stringify(board(1)))
    last().fire('error')
    expect(states.at(-1)).toBe('lost')
    expect(sources[0]!.closed).toBe(true)
    expect(boards).toEqual([board(1)])
  })

  it('waits 1, 2, 4, 8, 16, then 30 s at most between tries', () => {
    start()
    const waits = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (const [i, ms] of waits.entries()) {
      last().fire('error')
      expect(sources).toHaveLength(i + 1)
      vi.advanceTimersByTime(ms - 1)
      expect(sources).toHaveLength(i + 1)
      vi.advanceTimersByTime(1)
      expect(sources).toHaveLength(i + 2)
    }
  })

  it('stays lost while retrying, and goes live again when a board arrives', () => {
    start()
    last().fire('error')
    vi.advanceTimersByTime(1000)
    expect(states).toEqual(['connecting', 'lost'])
    last().fire('board', JSON.stringify(board(3)))
    expect(states).toEqual(['connecting', 'lost', 'live'])
    expect(boards).toEqual([board(3)])
  })

  it('resets the delay to 1 s after a success', () => {
    start()
    last().fire('error')
    vi.advanceTimersByTime(1000)
    last().fire('error')
    vi.advanceTimersByTime(2000)
    last().fire('error')
    vi.advanceTimersByTime(4000)
    last().fire('board', JSON.stringify(board(1)))
    last().fire('error')
    expect(sources).toHaveLength(4)
    vi.advanceTimersByTime(1000)
    expect(sources).toHaveLength(5)
  })

  it('a burst of errors from one source schedules one reconnect', () => {
    start()
    const first = last()
    first.fire('error')
    first.fire('error')
    vi.advanceTimersByTime(1000)
    expect(sources).toHaveLength(2)
    first.fire('error')
    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(2)
  })

  it('ignores bad data: not JSON, not a board, or no data', () => {
    start()
    last().fire('board', JSON.stringify(board(1)))
    for (const bad of ['{nope', 'null', '[]', '42', JSON.stringify({ repos: 'x' }), JSON.stringify({ generatedAt: 1 }), undefined]) {
      last().fire('board', bad)
    }
    expect(boards).toEqual([board(1)])
    expect(states).toEqual(['connecting', 'live'])
  })

  it('bad data on a new connection does not count as a success', () => {
    start()
    last().fire('error')
    vi.advanceTimersByTime(1000)
    last().fire('board', '{nope')
    expect(states.at(-1)).toBe('lost')
  })

  it('stop closes the source, cancels the retry, and drops later events', () => {
    const stream = start()
    last().fire('error')
    stream.stop()
    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(1)
    const live = start()
    const s = last()
    live.stop()
    expect(s.closed).toBe(true)
    s.fire('board', JSON.stringify(board(9)))
    expect(boards).toEqual([])
  })

  it('a failing factory counts as an error and is retried', () => {
    let calls = 0
    const got: StreamState[] = []
    createBoardStream(
      () => {
        calls += 1
        if (calls === 1) throw new Error('no EventSource')
        const s = new FakeSource()
        sources.push(s)
        return s
      },
      () => {},
      (s) => got.push(s),
    )
    expect(got).toEqual(['connecting', 'lost'])
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(2)
  })
})

describe('notices a dead server behind a proxy that keeps the stream open', () => {
  let sources: FakeSource[]
  let states: StreamState[]
  beforeEach(() => {
    vi.useFakeTimers()
    sources = []
    states = []
  })
  afterEach(() => vi.useRealTimers())

  const start = (probe: () => Promise<boolean>) =>
    createBoardStream(
      () => {
        const s = new FakeSource()
        sources.push(s)
        return s
      },
      () => {},
      (s) => states.push(s),
      { probe },
    )

  it('a failed health probe while connected counts as an error', async () => {
    let healthy = true
    start(async () => healthy)
    sources[0]!.fire('board', JSON.stringify(board(1)))
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS)
    expect(states).toEqual(['connecting', 'live'])
    healthy = false
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS)
    expect(states).toEqual(['connecting', 'live', 'lost'])
    expect(sources[0]!.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources).toHaveLength(2)
  })

  it('a probe that throws counts as an error', async () => {
    start(async () => {
      throw new TypeError('Failed to fetch')
    })
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS)
    expect(states.at(-1)).toBe('lost')
  })

  it('no probes while waiting to reconnect, and none after stop', async () => {
    let calls = 0
    const stream = start(async () => {
      calls += 1
      return true
    })
    sources[0]!.fire('error')
    await vi.advanceTimersByTimeAsync(900)
    expect(calls).toBe(0)
    stream.stop()
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 3)
    expect(calls).toBe(0)
  })

  it('a slow probe is not stacked, and its late answer after stop does nothing', async () => {
    let calls = 0
    let answer: (ok: boolean) => void = () => {}
    const stream = start(() => {
      calls += 1
      return new Promise<boolean>((r) => (answer = r))
    })
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 3)
    expect(calls).toBe(1)
    stream.stop()
    answer(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual(['connecting'])
  })
})

/** A fetch that never answers, and rejects once its signal aborts, as fetch does. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })) as typeof fetch

describe('the health probe gives up on a hung request', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects once a request hangs past PROBE_TIMEOUT_MS', async () => {
    const p = healthProbe(hangingFetch)
    const settled = p.then(
      () => 'resolved',
      () => 'rejected',
    )
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe('rejected')
  })

  it('a quick answer leaves no timer behind', async () => {
    expect(await healthProbe((async () => new Response(null, { status: 200 })) as typeof fetch)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a hung health request turns a live stream lost', async () => {
    const sources: FakeSource[] = []
    const states: StreamState[] = []
    createBoardStream(
      () => {
        const s = new FakeSource()
        sources.push(s)
        return s
      },
      () => {},
      (s) => states.push(s),
      { probe: () => healthProbe(hangingFetch) },
    )
    sources[0]!.fire('board', JSON.stringify(board(1)))
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS + PROBE_TIMEOUT_MS)
    expect(states.at(-1)).toBe('lost')
    expect(sources[0]!.closed).toBe(true)
  })
})
