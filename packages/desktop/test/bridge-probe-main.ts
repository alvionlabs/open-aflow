// The real folder bridge proof's Electron entry: the same startShell as main.ts, with a stand-in for the native
// folder dialog, which automation can't answer. Once the window loads the board, it reads what the page sees,
// calls pickFolder() from the page, and writes the results to a status file. Only real-folder-bridge.test.ts runs this.

import { existsSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, dialog } from 'electron'
import { startShell } from '../src/shell-main.ts'

const env = process.env
const statusFile = env.OPENAFLOW_PROBE_STATUS!
const quitFile = env.OPENAFLOW_PROBE_QUIT!

type DialogCall = { parentIsWindow: boolean; options: unknown }
const status = {
  readyPorts: [] as number[],
  failed: undefined as string | undefined,
  page: undefined as unknown,
  dialogCalls: [] as DialogCall[],
  error: undefined as string | undefined,
}
const save = () => writeFileSync(statusFile, JSON.stringify(status))
save()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The stand-in. The bridge calls it through the same `dialog` object, so the IPC path, the sender check, and
// the parent window are all real.
let mode: 'path' | 'slow' | 'throw' = 'path'
let win: BrowserWindow | undefined
dialog.showOpenDialog = (async (parent: unknown, options: unknown) => {
  status.dialogCalls.push({ parentIsWindow: parent !== undefined && parent === win, options })
  save()
  if (mode === 'throw') throw new Error('probe dialog error')
  if (mode === 'slow') await sleep(500)
  return { canceled: false, filePaths: ['C:\\probe\\repo'] }
}) as typeof dialog.showOpenDialog

const shell = startShell({
  env,
  appPath: env.OPENAFLOW_PROBE_APP_PATH,
  activatorAtStart: false,
  onFailed: (error) => {
    status.failed = error
    save()
  },
})

// What the page's own script sees, in the main world.
const LOOK = `JSON.stringify({
  openaflow: typeof window.openaflow,
  keys: window.openaflow ? Reflect.ownKeys(window.openaflow).map(String) : null,
  pickFolder: typeof window.openaflow?.pickFolder,
  require: typeof require,
  process: typeof process,
  module: typeof module,
  electron: typeof electron,
  ipcRenderer: typeof ipcRenderer,
})`
const PICK = `window.openaflow.pickFolder()`
const TWO = `Promise.all([window.openaflow.pickFolder(), window.openaflow.pickFolder()])`
const FAIL = `window.openaflow.pickFolder().then(() => 'resolved', (e) => String(e && e.message))`
// A subframe gets no preload, so no bridge. The board's CSP blocks framing its own pages, so this is an
// about:blank frame, which shares the page's origin.
const SUBFRAME = `(() => {
  const f = document.createElement('iframe')
  document.body.appendChild(f)
  const seen = typeof f.contentWindow.openaflow
  f.remove()
  return seen
})()`

async function probe(w: BrowserWindow) {
  const run = (code: string): Promise<unknown> => w.webContents.executeJavaScript(code)
  try {
    const look = JSON.parse((await run(LOOK)) as string) as unknown
    mode = 'path'
    const picked = await run(PICK)
    mode = 'slow'
    const two = await run(TWO)
    mode = 'throw'
    const failed = await run(FAIL)
    mode = 'path'
    const after = await run(PICK)
    const subframe = await run(SUBFRAME)
    status.page = { look, picked, two, failed, after, subframe, url: w.webContents.getURL() }
  } catch (err) {
    status.error = err instanceof Error ? err.stack : String(err)
  }
  save()
}

if (shell) {
  shell.host.onReady((port) => {
    status.readyPorts.push(port)
    save()
  })
  app.on('browser-window-created', (_e, w) => {
    win = w
    w.webContents.once('did-finish-load', () => void probe(w))
  })
  setInterval(() => {
    if (existsSync(quitFile)) app.quit()
  }, 200)
}
