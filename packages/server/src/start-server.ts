// All the server's wiring, for both modes. Dev keeps its two ports and its token file. Production
// serves the web app on one port and keeps the token in memory. The table is in
// pod-docs/feature-details/server.md.

import { mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createActionLog } from './action-log.ts'
import { createActionRoutes } from './action-routes.ts'
import { createAnswerRoutes } from './answer-routes.ts'
import { createTimelineSource } from './agent-timeline.ts'
import { createApp } from './app.ts'
import { createAutoContinue } from './auto-continue.ts'
import { createAutoContinueStore } from './auto-continue-store.ts'
import { createBoardService } from './board-service.ts'
import { listFolders, nodeFolderFs } from './folder-list.ts'
import { portsDir } from './claims.ts'
import { claudeBin, createClaudeRunner } from './claude-runner.ts'
import { configPath, listenConfig, portFromEnv, type Env } from './config.ts'
import { createFoundGhExec, createGhReader, defaultGhExec } from './gh.ts'
import { openWithFallback, wantedPort } from './listen.ts'
import { createRemoveRepoRoutes } from './remove-repo-routes.ts'
import { addRepo, removeRepo } from './repos-config.ts'
import { createResumeRoutes } from './resume-routes.ts'
import { createIdleCheck } from './session-activity.ts'
import { createSessionToken, writeSessionToken } from './session-token.ts'
import { createShutdown, createWorkTracker } from './shutdown.ts'
import { createToolFinder } from './tool-finder.ts'
import { claudeDir, transcriptDays } from './transcript-files.ts'
import { createBoardWatcher } from './watcher.ts'
import { createWebApp } from './web-app.ts'

const HOSTNAME = '127.0.0.1'

/** preferredPort defaults to APP_PORT; tests pass their own. */
export type Production = { webDir: string; preferredPort?: number }
export type Started = { port: number; stop(): void }

/** Dev: the API port, no fallback, and the web port is also let in. Production: the port plan, and only the bound port is let in. */
function portPlan(env: Env, production: Production | undefined) {
  if (production) return { want: wantedPort(env, production.preferredPort), extraPorts: [] as number[] }
  const want = { port: listenConfig(env).port, fallback: false }
  return { want, extraPorts: [portFromEnv(env, 'POD_BOARD_WEB_PORT', 3001)] }
}

