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
import { configPath, listenConfig, portFromEnv } from './config.ts'
import { createGhReader, defaultGhExec } from './gh.ts'
import { createRemoveRepoRoutes } from './remove-repo-routes.ts'
import { addRepo, removeRepo } from './repos-config.ts'
import { createResumeRoutes } from './resume-routes.ts'
import { createIdleCheck } from './session-activity.ts'
import { createSessionToken, writeSessionToken } from './session-token.ts'
import { createShutdown, createWorkTracker } from './shutdown.ts'
import { claudeDir, transcriptDays } from './transcript-files.ts'
import { createBoardWatcher } from './watcher.ts'

const env = process.env
const platform = process.platform

let settings
try {
  settings = {
    listen: listenConfig(env),
    webPort: portFromEnv(env, 'POD_BOARD_WEB_PORT', 3001),
    configFile: configPath(env, platform, homedir()),
    portsDir: portsDir(env, tmpdir()),
    claudeDir: claudeDir(env, homedir()),
    transcriptDays: transcriptDays(env),
    claudeBin: claudeBin(env),
  }
} catch (err) {
  console.error(`pod-board: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
const { listen, webPort, configFile } = settings

// A fresh token each launch, written before anything listens. No token file, no API.
const token = createSessionToken()
try {
  await writeSessionToken(dirname(configFile), token)
} catch (err) {
  console.error(`pod-board: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

// The action log sits next to the token: `<config dir>/actions.jsonl`, read once here.
const log = createActionLog({ file: join(dirname(configFile), 'actions.jsonl'), now: Date.now })
// The auto-continue toggles and the resume runs' stderr logs sit there too.
const store = createAutoContinueStore({ file: join(dirname(configFile), 'auto-continue.json') })
const runner = createClaudeRunner({ bin: settings.claudeBin, logDir: join(dirname(configFile), 'resume-logs') })
const gh = createGhReader({ exec: defaultGhExec })
const service = createBoardService({ ...settings, platform, gh, actions: log.recent, autoContinue: store.list })
const watcher = createBoardWatcher({ service, ...settings, poll: env.POD_BOARD_POLL === '1' })
await watcher.start()

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
auto.start()

// Every action is counted while it runs, so Ctrl+C can wait for it.
const work = createWorkTracker()

const app = createApp({
  ports: [listen.port, webPort],
  token,
  source: watcher,
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
        exec: defaultGhExec,
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

const server = serve({ fetch: app.fetch, hostname: listen.hostname, port: listen.port }, () => {
  console.log(`pod-board API listening on http://${listen.hostname}:${listen.port}`)
  console.log(`pod-board config: ${configFile}`)
})

const stop = createShutdown({ auto, server, work, watcher, exit: (code) => process.exit(code) })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
