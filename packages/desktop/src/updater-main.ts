// Glue: the real updater and the real box. The logic is in update-flow.ts. The rules are in
// pod-docs/feature-details/desktop.md.

import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { APP_NAME } from './shell-config.ts'
import type { ShellContext } from './shell-main.ts'
import { readTestUpdate } from './update-feed.ts'
import { createUpdateFlow, type UpdaterPort } from './update-flow.ts'

/** `pnpm package --test-feed` sets this. In every other build the test feed's code is removed. */
declare const __POD_BOARD_TEST_FEED__: boolean

function realUpdater(feed: string | null): UpdaterPort {
  // Its own log prints URLs.
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // Nothing installs without a yes.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableWebInstaller = true
  if (feed !== null) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  return {
    check: () => autoUpdater.checkForUpdates(),
    install: () => autoUpdater.quitAndInstall(true, true),
    onDownloaded: (fn) => void autoUpdater.on('update-downloaded', (info) => fn(info.version)),
    onError: (fn) => void autoUpdater.on('error', (error) => fn(error)),
  }
}

const RESTART = 0
const LATER = 1

async function askBox(version: string): Promise<'restart' | 'later'> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: APP_NAME,
    message: `${APP_NAME} ${version} is ready to install.`,
    detail: 'Restart now to install it. Choose Later to keep this version, and the app asks again the next time it opens.',
    buttons: ['Restart now', 'Later'],
    defaultId: RESTART,
    cancelId: LATER,
    noLink: true,
  })
  return response === RESTART ? 'restart' : 'later'
}

export function startUpdater(ctx: ShellContext): void {
  let feed: string | null = null
  let firstCheckMs: number | undefined
  let ask = askBox
  if (__POD_BOARD_TEST_FEED__) {
    const test = readTestUpdate(ctx.env)
    if (app.isPackaged && test.feed === null) {
      console.error('pod-board desktop: update test feed ignored: it is not a loopback URL, so this build has no feed')
      return
    }
    feed = test.feed
    firstCheckMs = test.firstCheckMs ?? undefined
    const { answer } = test
    if (answer !== null) ask = async () => answer
  }

  let quitting = false
  app.once('before-quit', () => {
    quitting = true
  })

  const flow = createUpdateFlow({
    packaged: app.isPackaged,
    updater: () => realUpdater(feed),
    ask,
    stop: () => {
      // The page has no server from here on.
      for (const win of BrowserWindow.getAllWindows()) win.hide()
      return ctx.host.stop()
    },
    quit: () => app.quit(),
    quitting: () => quitting,
    clock: { after: (ms, fn) => void setTimeout(fn, ms) },
    log: (line) => console.log(line),
    firstCheckMs,
  })
  ctx.host.onReady(() => flow.ready())
}
