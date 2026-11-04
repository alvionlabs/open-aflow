// The real exit proof's Electron entry: the same startShell as main.ts, plus a status file that
// real-exit.test.ts polls and a quit file it writes. Only that test runs this.

import { existsSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { forkServer } from '../src/host-main.ts'
import { serverEnv } from '../src/server-launch.ts'
import { startShell } from '../src/shell-main.ts'

const env = process.env
const statusFile = env.POD_BOARD_PROBE_STATUS!
const quitFile = env.POD_BOARD_PROBE_QUIT!

const status = {
  mainPid: process.pid,
  servers: [] as number[],
  readyPorts: [] as number[],
  failed: undefined as string | undefined,
  showWindow: 0,
  lockLost: false,
  reporter: undefined as unknown,
}
const save = () => writeFileSync(statusFile, JSON.stringify(status))
save()

const shell = startShell({
  env,
  appPath: env.POD_BOARD_PROBE_APP_PATH,
  onServer: (pid) => {
    status.servers.push(pid)
    save()
  },
  // In place of the error box, which waits for a click.
  onFailed: (error) => {
    status.failed = error
    save()
  },
})

if (!shell) {
  status.lockLost = true
  save()
} else {
  shell.host.onReady((port) => {
    status.readyPorts.push(port)
    save()
  })
  shell.bus.onShowWindow(() => {
    status.showWindow++
    save()
  })
  const reporter = env.POD_BOARD_PROBE_REPORTER
  if (reporter) {
    void app.whenReady().then(() => {
      forkServer({ entry: reporter, env: serverEnv(env, process.pid) }).onMessage((m) => {
        status.reporter = m
        save()
      })
    })
  }
  setInterval(() => {
    if (existsSync(quitFile)) app.quit()
  }, 200)
}
