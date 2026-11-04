import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createStopPath, guardOutput, isStopMessage, linkParent, parentChannel, parentPid, processAlive, STOP_MESSAGE, watchParent, type ProcessLike } from './parent-link.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** A fake `process.parentPort`: Electron's shape, with the message in `e.data`. */
function fakePort() {
  const handlers: ((e: { data: unknown }) => void)[] = []
  const posted: unknown[] = []
  return {
    posted,
    deliver: (data: unknown) => handlers.forEach((fn) => fn({ data })),
    port: { on: (_event: 'message', fn: (e: { data: unknown }) => void) => void handlers.push(fn), postMessage: (m: unknown) => void posted.push(m) },
  }
}

/** A fake Node IPC process. A closed channel acts as Node's does: the error goes to the callback, and with none it's an `error` event, which throws here. */
function fakeIpc(o: { closed?: boolean } = {}) {
  const emitter = new EventEmitter()
  const sent: unknown[] = []
  const proc: ProcessLike = {
    on: (event, fn) => emitter.on(event, fn),
    send: (m: unknown, cb?: (err: Error | null) => void) => {
      if (o.closed) {
        const err = new Error('Channel closed')
        if (cb) cb(err)
        else emitter.emit('error', err)
        return false
      }
      sent.push(m)
      cb?.(null)
      return true
    },
  }
  return { proc, sent, deliver: (m: unknown) => emitter.emit('message', m) }
}

