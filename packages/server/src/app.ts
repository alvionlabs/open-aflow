import type { AgentTimeline, Board } from '@openaflow/model'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { AGENT_ID } from './agent-timeline.ts'
import { actionGuard, readGuard, requestGuard } from './guard.ts'
import type { FolderListError, FolderListing } from './folder-list.ts'
import type { AddRepoError } from './repos-config.ts'
import { createToolRoutes, type ToolRoutesDeps } from './tool-routes.ts'

export const PING_MS = 15_000
/** The largest request body `/api/actions/*` and `POST /api/repos` take. Every real one is under 1 KB. */
export const BODY_LIMIT = 64 * 1024

/** Where the routes get the Board. The board watcher is one. */
export type BoardSource = {
  board(): Board
  subscribe(fn: (b: Board) => void): () => void
  rebuild(): Promise<void>
}

export type AppDeps = {
  /** The API and web ports: the only ones the request guard lets in. */
  ports: readonly number[]
  source: BoardSource
  addRepo: (path: string) => Promise<{ path: string } | { error: AddRepoError }>
  /** One board agent's tool timeline; undefined when it isn't on the Board or its file is gone. */
  timeline: (repoId: string, agentId: string) => Promise<AgentTimeline | undefined>
  pingMs?: number
  /** The per-launch session token every action request must carry. */
  token: string
  /** The action routes, mounted at /api/actions behind the action guard. */
  actions?: Hono
  /** Lists a folder's subfolders, or the roots with no path, for `GET /api/fs/folders`. With none, that route gets 404. */
  folders?: (dir: string | undefined) => Promise<FolderListing | { error: FolderListError }>
  /** The built web app (production), mounted after every API route and behind the request guard. With none, a page route gets 404. */
  web?: Hono | undefined
  /** The tool finder (production), for `GET /api/tools` and `POST /api/actions/tool-path`. With none, neither route exists: 404. */
  tools?: ToolRoutesDeps | undefined
}

const FOLDER_STATUS = { 'not a local path': 400, 'not absolute': 400, 'bad request': 400, 'not a directory': 404 } as const

const ADD_REPO_STATUS = { 'not absolute': 400, 'not a local path': 400, 'not a directory': 400, 'already registered': 409, 'config unreadable': 500 } as const

/**
 * The HTTP app. Routes live under /api; the web dev server proxies to it. Every
 * route sits behind the request guard, and `actions` (mounted at /api/actions)
 * and `POST /api/repos` also behind a 64 KB body limit (413) and the action
 * guard (a POST of a JSON object with the session token). With no `actions`,
 * a request past it gets 404. Routes under /api/fs/ sit behind the read guard
 * (the session token in its header); with no `folders`, they get 404 too.
 */
export function createApp(deps: AppDeps): Hono {
  const pingMs = deps.pingMs ?? PING_MS
  const app = new Hono()
  app.use('*', requestGuard({ ports: deps.ports }))
  // `/api/actions/*` also matches the bare `/api/actions`.
  const guard = actionGuard({ ports: deps.ports, token: deps.token })
  // After the request guard's Host and Origin checks, before the action guard reads the body.
  const limit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'payload too large' }, 413) })
  app.use('/api/actions/*', limit, guard)
  // Adding a repo makes the board read its files and run gh in it, so it's guarded like an action.
  app.use('/api/repos', limit, guard)
  if (deps.actions) app.route('/api/actions', deps.actions)
  if (deps.tools) {
    app.use('/api/tools', readGuard({ ports: deps.ports, token: deps.token }))
    app.route('/', createToolRoutes(deps.tools))
  }
  app.use('/api/fs/*', readGuard({ ports: deps.ports, token: deps.token }))

  const folders = deps.folders
  if (folders) {
    app.get('/api/fs/folders', async (c) => {
      const result = await folders(c.req.query('path'))
      return 'error' in result ? c.json({ error: result.error }, FOLDER_STATUS[result.error]) : c.json(result)
    })
  }

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/board', (c) => c.json(deps.source.board()))

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      // Boards are written in order, one at a time; a client that left gets no more.
      let queue: Promise<void> = Promise.resolve()
      const send = (b: Board) => {
        queue = queue.then(() => stream.writeSSE({ event: 'board', data: JSON.stringify(b) })).catch(() => {})
      }
      send(deps.source.board())
      const unsubscribe = deps.source.subscribe(send)
      const ping = setInterval(() => {
        queue = queue.then(() => stream.write(': ping\n\n')).then(
          () => {},
          () => {},
        )
      }, pingMs)
      await new Promise<void>((resolve) => {
        const stop = () => {
          clearInterval(ping)
          unsubscribe()
          resolve()
        }
        if (stream.aborted) stop()
        else stream.onAbort(stop)
      })
    }),
  )

  app.get('/api/agents/:repoId/:agentId/timeline', async (c) => {
    const { repoId, agentId } = c.req.param()
    const timeline = AGENT_ID.test(agentId) ? await deps.timeline(repoId, agentId) : undefined
    return timeline ? c.json(timeline) : c.json({ error: 'not found' }, 404)
  })

  app.post('/api/repos', async (c) => {
    // The action guard has checked the type, the token, and that the body is a JSON object.
    const repoPath = ((await c.req.json()) as { path?: unknown }).path
    if (typeof repoPath !== 'string') return c.json({ error: 'bad request' }, 400)

    let result: Awaited<ReturnType<AppDeps['addRepo']>>
    try {
      result = await deps.addRepo(repoPath)
    } catch {
      return c.json({ error: 'config unwritable' }, 500)
    }
    if ('error' in result) return c.json({ error: result.error }, ADD_REPO_STATUS[result.error])
    // The new repo is on the board, and sent to every client, before the 201.
    await deps.source.rebuild()
    return c.json({ path: result.path }, 201)
  })

  if (deps.web) app.route('/', deps.web)

  return app
}
