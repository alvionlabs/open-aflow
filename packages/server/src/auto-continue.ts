// The automatic check: on each new Board and every 15 s, sends `continue` to each toggled run
// whose stop is new and whose session is idle. Shares the in-flight sessions with the resume
// route, so the two never start a second run on one session. The rules and why are in
// pod-docs/feature-details/resume.md.

import { autoSends, repoPathKey, type Board, type BoardRepo, type NewActionEntry, type ResumeResult } from '@openaflow/model'
import type { AutoContinueStore } from './auto-continue-store.ts'
import type { ClaudeRunner, ResumeWord, StartResult } from './claude-runner.ts'

/** How often the check runs with no new Board: idle depends on time passing. */
export const AUTO_TICK_MS = 15_000

export type ResumeDeps = {
  /** The current Board. */
  board(): Board
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
  runner: Pick<ClaudeRunner, 'start' | 'isRunning'>
  store: AutoContinueStore
  /** The session's files have been quiet for a minute (session-activity.ts). */
  idle(repo: BoardRepo, session: string): boolean
  /** Sessions with a resume request starting now, shared by the route and the check. */
  inFlight: Set<string>
  now?: () => number
}

/** A resume request or a running child already holds this session. */
export const isResuming = (d: Pick<ResumeDeps, 'inFlight' | 'runner'>, session: string) => d.inFlight.has(session) || d.runner.isRunning(session)

/** Starts the runner (a throw is a failed start) and logs one entry, whatever the result. */
export async function runResume(
  d: Pick<ResumeDeps, 'runner' | 'log'>,
  r: { repo: BoardRepo; run: string; session: string; word: ResumeWord; auto: boolean },
): Promise<ResumeResult> {
  let start: StartResult
  try {
    start = await d.runner.start({ session: r.session, word: r.word, cwd: r.repo.path })
  } catch (err) {
    start = { outcome: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
  const entry: NewActionEntry = { action: 'resume', repoId: r.repo.id, repo: r.repo.name, target: `${r.run} · ${r.word}`, result: start.outcome, reply: r.word, auto: r.auto }
  if (start.message !== undefined) entry.message = start.message
  const logged = await settle(() => d.log.append(entry))
  const out: ResumeResult = { outcome: start.outcome, logged: logged === true }
  if (start.message !== undefined) out.message = start.message
  return out
}

export type AutoContinue = {
  /** Sends what's due now. Resolves when every send it started has finished. */
  check(): Promise<void>
  /** Checks now, on each new Board, and every 15 s. */
  start(): void
  stop(): void
  /** Resolves when every check started so far has finished. */
  settled(): Promise<void>
}

export function createAutoContinue(
  d: ResumeDeps & {
    subscribe(fn: (b: Board) => void): () => void
    tickMs?: number
    /** Whether this server may send now (owner-file.ts). With none, it may. */
    owner?: () => boolean
    /** Reports a check that threw; logs to the console unless a test passes one. */
    onError?: (err: unknown) => void
  },
): AutoContinue {
  const onError = d.onError ?? ((err: unknown) => console.error('openaflow auto-continue:', err))
  const now = d.now ?? Date.now
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const pending = new Set<Promise<void>>()

  const idle = (repo: BoardRepo, session: string) => {
    try {
      return d.idle(repo, session)
    } catch {
      return false
    }
  }

  function check(): Promise<void> {
    let board: Board
    let due: ReturnType<typeof autoSends>
    try {
      if (d.owner && !d.owner()) return Promise.resolve()
      board = d.board()
      due = autoSends(board, d.store.list(), now(), idle).filter((s) => !isResuming(d, s.session))
    } catch (err) {
      // From a timer, a throw here would crash the server.
      onError(err)
      return Promise.resolve()
    }
    // Held at once, before anything waits, so a check or a request that comes next skips them.
    for (const s of due) d.inFlight.add(s.session)
    const done = Promise.all(
      due.map(async (s) => {
        try {
          const repo = board.repos.find((r) => r.id === s.repoId)!
          // The key first: a failed save sends nothing, and the next check tries again.
          const saved = await settle(() => d.store.saveKey(repoPathKey(repo), s.run, s.key))
          if (saved !== true) return
          const result = await runResume(d, { repo, run: s.run, session: s.session, word: 'continue', auto: true })
          // A failed start raises the stop again as its own item, with a toast (attention.ts). A failed save of the mark
          // leaves it quiet, as before.
          if (result.outcome === 'failed') await settle(() => d.store.saveFailed(repoPathKey(repo), s.run, s.key))
          await settle(d.rebuild)
        } finally {
          d.inFlight.delete(s.session)
        }
      }),
    ).then(() => {})
    pending.add(done)
    void done.finally(() => pending.delete(done))
    return done
  }

  return {
    check,
    start() {
      if (timer !== undefined) return
      void check()
      unsubscribe = d.subscribe(() => void check())
      timer = setInterval(() => void check(), d.tickMs ?? AUTO_TICK_MS)
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      unsubscribe?.()
      unsubscribe = undefined
    },
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending])
    },
  }
}

/** Runs `fn`; a throw is `undefined`. */
async function settle<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}