export async function startServer(env: Env, o: { production?: Production; exit?: (code: number) => void } = {}): Promise<Started> {
  const platform = process.platform
  const production = o.production
  const { want, extraPorts } = portPlan(env, production)
  const settings = {
    configFile: configPath(env, platform, homedir()),
    portsDir: portsDir(env, tmpdir()),
    claudeDir: claudeDir(env, homedir()),
    transcriptDays: transcriptDays(env),
    claudeBin: claudeBin(env),
  }
  const { configFile } = settings
  const configDir = dirname(configFile)

  // A fresh token each launch. Dev writes it before anything listens: no token file, no API.
  // Production keeps it in memory, so a dev page on the same config folder keeps working.
  const token = createSessionToken()
  let web: Hono | undefined
  if (production) {
    web = await createWebApp({ dir: production.webDir, token })
    try {
      await mkdir(configDir, { recursive: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      throw new Error(`could not create the config folder ${configDir}${code ? ` (${code})` : ''}`)
    }
  } else {
    await writeSessionToken(configDir, token)
  }

  // The action log sits next to the token: `<config dir>/actions.jsonl`, read once here.
  const log = createActionLog({ file: join(configDir, 'actions.jsonl'), now: Date.now })
  // The auto-continue toggles and the resume runs' stderr logs sit there too.
  const store = createAutoContinueStore({ file: join(configDir, 'auto-continue.json') })
  const logDir = join(configDir, 'resume-logs')
  // Production finds its tools with no terminal, and reads them at each call, so a Recheck needs no restart.
  // Dev stays on its PATH lookups.
  const tools = production ? createToolFinder({ env, platform, settingsFile: join(configDir, 'tool-paths.json') }) : undefined
  const ghExec = tools ? createFoundGhExec(tools) : defaultGhExec
  const runner = tools
    ? createClaudeRunner({ bin: () => tools.path('claude'), env: () => tools.env(), logDir })
    : createClaudeRunner({ bin: settings.claudeBin, logDir })
  const gh = createGhReader({ exec: ghExec })
  const service = createBoardService({ ...settings, platform, gh, actions: log.recent, autoContinue: store.list })
  const watcher = createBoardWatcher({ service, ...settings, poll: env.POD_BOARD_POLL === '1' })

  // The resume route and the automatic check share one set of sessions being resumed.
  const resume = {
    board: () => watcher.board(),
    rebuild: () => watcher.rebuild(),
    log,
    runner,
    store,
    idle: createIdleCheck({ claudeDir: settings.claudeDir, now: Date.now }),
    inFlight: new Set<string>(),
  }
  const auto = createAutoContinue({ ...resume, subscribe: (fn) => watcher.subscribe(fn) })

  // Every action is counted while it runs, so Ctrl+C can wait for it.
  const work = createWorkTracker()

  const buildApp = (port: number) =>
    createApp({
      ports: [port, ...extraPorts],
      token,
      source: watcher,
      web,
      tools,
      addRepo: (p) => addRepo(configFile, p, platform),
      folders: (dir) => listFolders(dir, { fs: nodeFolderFs, platform, home: homedir() }),
      timeline: createTimelineSource({ board: () => watcher.board(), ...settings, now: Date.now }).timeline,
      actions: new Hono()
        .use('*', work.track)
        .route(
          '/',
          createActionRoutes({
            board: () => watcher.board(),
            gh,
            exec: ghExec,
            refreshGh: (board) => service.refreshGh(board),
            rebuild: () => watcher.rebuild(),
            log,
          }),
        )
        .route('/', createAnswerRoutes({ board: () => watcher.board(), rebuild: () => watcher.rebuild(), log }))
        .route('/', createResumeRoutes(resume))
        .route(
          '/',
          createRemoveRepoRoutes({
            board: () => watcher.board(),
            removeRepo: (p) => removeRepo(configFile, p, platform),
            rebuild: () => watcher.rebuild(),
            forgetToggles: store.forgetPath,
            log,
          }),
        ),
    })

  /**
   * Binds a port. The app is built in the listening callback, before any connection can arrive,
   * because its guards need the port that was really bound: port 0 has no number until then.
   */
  const open = (port: number) =>
    new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve, reject) => {
      let app: Hono | undefined
      const server = serve(
        { fetch: (req, e) => (app ? app.fetch(req, e) : new Response(null, { status: 503 })), hostname: HOSTNAME, port },
        (info) => {
          server.off('error', reject)
          app = buildApp(info.port)
          resolve({ server, port: info.port })
        },
      )
      server.once('error', reject)
    })

  let bound: Awaited<ReturnType<typeof open>>
  // Before the watcher: its first Board already asks gh.
  await tools?.check()

  try {
    await watcher.start()
    bound = await openWithFallback(want, open)
  } catch (err) {
    await watcher.close().catch(() => {})
    throw err
  }

  if (bound.port !== want.port) console.log(`pod-board: port ${want.port} is busy; using ${bound.port} for this launch`)
  console.log(`pod-board API listening on http://${HOSTNAME}:${bound.port}`)
  console.log(`pod-board config: ${configFile}`)

  // After the bind: a server that can't start sends no `continue` to anyone's run.
  auto.start()

  const stop = createShutdown({ auto, server: bound.server, work, watcher, exit: o.exit ?? ((code) => process.exit(code)) })
  return { port: bound.port, stop }
}

/** Calls startServer. On a rejection, prints `pod-board: <message>` and exits 1. Connects SIGINT and SIGTERM to `stop`. */
export async function runMain(o: { production?: Production } = {}): Promise<void> {
  try {
    const { stop } = await startServer(process.env, o)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (err) {
    console.error(`pod-board: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
