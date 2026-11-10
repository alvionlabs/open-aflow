// The action routes, mounted at /api/actions behind the action guard (app.ts): merge-preview and
// merge. The repo comes from the current Board by id, and the PR must be waiting on you. The
// rules and why are in pod-docs/feature-details/actions.md.

import { waitingPrs, type Board, type BoardRepo, type GhStatus, type MergeResult, type NewActionEntry } from '@openaflow/model'
import { Hono, type Context } from 'hono'
import { mergePr, readPr } from './gh-actions.ts'
import type { GhExec } from './gh.ts'

export type ActionRouteDeps = {
  /** The current Board. */
  board(): Board
  gh: { status(): GhStatus; forget(repoPath: string, n: number): void }
  exec: GhExec
  /** Asks gh about the Board's live PRs (the board service's `refreshGh`). */
  refreshGh(board: Board): Promise<unknown>
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
  now?: () => number
}

const SHA = /^[0-9a-f]{40}$/
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

export function createActionRoutes(deps: ActionRouteDeps): Hono {
  const now = deps.now ?? Date.now
  // `<repoId>#<number>` of each merge running now.
  const inFlight = new Set<string>()
  const app = new Hono()

  /** The repo and PR when the PR is waiting on you and gh is ok; else the error response. */
  const target = (c: Context, repoId: string, n: number): { repo: BoardRepo } | Response => {
    const repo = deps.board().repos.find((r) => r.id === repoId)
    if (!repo || !waitingPrs(repo, now()).some((w) => w.number === n)) return c.json({ error: 'not waiting on you' }, 404)
    if (deps.gh.status() !== 'ok') return c.json({ error: 'gh unavailable' }, 503)
    return { repo }
  }

  app.post('/merge-preview', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    if (typeof body.repoId !== 'string' || !isNumber(body.number)) return c.json({ error: 'bad request' }, 400)
    const t = target(c, body.repoId, body.number)
    if (t instanceof Response) return t
    const read = await readPr(deps.exec, t.repo.path, body.number)
    return read.ok ? c.json(read.preview) : c.json({ error: read.message }, 502)
  })

  app.post('/merge', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const { repoId, number: n, headSha } = body
    if (typeof repoId !== 'string' || !isNumber(n) || typeof headSha !== 'string' || !SHA.test(headSha)) return c.json({ error: 'bad request' }, 400)
    const t = target(c, repoId, n)
    if (t instanceof Response) return t
    const key = `${repoId}#${n}`
    if (inFlight.has(key)) return c.json({ error: 'merge in progress' }, 409)
    inFlight.add(key)
    try {
      const run = await mergePr(deps.exec, t.repo.path, n, headSha)
      if (run.ran) await settle(() => afterMerge(t.repo.path, n))
      const { ran: _ran, ...result } = run
      const message = run.outcome === 'stale' && run.headSha ? `head now ${run.headSha.slice(0, 7)}` : run.message
      const entry: NewActionEntry = { action: 'merge', repoId, repo: t.repo.name, target: `PR #${n}`, result: run.outcome }
      if (message !== undefined) entry.message = message
      const logged = await settle(() => deps.log.append(entry))
      // The Board carries the new log entry (and, after a merge, the PR's fresh state) before the response.
      await settle(deps.rebuild)
      return c.json({ ...result, logged: logged === true } satisfies MergeResult)
    } finally {
      inFlight.delete(key)
    }
  })

  /** Drops the PR from gh's cache and asks again, so the next Board shows what happened. */
  async function afterMerge(repoPath: string, n: number): Promise<void> {
    deps.gh.forget(repoPath, n)
    await deps.refreshGh(deps.board())
  }

  return app
}

/** Runs `fn`; a throw is `undefined`. The merge already happened, so the response must still go out. */
async function settle<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}
