// SPIKE ONLY. A bare Electron main: today's server utilityProcess, plus a pty host utilityProcess, a bare
// window, a quit dialog, a JSON run store, and (with OPENAFLOW_TEST=1) a test hook on globalThis.__spike.

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeImage, Tray, utilityProcess, type UtilityProcess } from 'electron'
import { forkServer } from '../src/host-main.ts'
import { createServerHost } from '../src/server-host.ts'
import { serverEntry, serverEnv } from '../src/server-launch.ts'
import { markerPids } from './proc.ts'

const env = process.env
const TEST = env.OPENAFLOW_TEST === '1'
const COLS = 120
const ROWS = 32
const SCREEN_SAVE_MS = 10_000
const HEARTBEAT_ALARM_MS = 11_000
const HOST_RESTARTS = 5
const TYPING_WAIT_MS = Number(env.OPENAFLOW_SPIKE_TYPING_WAIT_MS ?? 30_000)

if (env.OPENAFLOW_DESKTOP_DATA_DIR) app.setPath('userData', env.OPENAFLOW_DESKTOP_DATA_DIR)
const configDir = env.OPENAFLOW_CONFIG_DIR ?? join(app.getPath('userData'), 'config')
const spikeDir = join(configDir, 'spike')
const storeFile = join(spikeDir, 'runs.json')
const screensDir = join(spikeDir, 'screens')
const logFile = join(spikeDir, 'main.log')
mkdirSync(screensDir, { recursive: true })
const log = (...a: unknown[]) => {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}

// ---- run store ----

type Run = {
  id: string
  repo: string
  sessionId: string
  startedAt: string
  stopReason: string | null
  termId: string | null
  pid: number | null
  terms: { id: string; args: string[]; pid: number | null; startedAt: string }[]
  extraArgs: string[]
}
const readStore = (): Run[] => {
  try {
    return JSON.parse(readFileSync(storeFile, 'utf8')).runs
  } catch {
    return []
  }
}
let runs: Run[] = readStore()
const saveStore = () => {
  writeFileSync(storeFile, JSON.stringify({ runs }, null, 2))
  win?.webContents.send('spike:runs', runView())
}
const live = () => runs.filter((r) => r.stopReason === null && r.termId)
const runView = () =>
  runs.map((r) => ({ ...r, screen: r.stopReason ? readScreen(r.id) : null, hostAlarm }))
const readScreen = (runId: string) => {
  try {
    return readFileSync(join(screensDir, `${runId}.txt`), 'utf8')
  } catch {
    return null
  }
}

// At start: a run with no stop reason was live when the app last ended without a clean quit.
const startupLeftovers: { runId: string; markerPids: number[] }[] = []
const hostCrashSweeps: { runId: string; markerPids: number[] }[] = []
for (const r of runs) {
  if (r.stopReason === null) {
    r.stopReason = 'app closed'
    r.termId = null
    // The app ended without a clean quit. Anything still holding the run's marker is a leftover: end it.
    const found = process.platform === 'linux' ? markerPids(r.id) : []
    for (const pid of found) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
    startupLeftovers.push({ runId: r.id, markerPids: found })
  }
}

// ---- pty host ----

let host: UtilityProcess | undefined
let hostPid: number | undefined
let hostRestarts = 0
let hostStarts = 0
let lastBeat = Date.now()
let hostAlarm = false
let quitting = false
let reqSeq = 0
const pending = new Map<number, (v: any) => void>()
const lastInput = new Map<string, number>()
/** Per terminal: the time of the newest input that was not Enter. Cleared by nothing but a later submit. */
const lastDraft = new Map<string, number>()
const hostEntry = join(__dirname, 'pty-host.cjs')

