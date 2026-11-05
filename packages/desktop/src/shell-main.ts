// Glue: the app's start, for main.ts and the guarded probe. The logic is in the plain modules. The
// rules are in pod-docs/feature-details/desktop.md.

import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu } from 'electron'
import { forkServer } from './host-main.ts'
import { startNotifier } from './notifier-main.ts'
import { createQuitFlow } from './quit-flow.ts'
import { createServerHost, type ServerHost } from './server-host.ts'
import { serverEntry, serverEnv } from './server-launch.ts'
import { createShellBus, type ShellBus } from './shell-bus.ts'
import { APP_ID, APP_NAME, dataDirOverride } from './shell-config.ts'
import { createLogFile, LOG_FILE, nodeLogFs, teeConsole } from './shell-log.ts'
import { applyTestEnv, TEST_ENV_FILE } from './update-feed.ts'
import { startUpdater } from './updater-main.ts'
import { startWindow } from './window-main.ts'

/** `pnpm package --test-feed` sets this. In every other build the test feed's code is removed. */
declare const __POD_BOARD_TEST_FEED__: boolean

export type ShellContext = {
  host: ServerHost
  bus: ShellBus
  env: NodeJS.ProcessEnv
  /** Registers the toast activator at the start. Electron then writes a Start-menu shortcut, so a dev run doesn't. */
  activatorAtStart: boolean
}

export type ShellOptions = {
  env: NodeJS.ProcessEnv
  /** The probe runs from a temp folder, so it names the package. Default: `app.getAppPath()`. */
  appPath?: string | undefined
  onServer?(pid: number): void
  /** Default: only a packaged app. The real toast test turns it on and removes what it leaves. */
  activatorAtStart?: boolean
  /** In place of the error box, which waits for a click. The app quits after either. */
  onFailed?(error: string): void
}

const showFailure = (error: string) => dialog.showErrorBox(APP_NAME, `The server stopped and could not restart.\n\n${error}`)

/** Returns `undefined` on a second launch, which starts no server and exits. */
export function startShell(o: ShellOptions): ShellContext | undefined {
  if (__POD_BOARD_TEST_FEED__ && app.isPackaged && !applyTestEnv(o.env, join(dirname(process.execPath), '..', TEST_ENV_FILE))) {
    console.error('pod-board desktop: a test build needs temp folders, so it will not start')
    app.exit(1)
    return undefined
  }
  app.setName(APP_NAME)
  app.setAppUserModelId(APP_ID)
  const dataDir = dataDirOverride(o.env)
  if (dataDir !== undefined) app.setPath('userData', dataDir)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return undefined
  }

  // After the lock, so one file has one writer.
  teeConsole(console, createLogFile({ file: join(app.getPath('userData'), LOG_FILE), fs: nodeLogFs, now: () => new Date(), home: app.getPath('home') }))

  Menu.setApplicationMenu(null)
  // With this listener, the app stays alive with no window.
  app.on('window-all-closed', () => {})

  const entry = serverEntry({ packaged: app.isPackaged, appPath: o.appPath ?? app.getAppPath(), resourcesPath: process.resourcesPath })
  const host = createServerHost({
    fork: () => forkServer({ entry, env: serverEnv(o.env, process.pid), onSpawn: o.onServer }),
  })
  const bus = createShellBus()
  const ctx: ShellContext = { host, bus, env: o.env, activatorAtStart: o.activatorAtStart ?? app.isPackaged }

  const flow = createQuitFlow({
    stop: () => host.stop(),
    hide: () => {
      for (const win of BrowserWindow.getAllWindows()) win.hide()
    },
    quit: () => app.quit(),
  })
  app.on('before-quit', (e) => flow.beforeQuit(e))
  // `session-end` is a window's event, so each window reports it.
  app.on('browser-window-created', (_e, win) => win.on('session-end', () => flow.sessionEnd()))
  app.on('second-instance', () => bus.showWindow())
  host.onFailed((error) => {
    ;(o.onFailed ?? showFailure)(error)
    app.quit()
  })

  void app.whenReady().then(() => {
    startWindow(ctx)
    startNotifier(ctx)
    startUpdater(ctx)
    host.start()
  })
  return ctx
}
