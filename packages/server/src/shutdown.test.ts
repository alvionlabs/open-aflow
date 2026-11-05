import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createShutdown, createWorkTracker, DRAIN_CAP_MS } from './shutdown.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Fakes for everything shutdown touches; `calls` records the order. */
function fakes(o: { work?: Promise<void>; workSize?: number; auto?: Promise<void> } = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const deps = {
    auto: { stop: () => calls.push('auto.stop'), settled: () => o.auto ?? Promise.resolve() },
    server: { close: () => calls.push('server.close') },
    work: { size: () => o.workSize ?? 0, settled: () => o.work ?? Promise.resolve() },
    watcher: { close: async () => void calls.push('watcher.close') },
    exit: (code: number) => void calls.push(`exit ${code}`),
    log: (m: string) => void logs.push(m),
  }
  return { calls, logs, deps }
}

describe('createShutdown', () => {
  test('with nothing running, stops intake, closes the watcher, and exits 0 at once', async () => {
    const f = fakes()
    const stop = createShutdown(f.deps)
    stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toEqual(['auto.stop', 'server.close', 'watcher.close', 'exit 0'])
    expect(f.logs).toEqual([])
  })

  test('waits for an action in flight, and says so', async () => {
    let release!: () => void
    const work = new Promise<void>((r) => (release = r))
    const f = fakes({ work, workSize: 1 })
    const stop = createShutdown(f.deps)
    stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.calls).toEqual(['auto.stop', 'server.close'])
    expect(f.logs).toHaveLength(1)
    expect(f.logs[0]).toContain('1 action')
    expect(f.logs[0]).toContain('Ctrl+C again')
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.slice(-2)).toEqual(['watcher.close', 'exit 0'])
  })

  test('waits for an auto-continue send in flight', async () => {
    let release!: () => void
    const auto = new Promise<void>((r) => (release = r))
    const f = fakes({ auto, workSize: 0 })
    const stop = createShutdown(f.deps)
    stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.calls).toEqual(['auto.stop', 'server.close'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.slice(-2)).toEqual(['watcher.close', 'exit 0'])
  })

  test('gives up waiting after DRAIN_CAP_MS', async () => {
    const f = fakes({ work: new Promise<void>(() => {}), workSize: 1 })
    const stop = createShutdown(f.deps)
    stop()
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS - 1)
    expect(f.calls).not.toContain('exit 0')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.calls.slice(-2)).toEqual(['watcher.close', 'exit 0'])
  })

  test('a second signal quits at once with code 1', async () => {
    const f = fakes({ work: new Promise<void>(() => {}), workSize: 1 })
    const stop = createShutdown(f.deps)
    stop()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    expect(f.calls.at(-1)).toBe('exit 1')
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS)
    expect(f.calls).not.toContain('exit 0')
  })

  test('releases after the drain', async () => {
    let finish!: () => void
    const work = new Promise<void>((r) => (finish = r))
    const f = fakes({ work, workSize: 1 })
    const stop = createShutdown({ ...f.deps, release: () => void f.calls.push('release') })
    stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.calls).not.toContain('release')
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.slice(-3)).toEqual(['watcher.close', 'release', 'exit 0'])

    // A throwing release still exits.
    const g = fakes()
    const stopG = createShutdown({
      ...g.deps,
      release: () => {
        g.calls.push('release')
        throw new Error('x')
      },
    })
    stopG()
    await vi.advanceTimersByTimeAsync(0)
    expect(g.calls.slice(-2)).toEqual(['release', 'exit 0'])

    // A drain that hits its cap is still a normal stop.
    const h = fakes({ work: new Promise<void>(() => {}), workSize: 1 })
    const stopH = createShutdown({ ...h.deps, release: () => void h.calls.push('release') })
    stopH()
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS)
    expect(h.calls.slice(-2)).toEqual(['release', 'exit 0'])
  })

  test('a forced quit does not release', async () => {
    const f = fakes({ work: new Promise<void>(() => {}), workSize: 1 })
    const stop = createShutdown({ ...f.deps, release: () => void f.calls.push('release') })
    stop()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    expect(f.calls.at(-1)).toBe('exit 1')
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS)
    expect(f.calls).not.toContain('release')
  })

  test('a watcher that fails to close still exits 0', async () => {
    const f = fakes()
    f.deps.watcher.close = async () => {
      throw new Error('x')
    }
    const stop = createShutdown(f.deps)
    stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls.at(-1)).toBe('exit 0')
  })
})

describe('createWorkTracker', () => {
  test('counts a request until its handler finishes', async () => {
    const work = createWorkTracker()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const app = new Hono().use('*', work.track).post('/x', async (c) => {
      await gate
      return c.text('ok')
    })
    const res = app.request('http://127.0.0.1/x', { method: 'POST' })
    await vi.advanceTimersByTimeAsync(0)
    expect(work.size()).toBe(1)
    let settled = false
    void work.settled().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    release()
    expect((await res).status).toBe(200)
    await vi.advanceTimersByTimeAsync(0)
    expect(work.size()).toBe(0)
    expect(settled).toBe(true)
  })

  test('a handler that throws is still uncounted', async () => {
    const work = createWorkTracker()
    const app = new Hono().use('*', work.track).post('/x', () => {
      throw new Error('boom')
    })
    const res = await app.request('http://127.0.0.1/x', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(work.size()).toBe(0)
  })

  test('settled resolves at once with nothing running', async () => {
    const work = createWorkTracker()
    await work.settled()
  })
})
