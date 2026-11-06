// The resume and auto-continue routes, mounted at /api/actions behind the action guard. The repo
// comes from the current Board by id, never a path. The rules and why are in
// pod-docs/feature-details/resume.md.

import { listRuns, replySession, repoPathKey, sendableReply } from '@open-aflow/model'
import { Hono } from 'hono'
import { isResuming, runResume, type ResumeDeps } from './auto-continue.ts'

const REPLIES: readonly unknown[] = ['continue', 'go']

export function createResumeRoutes(deps: ResumeDeps): Hono {
  const now = deps.now ?? Date.now
  const app = new Hono()

  app.post('/resume', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const { repoId, run, reply } = body
    if (typeof repoId !== 'string' || typeof run !== 'string' || !REPLIES.includes(reply)) return c.json({ error: 'bad request' }, 400)
    const word = reply as 'continue' | 'go'

    const repo = deps.board().repos.find((r) => r.id === repoId)
    const sendable = repo && sendableReply(repo, run, word, now())
    if (!repo || !sendable) return c.json({ error: 'not waiting on you' }, 404)
    const session = replySession(repo, run, now())
    if (!session?.resume) return c.json({ error: 'no session' }, 404)
    if (!idle(repo, session.id)) return c.json({ error: 'session is busy' }, 409)
    if (isResuming(deps, session.id)) return c.json({ error: 'resume in progress' }, 409)

    deps.inFlight.add(session.id)
    try {
      // A continue marks this stop sent, so the automatic check won't send it again. A failed save
      // doesn't stop a resume you asked for.
      const key = repoPathKey(repo)
      if (word === 'continue' && deps.store.list().some((t) => t.path === key && t.run === run)) {
        await settle(() => deps.store.saveKey(key, run, sendable.key))
      }
      const result = await runResume(deps, { repo, run, session: session.id, word, auto: false })
      // The Board carries the new log entry before the response.
      await settle(deps.rebuild)
      return c.json(result)
    } finally {
      deps.inFlight.delete(session.id)
    }
  })

  app.post('/auto-continue', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const { repoId, run, on } = body
    if (typeof repoId !== 'string' || typeof run !== 'string' || typeof on !== 'boolean') return c.json({ error: 'bad request' }, 400)
    const repo = deps.board().repos.find((r) => r.id === repoId)
    if (!repo || !listRuns(deps.board(), now()).some((r) => r.repoId === repoId && r.plan === run)) return c.json({ error: 'not a run' }, 404)
    try {
      await deps.store.set(repoPathKey(repo), run, on)
    } catch {
      return c.json({ error: "Couldn't save the toggle." }, 500)
    }
    // The Board carries the toggle before the response, and its change wakes the automatic check.
    await settle(deps.rebuild)
    return c.json({ on })
  })

  function idle(repo: Parameters<ResumeDeps['idle']>[0], session: string): boolean {
    try {
      return deps.idle(repo, session)
    } catch {
      return false
    }
  }

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
