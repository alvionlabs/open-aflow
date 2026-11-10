// The answer and resolve routes, mounted at /api/actions beside the merge routes, behind the action
// guard: `answer` appends your answer to a queue entry waiting on you; `resolve` (Close and Keep)
// rewrites its pending Resolution with the reason or the value the board reads itself. The repo comes
// from the current Board by id, and the entry by its whole line. The rules and why are in
// pod-docs/feature-details/actions.md.

import {
  cleanAnswer,
  closeText,
  isAnswerable,
  keepText,
  triage,
  type AnswerResult,
  type Board,
  type NewActionEntry,
  type QueueItem,
  type ResolveOutcome,
  type ResolveResult,
} from '@openaflow/model'
import { Hono } from 'hono'
import { nodeQueueFs, writeAnswer, writeResolution, type QueueFs } from './queue-writer.ts'

export type AnswerRouteDeps = {
  /** The current Board. */
  board(): Board
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
  fs?: QueueFs
  /** Today's date as `YYYY-MM-DD`, for a resolution; local time by default. */
  today?: () => string
}

export const NOT_DONE = 'The board no longer reads this entry as done.'
export const NO_VALUE = 'This entry states no value in use.'

/** The local date as `YYYY-MM-DD`. */
export function localDate(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** The log's target: the entry's header, never its body or the answer. */
export const answerTarget = (item: Pick<QueueItem, 'date' | 'type' | 'route'>) =>
  [item.date, item.type, item.route.trim()].filter((part) => part !== undefined && part !== '').join(' · ')

export function createAnswerRoutes(deps: AnswerRouteDeps): Hono {
  const fs = deps.fs ?? nodeQueueFs
  // Repo ids with an answer writing now.
  const inFlight = new Set<string>()
  const app = new Hono()

  app.post('/answer', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const { repoId, line, text } = body
    if (typeof repoId !== 'string' || typeof line !== 'string' || typeof text !== 'string') return c.json({ error: 'bad request' }, 400)
    const clean = cleanAnswer(text)
    if (!clean.ok) return c.json({ error: clean.error }, 400)

    const repo = deps.board().repos.find((r) => r.id === repoId)
    const item = repo?.model.queue.find((e) => e.line === line && isAnswerable(e))
    if (!repo || !item) return c.json({ error: 'not waiting on you' }, 404)
    if (inFlight.has(repoId)) return c.json({ error: 'answer in progress' }, 409)

    inFlight.add(repoId)
    try {
      const result = await settle(() => writeAnswer({ repoPath: repo.path, line, text: clean.text }, fs))
      const { outcome, message } = result ?? { outcome: 'failed' as const, message: "Couldn't write the queue (unknown)." }
      const entry: NewActionEntry = { action: 'answer', repoId, repo: repo.name, target: answerTarget(item), result: outcome }
      if (message !== undefined) entry.message = message
      const logged = await settle(() => deps.log.append(entry))
      // The Board carries the answer and the new log entry before the response.
      await settle(deps.rebuild)
      const res: AnswerResult = { outcome, logged: logged === true }
      if (message !== undefined) res.message = message
      return c.json(res)
    } finally {
      inFlight.delete(repoId)
    }
  })

  // Close and Keep. The text written is the board's own (its Done reason, the entry's value in use),
  // read from the current Board; anything else in the request counts for nothing.
  app.post('/resolve', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const { repoId, line, kind } = body
    if (typeof repoId !== 'string' || typeof line !== 'string' || (kind !== 'close' && kind !== 'keep')) return c.json({ error: 'bad request' }, 400)

    const repo = deps.board().repos.find((r) => r.id === repoId)
    const item = repo?.model.queue.find((e) => e.line === line && isAnswerable(e))
    if (!repo || !item) return c.json({ error: 'not waiting on you' }, 404)
    const t = triage(repo, item)
    if (kind === 'close' && t.done === undefined) return c.json({ error: NOT_DONE }, 409)
    if (kind === 'keep' && t.keep === undefined) return c.json({ error: NO_VALUE }, 409)
    if (inFlight.has(repoId)) return c.json({ error: 'answer in progress' }, 409)

    const date = (deps.today ?? localDate)()
    const text = kind === 'close' ? closeText(date, t.done!) : keepText(date, t.keep!)
    inFlight.add(repoId)
    try {
      const written = await settle(() => writeResolution({ repoPath: repo.path, line, text }, fs))
      const { outcome: raw, message } = written ?? { outcome: 'failed' as const, message: "Couldn't write the queue (unknown)." }
      const outcome: ResolveOutcome = raw === 'resolved' ? (kind === 'close' ? 'closed' : 'kept') : raw
      const entry: NewActionEntry = { action: 'resolve', repoId, repo: repo.name, target: answerTarget(item), result: outcome }
      if (message !== undefined) entry.message = message
      const logged = await settle(() => deps.log.append(entry))
      await settle(deps.rebuild)
      const res: ResolveResult = { outcome, logged: logged === true }
      if (message !== undefined) res.message = message
      return c.json(res)
    } finally {
      inFlight.delete(repoId)
    }
  })

  return app
}

/** Runs `fn`; a throw is `undefined`, so the response still goes out. */
async function settle<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}