function startHost() {
  hostStarts++
  const hostEnv = serverEnv(env, process.pid)
  if (app.isPackaged) hostEnv.OPENAFLOW_PTY_PATH = join(process.resourcesPath, 'native', 'node_modules', '@lydell', 'node-pty')
  const child = utilityProcess.fork(hostEntry, [], { stdio: 'pipe', serviceName: 'OpenAFlow pty host', env: hostEnv })
  host = child
  child.stdout?.on('data', (d) => log('[host]', String(d).trimEnd()))
  child.stderr?.on('data', (d) => log('[host:err]', String(d).trimEnd()))
  child.on('spawn', () => {
    hostPid = child.pid
    lastBeat = Date.now()
    log('host spawn', child.pid)
  })
  child.on('error', () => {})
  child.on('message', (m: any) => {
    if (m.op === 'heartbeat' || m.op === 'ready') {
      lastBeat = Date.now()
      if (hostAlarm) {
        hostAlarm = false
        saveStore()
      }
    } else if (m.op === 'reply') {
      pending.get(m.reqId)?.(m.value)
      pending.delete(m.reqId)
    } else if (m.op === 'created') {
      const r = runs.find((x) => x.termId === m.id)
      if (r) {
        r.pid = m.pid
        const t = r.terms.find((x) => x.id === m.id)
        if (t) t.pid = m.pid
        saveStore()
      }
    } else if (m.op === 'input') {
      lastInput.set(m.id, m.at)
      if (!m.enter) lastDraft.set(m.id, m.at)
    } else if (m.op === 'exit') {
      const r = runs.find((x) => x.termId === m.id)
      log('term exit', m)
      if (r && r.stopReason === null) {
        void saveScreen(r).finally(() => {
          r.stopReason = quitting ? 'quit' : `ended (exit ${m.exitCode})`
          r.termId = null
          saveStore()
        })
      }
    }
  })
  child.on('exit', (code) => {
    log('host exit', code, 'quitting', quitting)
    if (host !== child) return
    host = undefined
    for (const [, fn] of pending) fn(null)
    pending.clear()
    if (quitting) return
    // The pty master closed with the host, so each run's claude got SIGHUP. Show them as stopped, and end
    // anything that still holds a run's marker (a detached child outlives the pty).
    for (const r of live()) {
      r.stopReason = 'host crashed'
      r.termId = null
      const found = process.platform === 'linux' && env.OPENAFLOW_SPIKE_NO_SWEEP !== '1' ? markerPids(r.id) : []
      for (const pid of found) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // gone
        }
      }
      hostCrashSweeps.push({ runId: r.id, markerPids: found })
      log('host crash sweep', r.id, found)
    }
    saveStore()
    if (hostRestarts < HOST_RESTARTS) {
      hostRestarts++
      startHost()
    }
  })
}

const hostCall = (m: Record<string, unknown>): Promise<any> =>
  new Promise((resolve) => {
    if (!host) return resolve(null)
    const reqId = ++reqSeq
    pending.set(reqId, resolve)
    host.postMessage({ ...m, reqId })
  })

setInterval(() => {
  const late = Date.now() - lastBeat > HEARTBEAT_ALARM_MS
  if (late !== hostAlarm && host) {
    hostAlarm = late
    log('host alarm', late)
    saveStore()
  }
}, 1000)

// ---- runs ----

const claudeBin = () => env.OPENAFLOW_SPIKE_CLAUDE ?? 'claude'
const KEPT = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'])
function runEnv(runId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    const u = k.toUpperCase()
    if (v === undefined || u === 'ELECTRON_RUN_AS_NODE' || u.startsWith('OPENAFLOW_TEST') || u === 'OPENAFLOW_PARENT_PID') continue
    if (!KEPT.has(u) && (u.startsWith('ANTHROPIC_') || u.startsWith('CLAUDE'))) continue
    out[k] = v
  }
  out.OPENAFLOW_RUN = runId
  out.TERM = 'xterm-256color'
  return out
}

function openTerm(r: Run, args: string[]) {
  const termId = `${r.id}-${r.terms.length + 1}`
  r.termId = termId
  r.stopReason = null
  r.terms.push({ id: termId, args, pid: null, startedAt: new Date().toISOString() })
  saveStore()
  host?.postMessage({ op: 'create', id: termId, runId: r.id, file: claudeBin(), args, cwd: r.repo, env: runEnv(r.id), cols: COLS, rows: ROWS })
  return termId
}

function startRun(o: { repo?: string; extraArgs?: string[] } = {}) {
  const repo = o.repo ?? env.OPENAFLOW_SPIKE_REPO
  if (!repo) throw new Error('no repo: set OPENAFLOW_SPIKE_REPO')
  const r: Run = { id: randomUUID().slice(0, 8), repo, sessionId: randomUUID(), startedAt: new Date().toISOString(), stopReason: null, termId: null, pid: null, terms: [], extraArgs: o.extraArgs ?? [] }
  runs.push(r)
  const termId = openTerm(r, ['--session-id', r.sessionId, ...r.extraArgs])
  return { runId: r.id, termId, sessionId: r.sessionId }
}

