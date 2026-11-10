// How production stops when something else runs it: a parent's stop message, or the parent's process
// going away. Both end in the same shutdown as Ctrl+C. Nothing here ends another process: a resumed
// `claude` is detached and keeps running. Dev doesn't use this file. The rules are in
// pod-docs/feature-details/server.md.

import { envValue, type Env } from './config.ts'

export const STOP_MESSAGE = { type: 'openaflow:stop' } as const
export type ReadyMessage = { type: 'openaflow:ready'; port: number }
export type ParentChannel = { onMessage(fn: (m: unknown) => void): void; send(m: unknown): void }

/** The parts of a process that a channel needs. `parentPort` is Electron's, in a `utilityProcess`. */
export type ProcessLike = {
  parentPort?: { on(event: 'message', fn: (e: { data: unknown }) => void): unknown; postMessage(m: unknown): void }
  send?: (m: unknown, cb: (err: Error | null) => void) => unknown
  on?: (event: 'message', fn: (m: unknown) => void) => unknown
}

const PARENT_PID = 'OPENAFLOW_PARENT_PID'
/** How often the parent is checked. */
const PARENT_POLL_MS = 2000
/** The largest process ID `process.kill` takes. */
const MAX_PID = 2147483647

/** `process.parentPort` (message in `e.data`), else Node IPC (`process.send`), else none. */
export function parentChannel(proc: ProcessLike = process as unknown as ProcessLike): ParentChannel | undefined {
  const port = proc.parentPort
  if (port) {
    return {
      onMessage: (fn) => void port.on('message', (e) => fn(e?.data)),
      send: (m) => {
        try {
          port.postMessage(m)
        } catch {
          // A closed channel: the parent is gone, and the watch handles that.
        }
      },
    }
  }
  if (typeof proc.send !== 'function') return undefined
  return {
    onMessage: (fn) => void proc.on?.('message', fn),
    send: (m) => {
      try {
        // With no callback, Node reports a closed channel as an `error` event, which would end the process.
        proc.send!(m, () => {})
      } catch {
        // As above.
      }
    },
  }
}

/** Only `{ type: 'openaflow:stop' }`, with nothing else in it. */
export function isStopMessage(m: unknown): boolean {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false
  const keys = Object.keys(m)
  return keys.length === 1 && (m as { type?: unknown }).type === STOP_MESSAGE.type
}

/** Whether a process runs: `EPERM` means it does, and it isn't ours to signal. Only `ESRCH` means it's gone. */
export function processAlive(pid: number, kill: (pid: number, signal: number) => unknown = process.kill): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A process ID that `process.kill` can take. */
export const isPid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_PID

export type StopPath = {
  /** The message or the watch: starts a stop if none has started. A repeat does nothing. */
  request(): void
  /** Ctrl+C: always calls the stop, so a second one is the shutdown's "quit now". */
  signal(): void
  /** Sets the stop, and runs what arrived during the start. */
  attach(stop: () => void): void
}

export function createStopPath(): StopPath {
  let stop: (() => void) | undefined
  let started = false
  let waiting = 0
  const run = () => {
    started = true
    if (stop) stop()
    else waiting++
  }
  return {
    request: () => {
      if (!started) run()
    },
    signal: run,
    attach: (fn) => {
      stop = fn
      for (; waiting > 0; waiting--) fn()
    },
  }
}

/** The parent's process ID. Unset or empty: `undefined`, so no watch. A bad value throws, naming the variable. */
export function parentPid(env: Env): number | undefined {
  const raw = envValue(env, PARENT_PID)
  if (raw === undefined) return undefined
  const pid = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN
  if (!isPid(pid)) throw new Error(`${PARENT_PID}: "${raw}" is not a process ID`)
  return pid
}

/**
 * Calls `onGone` once when the parent is gone: at once when it already is, else at a later poll.
 * Returns the function that ends the watch. A reused process ID reads as alive, an accepted edge.
 */
export function watchParent(o: { pid: number; onGone(): void; alive?: (pid: number) => boolean; intervalMs?: number }): () => void {
  const alive = o.alive ?? processAlive
  if (!alive(o.pid)) {
    o.onGone()
    return () => {}
  }
  const timer = setInterval(() => {
    if (alive(o.pid)) return
    clearInterval(timer)
    o.onGone()
  }, o.intervalMs ?? PARENT_POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Ignores `EPIPE` on an output stream, so a dead parent's pipe doesn't end the drain. Any other
 * error is thrown, which is what a stream with no `error` listener does.
 */
export function guardOutput(stream: { on(event: 'error', fn: (err: Error) => void): unknown }): void {
  stream.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  })
}

/**
 * Production's link to whatever started it, made before `startServer`. Throws on a bad
 * `OPENAFLOW_PARENT_PID`, before it attaches anything. `ready` sends once.
 */
export function linkParent(o: { env: Env; stops: StopPath; proc?: ProcessLike }): { ready(port: number): void } {
  const pid = parentPid(o.env)
  const channel = parentChannel(o.proc)
  channel?.onMessage((m) => {
    if (isStopMessage(m)) o.stops.request()
  })
  if (pid !== undefined) watchParent({ pid, onGone: () => o.stops.request() })
  let sent = false
  return {
    ready: (port) => {
      if (sent) return
      sent = true
      const message: ReadyMessage = { type: 'openaflow:ready', port }
      channel?.send(message)
    },
  }
}
