// The remove-repo route, mounted at /api/actions behind the action guard (app.ts), beside the merge,
// answer, and resume routes. It takes a repo out of the board's config.json, and nothing else: never
// the repo's files, claims, or transcripts. The repo comes from the current Board by id and path. The rules
// and why are in pod-docs/feature-details/server.md.

import type { Board, NewActionEntry, RemoveRepoResult } from '@pod-board/model'
import { Hono } from 'hono'
import type { RemoveRepoError } from './repos-config.ts'

export type RemoveRepoRouteDeps = {
  /** The current Board. */
  board(): Board
  /** Takes the path out of the config (`removeRepo` in repos-config.ts). */
  removeRepo(path: string): Promise<{ path: string } | { error: RemoveRepoError }>
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
}

const STATUS = { 'not registered': 404, 'config unreadable': 500 } as const

export function createRemoveRepoRoutes(deps: RemoveRepoRouteDeps): Hono {
  const app = new Hono()

  app.post('/remove-repo', async (c) => {
    const { repoId, path } = (await c.req.json()) as Record<string, unknown>
    if (typeof repoId !== 'string' || (path !== undefined && typeof path !== 'string')) return c.json({ error: 'bad request' }, 400)
    // Two paths that differ only in non-alphanumeric characters share an id, so the path picks the exact repo.
    const withId = deps.board().repos.filter((r) => r.id === repoId)
    if (path === undefined && withId.length > 1) return c.json({ error: 'ambiguous repo' }, 409)
    const repo = path === undefined ? withId[0] : withId.find((r) => r.path === path)
    if (!repo) return c.json({ error: 'not on the board' }, 404)
    // A claim-only repo isn't in the config; the board would list it again from the claim.
    if (repo.source === 'claim') return c.json({ error: 'not registered' }, 404)

    const base = { action: 'remove-repo', repoId, repo: repo.name, target: repo.path } as const
    let result: Awaited<ReturnType<RemoveRepoRouteDeps['removeRepo']>>
    try {
      result = await deps.removeRepo(repo.path)
    } catch {
      await settle(() => deps.log.append({ ...base, result: 'failed', message: 'config unwritable' }))
      await settle(deps.rebuild)
      return c.json({ error: 'config unwritable' }, 500)
    }
    // A refusal changed nothing, so it isn't logged.
    if ('error' in result) return c.json({ error: result.error }, STATUS[result.error])

    const logged = await settle(() => deps.log.append({ ...base, result: 'removed' }))
    // The Board drops the repo, and carries the log entry, before the response.
    await settle(deps.rebuild)
    return c.json({ outcome: 'removed', path: result.path, logged: logged === true } satisfies RemoveRepoResult)
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