/** Resume never runs by itself: only this button (or the test hook that presses it). */
function resumeRun(runId: string) {
  const r = runs.find((x) => x.id === runId)
  if (!r || r.stopReason === null) return null
  if (!existsSync(r.repo)) return { error: 'repo folder is gone' }
  return { termId: openTerm(r, ['--resume', r.sessionId, ...r.extraArgs]) }
}

async function saveScreen(r: Run) {
  if (!r.termId) return
  const s = await hostCall({ op: 'serialize', id: r.termId })
  if (typeof s === 'string') writeFileSync(join(screensDir, `${r.id}.txt`), s)
}
setInterval(() => {
  for (const r of live()) void saveScreen(r)
}, SCREEN_SAVE_MS)

// ---- auto-continue (a toggle; the spike only tests the gate) ----

type HookEvent = { event: string; session_id?: string; at: number; [k: string]: unknown }
function hookEvents(sessionId?: string): HookEvent[] {
  const dir = env.OPENAFLOW_SPIKE_HOOKLOG
  if (!dir) return []
  try {
    return readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HookEvent)
      .filter((e) => !sessionId || e.session_id === sessionId)
  } catch {
    return []
  }
}

function sendGate(runId: string) {
  const r = runs.find((x) => x.id === runId)
  const reasons: string[] = []
  if (!r || r.stopReason !== null || !r.termId) reasons.push('not live')
  const typed = r?.termId ? lastInput.get(r.termId) : undefined
  if (typed && Date.now() - typed < TYPING_WAIT_MS) reasons.push(`typed ${Date.now() - typed} ms ago`)
  // Hook state, not the screen. Idle = the newest idle event (SessionStart, Stop, Notification idle_prompt)
  // with nothing after it that opens a turn or a dialog (UserPromptSubmit, PreToolUse, PermissionRequest,
  // Notification permission_prompt, ...).
  const evs = r ? hookEvents() : []
  const isIdle = (e: HookEvent) => e.event === 'Stop' || e.event === 'SessionStart' || (e.event === 'Notification' && e.notification_type === 'idle_prompt')
  const idleAt = evs.map(isIdle).lastIndexOf(true)
  const last = evs[evs.length - 1]
  if (idleAt < 0) reasons.push('no idle hook event yet')
  const after = evs.slice(idleAt + 1).filter((e) => !isIdle(e) && e.event !== 'SubagentStop' && e.event !== 'SessionEnd')
  if (idleAt >= 0 && after.length) reasons.push(`busy or dialog: ${after.map((e) => e.event + (e.notification_type ? `(${e.notification_type})` : '')).join(', ')}`)
  // A draft: input with no Enter after the newest submit. The box may hold text; only a submit proves it empty.
  const submitAt = Math.max(0, ...evs.filter((e) => e.event === 'UserPromptSubmit' || e.event === 'SessionStart').map((e) => e.at))
  const draft = r?.termId ? lastDraft.get(r.termId) : undefined
  if (draft && draft > submitAt) reasons.push('draft in the input box (typed with no submit since)')
  return { ok: reasons.length === 0, reasons, lastEvent: last ?? null }
}

const sendLog: unknown[] = []
const pendingSends = new Map<string, ReturnType<typeof setInterval>>()
/** Asks for a send. It waits until the gate opens, then writes `continue` + Enter once. */
function requestSend(runId: string, word = 'continue') {
  cancelSend(runId)
  const tryNow = () => {
    const g = sendGate(runId)
    sendLog.push({ at: Date.now(), runId, ...g })
    if (!g.ok) return false
    const r = runs.find((x) => x.id === runId)!
    host?.postMessage({ op: 'write', id: r.termId, data: word })
    setTimeout(() => host?.postMessage({ op: 'write', id: r.termId, data: '\r' }), 300)
    log('auto-continue sent', runId, word)
    cancelSend(runId)
    return true
  }
  if (tryNow()) return { sent: true }
  pendingSends.set(runId, setInterval(tryNow, 1000))
  return { sent: false, waiting: sendGate(runId).reasons }
}
function cancelSend(runId: string) {
  clearInterval(pendingSends.get(runId))
  pendingSends.delete(runId)
}

// ---- server (today's) ----

