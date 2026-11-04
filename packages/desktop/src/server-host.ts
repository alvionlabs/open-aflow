// Runs the server process: start, ready, one restart, stop. The only kill here is `kill()` on the
// server's own process. A resumed `claude` is detached, and nothing here reaches it. The rules are in
// pod-docs/feature-details/desktop.md.

import { STOP_MESSAGE } from '@pod-board/server/parent-link'

export const READY_LIMIT_MS = 60_000
/** Above the server's DRAIN_CAP_MS (70 s). */
export const STOP_KILL_MS = 80_000
export const STABLE_MS = 60_000
const TAIL_CHARS = 2000

export type ServerProcess = {
  pid: number | undefined
  postMessage(m: unknown): void
  kill(): boolean // this process only
  onMessage(fn: (m: unknown) => void): void
  onExit(fn: (code: number) => void): void
  onOutput(fn: (text: string) => void): void
}

export type StopResult = 'stopped' | 'killed' | 'not running'

export type ServerHost = {
  start(): void
  stop(): Promise<StopResult>
  port(): number | undefined
  /** Fires at each ready; at once when already ready. */
  onReady(fn: (port: number) => void): () => void
  /** Fires once, when no restart is left; at once when already failed. */
  onFailed(fn: (error: string) => void): () => void
}

/** The port of a `{ type: 'pod-board:ready', port }` message, or `undefined` for anything else. */
function readyPort(m: unknown): number | undefined {
  if (typeof m !== 'object' || m === null) return undefined
  const { type, port } = m as { type?: unknown; port?: unknown }
  if (type !== 'pod-board:ready' || typeof port !== 'number') return undefined
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

function add<T>(set: Set<T>, fn: T): () => void {
  set.add(fn)
  return () => void set.delete(fn)
}

export function createServerHost(o: { fork(): ServerProcess }): ServerHost {
  const readyListeners = new Set<(port: number) => void>()
  const failedListeners = new Set<(error: string) => void>()
  let current: ServerProcess | undefined
  let port: number | undefined
  let started = false
  let restartLeft = true
  let failure: string | undefined
  let tail = ''
  let stopping: Promise<StopResult> | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let stableTimer: ReturnType<typeof setTimeout> | undefined
  /** During a stop: ends it when the process exits. */
  let onStopExit: (() => void) | undefined

  const clearTimers = () => {
    clearTimeout(readyTimer)
    clearTimeout(stableTimer)
  }

  const addOutput = (text: string) => {
    tail = (tail + text).slice(-TAIL_CHARS)
  }

  const killProcess = (p: ServerProcess) => {
    try {
      p.kill()
    } catch {
      // Already gone.
    }
  }

  /** The current process has failed, whatever the way: a restart if one is left, else the failed state. */
  const fail = () => {
    clearTimers()
    current = undefined
    port = undefined
    if (restartLeft) {
      restartLeft = false
      launch()
      return
    }
    failure = tail
    for (const fn of [...failedListeners]) fn(failure)
  }

  function launch() {
    let p: ServerProcess
    try {
      p = o.fork()
    } catch (err) {
      addOutput(`${err instanceof Error ? err.message : String(err)}\n`)
      fail()
      return
    }
    current = p
    let sawReady = false
    p.onOutput((text) => {
      if (current === p) addOutput(text)
    })
    p.onMessage((m) => {
      const ready = readyPort(m)
      if (ready === undefined || sawReady || current !== p || stopping) return
      sawReady = true
      port = ready
      clearTimeout(readyTimer)
      stableTimer = setTimeout(() => {
        restartLeft = true
      }, STABLE_MS)
      for (const fn of [...readyListeners]) fn(ready)
    })
    p.onExit(() => {
      if (current !== p) return
      if (stopping) onStopExit?.()
      else fail()
    })
    readyTimer = setTimeout(() => {
      killProcess(p)
      fail()
    }, READY_LIMIT_MS)
  }

  const runStop = (p: ServerProcess): Promise<StopResult> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        current = undefined
        killProcess(p)
        resolve('killed')
      }, STOP_KILL_MS)
      onStopExit = () => {
        clearTimeout(timer)
        current = undefined
        resolve('stopped')
      }
      try {
        p.postMessage(STOP_MESSAGE)
      } catch {
        // A closed channel: the exit or the timeout ends the stop.
      }
    })

  return {
    start() {
      if (started || stopping) return
      started = true
      launch()
    },
    stop() {
      if (stopping) return stopping
      clearTimers()
      port = undefined
      stopping = current ? runStop(current) : Promise.resolve('not running')
      return stopping
    },
    port: () => port,
    onReady(fn) {
      const off = add(readyListeners, fn)
      if (port !== undefined) fn(port)
      return off
    },
    onFailed(fn) {
      const off = add(failedListeners, fn)
      if (failure !== undefined) fn(failure)
      return off
    },
  }
}
