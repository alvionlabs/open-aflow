// What Ctrl+C does: stop taking new work, wait for actions and auto-continue
// sends already running (a merge can take up to a minute), then exit. A second
// signal quits at once. The rules and why are in pod-docs/feature-details/server.md.

import type { MiddlewareHandler } from 'hono'

/** The longest shutdown waits for running work: past a merge's 60 s gh timeout, so it can finish and log. */
export const DRAIN_CAP_MS = 70_000

export type WorkTracker = {
  /** Counts each request it sees from start to finish. */
  track: MiddlewareHandler
  /** Requests running now. */
  size(): number
  /** Resolves once no request is running. */
  settled(): Promise<void>
}

export function createWorkTracker(): WorkTracker {
  const running = new Set<Promise<void>>()
  return {
    track: async (_c, next) => {
      const done = next()
      running.add(done)
      try {
        await done
      } finally {
        running.delete(done)
      }
    },
    size: () => running.size,
    settled: async () => {
      while (running.size > 0) await Promise.allSettled([...running])
    },
  }
}

export type ShutdownDeps = {
  auto: { stop(): void; settled(): Promise<void> }
  server: { close(): unknown }
  work: { size(): number; settled(): Promise<void> }
  watcher: { close(): Promise<void> }
  /** The last step of a normal stop. A forced quit skips it. */
  release?: () => void
  exit: (code: number) => void
  log?: (msg: string) => void
  capMs?: number
}

/** The SIGINT/SIGTERM handler. */
export function createShutdown(d: ShutdownDeps): () => void {
  const log = d.log ?? ((m: string) => console.log(m))
  const capMs = d.capMs ?? DRAIN_CAP_MS
  let stopping = false
  let exited = false
  // Only the first exit counts: in tests `exit` is a fake that returns.
  const exit = (code: number) => {
    if (exited) return
    exited = true
    d.exit(code)
  }
  return () => {
    if (stopping) {
      exit(1)
      return
    }
    stopping = true
    d.auto.stop()
    d.server.close()
    const n = d.work.size()
    if (n > 0) log(`open-aflow: waiting for ${n} action${n === 1 ? '' : 's'} to finish; press Ctrl+C again to quit now`)
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, capMs)
    })
    void Promise.race([Promise.all([d.auto.settled(), d.work.settled()]), cap])
      .finally(() => clearTimeout(timer))
      .then(() => d.watcher.close())
      .catch(() => {})
      .then(() => {
        if (!exited) d.release?.()
      })
      .catch(() => {})
      .then(() => exit(0))
  }
}