const server = createServerHost({
  fork: () =>
    forkServer({
      entry: serverEntry({ packaged: app.isPackaged, appPath: join(__dirname, '..'), resourcesPath: process.resourcesPath }),
      env: serverEnv(env, process.pid),
      onSpawn: (pid) => {
        serverPids.push(pid)
        log('server spawn', pid)
      },
    }),
})
const serverPids: number[] = []
server.onFailed((e) => log('server failed', e))

// ---- window ----

let win: BrowserWindow | undefined
let tray: Tray | undefined

function openWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  const w = win
  w.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    w.hide()
  })
  w.on('closed', () => {
    if (win === w) win = undefined
  })
  w.once('ready-to-show', () => (TEST ? w.showInactive() : w.show()))
  void w.loadFile(join(__dirname, 'page.html'))
}
const showWindow = () => {
  if (!win) openWindow()
  else TEST ? win.showInactive() : win.show()
}

ipcMain.handle('spike:runs', () => runView())
ipcMain.handle('spike:resume', (_e, runId: string) => resumeRun(runId))
ipcMain.handle('spike:start', () => startRun())
ipcMain.on('spike:attach', (e, termId: string) => {
  const { port1, port2 } = new MessageChannelMain()
  host?.postMessage({ op: 'attach', id: termId }, [port1])
  e.sender.postMessage('spike:port', { id: termId }, [port2])
})

// ---- quit ----

let quitConfirmed = false
let quitDone = false
async function confirmQuit(): Promise<boolean> {
  const n = live().length
  if (n === 0) return true
  const names = live().map((r) => `• ${r.repo} (${r.id})`).join('\n')
  const res = await dialog.showMessageBox({
    type: 'warning',
    message: `${n} ${n === 1 ? 'run is' : 'runs are'} active. Quit ends ${n === 1 ? 'it' : 'them'}.`,
    detail: names,
    buttons: ['Quit and end runs', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  return res.response === 0
}

const quitResults: unknown[] = []
app.on('before-quit', (e) => {
  if (quitDone) return
  e.preventDefault()
  if (quitting) return
  void (async () => {
    if (!quitConfirmed && !(await confirmQuit())) {
      log('quit cancelled')
      return
    }
    quitting = true
    for (const r of live()) await saveScreen(r)
    const killed = await hostCall({ op: 'killAll' })
    quitResults.push(killed)
    log('killAll', killed)
    for (const r of live()) {
      r.stopReason = 'quit'
      r.termId = null
    }
    saveStore()
    host?.kill()
    await server.stop()
    quitDone = true
    app.quit()
  })()
})

// ---- start ----

app.on('window-all-closed', () => {})
Menu.setApplicationMenu(null)
if (!app.requestSingleInstanceLock()) app.exit(0)

void app.whenReady().then(async () => {
  writeFileSync(storeFile, JSON.stringify({ runs }, null, 2))
  startHost()
  server.start()
  openWindow()
  tray = new Tray(nativeImage.createFromPath(join(__dirname, '..', 'assets', 'tray.png')))
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open', click: showWindow }, { label: 'Quit', click: () => app.quit() }]))
  tray.on('click', showWindow)
  log('started', { pid: process.pid, leftovers: startupLeftovers })
})

if (TEST) {
  ;(globalThis as any).__spike = {
    status: () => ({ mainPid: process.pid, hostPid, hostStarts, hostRestarts, hostAlarm, serverPids, serverPort: server.port(), runs, startupLeftovers, hostCrashSweeps, quitResults, typingWaitMs: TYPING_WAIT_MS }),
    startRun,
    resumeRun,
    hostBuffer: (termId: string) => hostCall({ op: 'buffer', id: termId }),
    hostStats: () => hostCall({ op: 'stats' }),
    hostList: () => hostCall({ op: 'list' }),
    markers: (runId: string) => hostCall({ op: 'markers', runId }),
    write: (termId: string, text: string) => {
      host?.postMessage({ op: 'write', id: termId, data: text })
      lastInput.set(termId, Date.now())
      if (!text.includes('\r')) lastDraft.set(termId, Date.now())
    },
    sendGate,
    requestSend,
    cancelSend,
    sendLog: () => sendLog,
    hookEvents,
    showWindow,
    hideWindow: () => win?.hide(),
    reloadWindow: () => win?.webContents.reload(),
    destroyWindow: () => {
      win?.destroy()
      win = undefined
    },
    windowCount: () => BrowserWindow.getAllWindows().length,
    confirmQuitNext: () => (quitConfirmed = true),
    log,
  }
}

