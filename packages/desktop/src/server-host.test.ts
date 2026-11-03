import { STOP_MESSAGE } from '@pod-board/server/parent-link'
import { DRAIN_CAP_MS } from '@pod-board/server/shutdown'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createServerHost, READY_LIMIT_MS, STABLE_MS, STOP_KILL_MS, type ServerProcess } from './server-host.ts'

type FakeProcess = ServerProcess & {
  sent: unknown[]
  kills: number
  ready(port: number): void
  message(m: unknown): void
  exit(code?: number): void
  output(text: string): void
}

function fakeProcess(pid: number): FakeProcess {
  let onMessage: (m: unknown) => void = () => {}
  let onExit: (code: number) => void = () => {}
  let onOutput: (text: string) => void = () => {}
  const p: FakeProcess = {
    pid,
    sent: [],
    kills: 0,
    postMessage: (m) => void p.sent.push(m),
    kill: () => {
      p.kills++
      return true
    },
    onMessage: (fn) => void (onMessage = fn),
    onExit: (fn) => void (onExit = fn),
    onOutput: (fn) => void (onOutput = fn),
    ready: (port) => onMessage({ type: 'pod-board:ready', port }),
    message: (m) => onMessage(m),
    exit: (code = 1) => onExit(code),
    output: (text) => onOutput(text),
  }
  return p
}

function setup() {
  const procs: FakeProcess[] = []
  const fork = vi.fn(() => {
    const p = fakeProcess(procs.length + 100)
    procs.push(p)
    return p
  })
  const host = createServerHost({ fork })
  const ready = vi.fn()
  const failed = vi.fn()
  host.onReady(ready)
  host.onFailed(failed)
  return { procs, fork, host, ready, failed }
}