describe('parentChannel', () => {
  test('adapts the parentPort shape', () => {
    const f = fakePort()
    // parentPort wins over Node IPC when a process has both.
    const ipc = fakeIpc()
    const channel = parentChannel({ ...ipc.proc, parentPort: f.port })
    expect(channel).toBeDefined()

    const stops = createStopPath()
    const stop = vi.fn()
    stops.attach(stop)
    const link = linkParent({ env: {}, stops, proc: { parentPort: f.port } })
    f.deliver(STOP_MESSAGE)
    expect(stop).toHaveBeenCalledTimes(1)

    link.ready(4100)
    expect(f.posted).toEqual([{ type: 'pod-board:ready', port: 4100 }])
    expect(ipc.sent).toEqual([])

    const seen: unknown[] = []
    channel!.onMessage((m) => seen.push(m))
    f.deliver({ any: 'value' })
    expect(seen).toEqual([{ any: 'value' }])
    channel!.send('out')
    expect(f.posted.at(-1)).toBe('out')
    expect(ipc.sent).toEqual([])
  })

  test('adapts Node IPC and no channel', () => {
    const ipc = fakeIpc()
    const channel = parentChannel(ipc.proc)
    expect(channel).toBeDefined()
    const seen: unknown[] = []
    channel!.onMessage((m) => seen.push(m))
    ipc.deliver(STOP_MESSAGE)
    expect(seen).toEqual([STOP_MESSAGE])
    channel!.send({ type: 'pod-board:ready', port: 1 })
    expect(ipc.sent).toEqual([{ type: 'pod-board:ready', port: 1 }])

    expect(parentChannel({})).toBeUndefined()
    // `on` alone isn't a channel: a plain process has `on` and no `send`.
    expect(parentChannel({ on: () => {} })).toBeUndefined()
  })

  test('only the exact stop message counts', () => {
    expect(isStopMessage(STOP_MESSAGE)).toBe(true)
    expect(isStopMessage({ type: 'pod-board:stop' })).toBe(true)
    for (const m of [null, undefined, '', 'pod-board:stop', 1, true, [], ['pod-board:stop'], {}, { type: 'pod-board:ready', port: 1 }, { type: 'POD-BOARD:STOP' }, { type: 'pod-board:stop', extra: 1 }, { data: STOP_MESSAGE }]) {
      expect(isStopMessage(m), JSON.stringify(m)).toBe(false)
    }

    const ipc = fakeIpc()
    const stops = createStopPath()
    const stop = vi.fn()
    stops.attach(stop)
    linkParent({ env: {}, stops, proc: ipc.proc })
    for (const m of [null, 'pod-board:stop', 7, { type: 'other' }]) expect(() => ipc.deliver(m)).not.toThrow()
    expect(stop).not.toHaveBeenCalled()
    ipc.deliver(STOP_MESSAGE)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('a closed channel is harmless', () => {
    const closed = fakeIpc({ closed: true })
    expect(parentChannel(closed.proc)).toBeDefined()
    expect(() => parentChannel(closed.proc)!.send('x')).not.toThrow()

    // A `send` or a `postMessage` that throws at once.
    const throwing: ProcessLike = {
      on: () => {},
      send: () => {
        throw new Error('ERR_IPC_CHANNEL_CLOSED')
      },
    }
    expect(parentChannel(throwing)).toBeDefined()
    expect(() => parentChannel(throwing)!.send('x')).not.toThrow()
    const port: ProcessLike = {
      parentPort: {
        on: () => {},
        postMessage: () => {
          throw new Error('closed')
        },
      },
    }
    expect(parentChannel(port)).toBeDefined()
    expect(() => parentChannel(port)!.send('x')).not.toThrow()
  })

  test('ready goes out once', () => {
    const ipc = fakeIpc()
    const link = linkParent({ env: {}, stops: createStopPath(), proc: ipc.proc })
    link.ready(4100)
    link.ready(4100)
    expect(ipc.sent).toEqual([{ type: 'pod-board:ready', port: 4100 }])
    // With no channel, ready does nothing and doesn't throw.
    expect(() => linkParent({ env: {}, stops: createStopPath(), proc: {} }).ready(1)).not.toThrow()
  })

  test('a bad parent value stops the link before it attaches anything', () => {
    const ipc = fakeIpc()
    const on = vi.spyOn(ipc.proc, 'on')
    expect(() => linkParent({ env: { POD_BOARD_PARENT_PID: 'abc' }, stops: createStopPath(), proc: ipc.proc })).toThrow(/POD_BOARD_PARENT_PID/)
    expect(on).not.toHaveBeenCalled()
  })
})

describe('createStopPath', () => {
  const attached = () => {
    const stops = createStopPath()
    const stop = vi.fn()
    stops.attach(stop)
    return { stops, stop }
  }

  // createShutdown reads a second call as "quit now", so the count of calls is the behavior.
  test('one stop path', () => {
    const twoRequests = attached()
    twoRequests.stops.request()
    twoRequests.stops.request()
    expect(twoRequests.stop).toHaveBeenCalledTimes(1)

    const requestThenSignal = attached()
    requestThenSignal.stops.request()
    requestThenSignal.stops.signal()
    expect(requestThenSignal.stop).toHaveBeenCalledTimes(2)

    const signalThenRequest = attached()
    signalThenRequest.stops.signal()
    signalThenRequest.stops.request()
    expect(signalThenRequest.stop).toHaveBeenCalledTimes(1)

    const twoSignals = attached()
    twoSignals.stops.signal()
    twoSignals.stops.signal()
    expect(twoSignals.stop).toHaveBeenCalledTimes(2)
  })

  test('a stop during start waits', () => {
    const stops = createStopPath()
    stops.request()
    stops.request()
    const stop = vi.fn()
    stops.attach(stop)
    expect(stop).toHaveBeenCalledTimes(1)
    // Nothing is left over: a signal after that is the second press.
    stops.request()
    expect(stop).toHaveBeenCalledTimes(1)
    stops.signal()
    expect(stop).toHaveBeenCalledTimes(2)

    const none = vi.fn()
    createStopPath().attach(none)
    expect(none).not.toHaveBeenCalled()
  })
})

describe('parentPid', () => {
  test("reads the parent's process ID", () => {
    expect(parentPid({})).toBeUndefined()
    expect(parentPid({ POD_BOARD_PARENT_PID: '' })).toBeUndefined()
    expect(parentPid({ POD_BOARD_PARENT_PID: '4242' })).toBe(4242)
    expect(parentPid({ POD_BOARD_PARENT_PID: '2147483647' })).toBe(2147483647)
    // 2147483648 is past what process.kill takes, so it would throw at each poll.
    for (const bad of ['0', '-1', 'abc', '1.5', '12abc', ' 12', '1e3', '0x10', '2147483648', '99999999999']) {
      expect(() => parentPid({ POD_BOARD_PARENT_PID: bad }), bad).toThrow(/POD_BOARD_PARENT_PID/)
    }
  })
})

describe('watchParent', () => {
  test('watches the parent', () => {
    vi.useFakeTimers()
    let alive = true
    const onGone = vi.fn()
    const asked: number[] = []
    const stop = watchParent({
      pid: 77,
      intervalMs: 2000,
      alive: (pid) => {
        asked.push(pid)
        return alive
      },
      onGone,
    })
    // At once, then every 2 s.
    expect(asked).toEqual([77])
    vi.advanceTimersByTime(1999)
    expect(asked).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(asked).toHaveLength(2)
    expect(onGone).not.toHaveBeenCalled()

    alive = false
    vi.advanceTimersByTime(2000)
    expect(onGone).toHaveBeenCalledTimes(1)
    const polls = asked.length
    vi.advanceTimersByTime(10_000)
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(polls) // it stops polling once it fired
    stop()

    // Already gone: at once, with no timer needed.
    const atOnce = vi.fn()
    watchParent({ pid: 77, alive: () => false, onGone: atOnce })
    expect(atOnce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(atOnce).toHaveBeenCalledTimes(1)

    // Stopped: never fires.
    let gone = false
    const stopped = vi.fn()
    const end = watchParent({ pid: 77, alive: () => !gone, onGone: stopped })
    end()
    gone = true
    vi.advanceTimersByTime(10_000)
    expect(stopped).not.toHaveBeenCalled()

    // The default poll is 2 s.
    let goneLater = false
    const later = vi.fn()
    watchParent({ pid: 77, alive: () => !goneLater, onGone: later })
    goneLater = true
    vi.advanceTimersByTime(1999)
    expect(later).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(later).toHaveBeenCalledTimes(1)

    // The real check: this process is alive, and EPERM reads as alive, ESRCH as gone.
    expect(processAlive(process.pid)).toBe(true)
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code })
    }
    expect(processAlive(77, failing('EPERM'))).toBe(true)
    expect(processAlive(77, failing('ESRCH'))).toBe(false)
    const kill = vi.fn()
    expect(processAlive(77, kill)).toBe(true)
    expect(kill).toHaveBeenCalledWith(77, 0)
  })

  test('a parent gone before the start is remembered until the stop is attached', () => {
    const stops = createStopPath()
    const stop = vi.fn()
    // A process ID that can't be running: the check is real here, through linkParent's default.
    linkParent({ env: { POD_BOARD_PARENT_PID: '2147483647' }, stops, proc: {} })
    expect(stop).not.toHaveBeenCalled()
    stops.attach(stop)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('guardOutput', () => {
  test("a closed pipe doesn't end the drain", () => {
    const stream = new EventEmitter()
    guardOutput(stream as unknown as Parameters<typeof guardOutput>[0])
    expect(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
    // Every EPIPE, not only the first.
    expect(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
    expect(() => stream.emit('error', Object.assign(new Error('other'), { code: 'EIO' }))).toThrow('other')
  })
})
