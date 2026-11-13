// The forget-run route, mounted at /api/actions behind the action guard (app.ts), beside remove-repo. It deletes
// one run's leftover port claim file, and nothing else: never git, a worktree, a branch, the config, or a toggle.
// The file name is built from the integer port base only. The rules and why are in
// pod-docs/feature-details/server.md.

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { forgetCheck, type Board, type ForgetRunResult, type NewActionEntry } from '@openaflow/model'
import { Hono, type Context } from 'hono'
import { parseClaim } from './claims.ts'
import { sameRepoPath } from './guard.ts'

export type ForgetRunRouteDeps = {
  /** The current Board. */
  board(): Board
  /** The port claims folder (`portsDir` in claims.ts). */
  portsDir: string
  platform: NodeJS.Platform
  now(): number
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
  /** Deletes one file. Defaults to `fs.unlink`, which never deletes a folder. */
  unlink?(file: string): Promise<void>
}

const isPortBase = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535

export function createForgetRunRoutes(deps: ForgetRunRouteDeps): Hono {
  const app = new Hono()
  const remove = deps.unlink ?? unlink
  let queue: Promise<unknown> = Promise.resolve()

  app.post('/forget-run', async (c) => {
    const { repoId, run, portBase } = (await c.req.json()) as Record<string, unknown>
    if (typeof repoId !== 'string' || typeof run !== 'string' || !isPortBase(portBase)) return c.json({ error: 'bad request' }, 400)
    // One forget at a time, each on the Board as it is in its turn: on Windows a second delete of a file that is
    // being deleted fails with EPERM, but in turn the second finds the run gone or reads the file as gone.
    const turn = queue.then(() => forget(c, repoId, run, portBase))
    queue = turn.then(
      () => undefined,
      () => undefined,
    )
    return turn
  })

  async function forget(c: Context, repoId: string, run: string, portBase: number): Promise<Response> {
    const withId = deps.board().repos.filter((r) => r.id === repoId)
    if (withId.length > 1) return c.json({ error: 'ambiguous repo' }, 409)
    const repo = withId[0]
    if (!repo) return c.json({ error: 'not on the board' }, 404)

    const check = forgetCheck(repo, run, deps.now())
    if (!check.ok) return c.json({ error: check.reason }, check.reason === 'run is running' ? 409 : 404)
    if (check.portBase !== portBase) return c.json({ error: 'no claim' }, 404)

    // Read the file again: the Board can be older than the claims folder. Its name is the integer, never body text.
    const name = String(portBase)
    const file = join(deps.portsDir, name)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (err) {
      if (code(err) === 'ENOENT') return gone()
      // A folder named like the port, or a file it can't read: not the claim the check saw, so it stays.
      return c.json({ error: 'claim changed' }, 409)
    }
    const claim = parseClaim(name, text)
    if (!claim || claim.plan !== run || !sameRepoPath(claim.repoPath, repo.path, deps.platform, repo.caseless === true)) {
      return c.json({ error: 'claim changed' }, 409)
    }

    const base = { action: 'forget-run', repoId, repo: repo.name, target: `${run} · port base ${portBase}` } as const
    try {
      await remove(file)
    } catch (err) {
      // Another request (or pod) deleted it first: nothing was done here, as for a missing file.
      if (code(err) === 'ENOENT') return gone()
      await settle(() => deps.log.append({ ...base, result: 'failed', message: code(err) ?? 'unknown error' }))
      await settle(deps.rebuild)
      return c.json({ error: 'claim unremovable' }, 500)
    }
    const logged = await settle(() => deps.log.append({ ...base, result: 'removed' }))
    // The Board drops the run, and carries the log entry, before the response.
    await settle(deps.rebuild)
    return c.json({ outcome: 'removed', run, portBase, logged: logged === true } satisfies ForgetRunResult)

    /** The claim is already gone: the Board catches up, and nothing is logged. */
    async function gone() {
      await settle(deps.rebuild)
      return c.json({ error: 'no claim' }, 404)
    }
  }

  return app
}

const code = (err: unknown): string | undefined => {
  const c = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof c === 'string' ? c : undefined
}

/** Runs `fn`; a throw is `undefined`, so the response still goes out. */
async function settle<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}