const at = <T,>(list: T[], i: number): T => {
  expect(list.length).toBeGreaterThan(i)
  return list[i]!
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the server host', () => {
  test('reads the ready message', () => {
    const s = setup()
    s.host.start()
    const p = at(s.procs, 0)

    for (const bad of [
      undefined,
      null,
      'pod-board:ready',
      7,
      [],
      {},
      { type: 'other', port: 3110 },
      { type: 'pod-board:ready' },
      { type: 'pod-board:ready', port: '3110' },
      { type: 'pod-board:ready', port: 0 },
      { type: 'pod-board:ready', port: -1 },
      { type: 'pod-board:ready', port: 65536 },
      { type: 'pod-board:ready', port: 3110.5 },
      { type: 'pod-board:ready', port: Number.NaN },
    ]) {
      expect(() => p.message(bad)).not.toThrow()
    }
    expect(s.host.port()).toBeUndefined()
    expect(s.ready).not.toHaveBeenCalled()

    p.ready(3110)
    expect(s.host.port()).toBe(3110)
    expect(s.ready.mock.calls).toEqual([[3110]])

    // Once per process.
    p.ready(3999)
    expect(s.host.port()).toBe(3110)
    expect(s.ready).toHaveBeenCalledOnce()
  })

  test('a late listener gets the port', () => {
    const s = setup()
    s.host.start()
    at(s.procs, 0).ready(3110)
    const late = vi.fn()
    const off = s.host.onReady(late)
    expect(late.mock.calls).toEqual([[3110]])

    // Taking the listener off works.
    off()
    at(s.procs, 0).exit()
    at(s.procs, 1).ready(3111)
    expect(late).toHaveBeenCalledOnce()
    expect(s.ready).toHaveBeenCalledTimes(2)
  })

  test.each([0, 1, 3221225477])('restarts once (exit code %d)', (code) => {
    const s = setup()
    s.host.start()
    expect(s.fork).toHaveBeenCalledOnce()
    at(s.procs, 0).ready(3110)

    at(s.procs, 0).exit(code)
    expect(s.fork).toHaveBeenCalledTimes(2)
    expect(s.host.port()).toBeUndefined()
    expect(s.failed).not.toHaveBeenCalled()

    at(s.procs, 1).ready(3111)
    expect(s.host.port()).toBe(3111)
    expect(s.ready.mock.calls).toEqual([[3110], [3111]])

    // The old process has no say any more.
    at(s.procs, 0).ready(3999)
    at(s.procs, 0).exit(1)
    expect(s.host.port()).toBe(3111)
    expect(s.fork).toHaveBeenCalledTimes(2)
  })

  test('a second failure reports the error', () => {
    const s = setup()
    s.host.start()
    at(s.procs, 0).output('first process said this\n')
    at(s.procs, 0).ready(3110)
    at(s.procs, 0).exit()

    at(s.procs, 1).ready(3110)
    vi.advanceTimersByTime(STABLE_MS - 1)
    at(s.procs, 1).output('x'.repeat(3000))
    at(s.procs, 1).output('the end')
    at(s.procs, 1).exit()

    expect(s.fork).toHaveBeenCalledTimes(2)
    expect(s.failed).toHaveBeenCalledOnce()
    const error = s.failed.mock.calls[0]![0] as string
    expect(error).toHaveLength(2000)
    expect(error.endsWith('the end')).toBe(true)
    expect(s.host.port()).toBeUndefined()

    // Nothing starts it again, and a late listener still hears it.
    s.host.start()
    vi.advanceTimersByTime(READY_LIMIT_MS * 2)
    expect(s.fork).toHaveBeenCalledTimes(2)
    const late = vi.fn()
    s.host.onFailed(late)
    expect(late.mock.calls).toEqual([[error]])
    expect(s.failed).toHaveBeenCalledOnce()
  })

  test('a stable server earns its restart back', () => {
    const s = setup()
    s.host.start()
    at(s.procs, 0).ready(3110)
    at(s.procs, 0).exit()
    at(s.procs, 1).ready(3110)

    vi.advanceTimersByTime(STABLE_MS)
    at(s.procs, 1).exit()
    expect(s.fork).toHaveBeenCalledTimes(3)
    expect(s.failed).not.toHaveBeenCalled()

    // That restart is spent again.
    at(s.procs, 2).ready(3110)
    vi.advanceTimersByTime(STABLE_MS - 1)
    at(s.procs, 2).exit()
    expect(s.fork).toHaveBeenCalledTimes(3)
    expect(s.failed).toHaveBeenCalledOnce()
  })

  test('a silent start fails', () => {
    const s = setup()
    s.host.start()
    vi.advanceTimersByTime(READY_LIMIT_MS - 1)
    expect(at(s.procs, 0).kills).toBe(0)

    vi.advanceTimersByTime(1)
    expect(at(s.procs, 0).kills).toBe(1)
    expect(s.fork).toHaveBeenCalledTimes(2)

    // The exit of the killed process isn't a second failure.
    at(s.procs, 0).exit(1)
    expect(s.fork).toHaveBeenCalledTimes(2)
    expect(s.failed).not.toHaveBeenCalled()

    at(s.procs, 1).output('still silent')
    vi.advanceTimersByTime(READY_LIMIT_MS)
    expect(at(s.procs, 1).kills).toBe(1)
    expect(s.fork).toHaveBeenCalledTimes(2)
    expect(s.failed.mock.calls).toEqual([['still silent']])
  })

  test('a ready in time stops the limit', () => {
    const s = setup()
    s.host.start()
    vi.advanceTimersByTime(READY_LIMIT_MS - 1)
    at(s.procs, 0).ready(3110)
    vi.advanceTimersByTime(READY_LIMIT_MS)
    expect(at(s.procs, 0).kills).toBe(0)
    expect(s.fork).toHaveBeenCalledOnce()
  })

  test('stops by message', async () => {
    const s = setup()
    s.host.start()
    const p = at(s.procs, 0)
    p.ready(3110)

    const result = s.host.stop()
    expect(p.sent).toEqual([STOP_MESSAGE])
    p.exit(0)

    await expect(result).resolves.toBe('stopped')
    expect(s.fork).toHaveBeenCalledOnce()
    expect(s.failed).not.toHaveBeenCalled()
    expect(p.kills).toBe(0)
    expect(s.host.port()).toBeUndefined()

    // No timer is left to fire.
    vi.advanceTimersByTime(STOP_KILL_MS * 2)
    expect(p.kills).toBe(0)
    expect(p.sent).toEqual([STOP_MESSAGE])
  })

  test('kills only after the timeout', async () => {
    const s = setup()
    s.host.start()
    const p = at(s.procs, 0)
    p.ready(3110)

    const first = s.host.stop()
    vi.advanceTimersByTime(STOP_KILL_MS - 1)
    expect(p.kills).toBe(0)

    const repeat = s.host.stop()
    expect(p.sent).toEqual([STOP_MESSAGE])
    vi.advanceTimersByTime(1)
    expect(p.kills).toBe(1)

    await expect(first).resolves.toBe('killed')
    await expect(repeat).resolves.toBe('killed')
    await expect(s.host.stop()).resolves.toBe('killed')

    // The exit that follows starts nothing.
    p.exit(1)
    vi.advanceTimersByTime(STOP_KILL_MS)
    expect(p.kills).toBe(1)
    expect(s.fork).toHaveBeenCalledOnce()
    expect(s.failed).not.toHaveBeenCalled()
  })

  test('the timeout outlasts the drain', () => {
    expect(STOP_KILL_MS).toBeGreaterThan(DRAIN_CAP_MS)
    expect(STOP_KILL_MS).toBe(80_000)
    expect(READY_LIMIT_MS).toBe(60_000)
    expect(STABLE_MS).toBe(60_000)
  })

  test('stop at the edges', async () => {
    // No process.
    const none = setup()
    await expect(none.host.stop()).resolves.toBe('not running')
    none.host.start()
    expect(none.fork).not.toHaveBeenCalled()

    // Before ready: it still sends, the ready limit doesn't kill it, and a ready opens nothing.
    const early = setup()
    early.host.start()
    const p = at(early.procs, 0)
    const result = early.host.stop()
    expect(p.sent).toEqual([STOP_MESSAGE])
    vi.advanceTimersByTime(READY_LIMIT_MS)
    expect(p.kills).toBe(0)
    p.ready(3110)
    expect(early.ready).not.toHaveBeenCalled()
    expect(early.host.port()).toBeUndefined()
    p.exit(0)
    await expect(result).resolves.toBe('stopped')
    expect(early.fork).toHaveBeenCalledOnce()

    // After the failed state.
    const failed = setup()
    failed.host.start()
    at(failed.procs, 0).exit()
    at(failed.procs, 1).exit()
    expect(failed.failed).toHaveBeenCalledOnce()
    await expect(failed.host.stop()).resolves.toBe('not running')
  })

  test('a start runs once', () => {
    const s = setup()
    s.host.start()
    s.host.start()
    expect(s.fork).toHaveBeenCalledOnce()
  })

  test('a fork that throws counts as a failure', () => {
    const fork = vi.fn((): ServerProcess => {
      throw new Error('no such file')
    })
    const host = createServerHost({ fork })
    const failed = vi.fn()
    host.onFailed(failed)
    expect(() => host.start()).not.toThrow()
    expect(fork).toHaveBeenCalledTimes(2)
    expect(failed).toHaveBeenCalledOnce()
    expect(failed.mock.calls[0]![0]).toContain('no such file')
  })

  test('a closed channel or a failed kill throws nothing', async () => {
    const s = setup()
    s.host.start()
    const p = at(s.procs, 0)
    p.postMessage = () => {
      throw new Error('closed')
    }
    p.kill = () => {
      throw new Error('gone')
    }
    const result = s.host.stop()
    vi.advanceTimersByTime(STOP_KILL_MS)
    await expect(result).resolves.toBe('killed')
  })

  test('a failure listener can be taken off', () => {
    const s = setup()
    const off = vi.fn()
    s.host.onFailed(off)()
    s.host.start()
    at(s.procs, 0).exit()
    at(s.procs, 1).exit()
    expect(off).not.toHaveBeenCalled()
    expect(s.failed).toHaveBeenCalledOnce()
  })
})
