// Glue: one server process in a `utilityProcess`, shaped for server-host.ts.

import { dirname } from 'node:path'
import { utilityProcess } from 'electron'
import type { ServerProcess } from './server-host.ts'
import { SERVER_SERVICE_NAME } from './shell-config.ts'

export function forkServer(o: { entry: string; env: NodeJS.ProcessEnv; onSpawn?(pid: number): void }): ServerProcess {
  const child = utilityProcess.fork(o.entry, [], {
    stdio: 'pipe',
    cwd: dirname(o.entry),
    env: o.env,
    serviceName: SERVER_SERVICE_NAME,
  })
  child.on('spawn', () => {
    if (child.pid !== undefined) o.onSpawn?.(child.pid)
  })
  // An `exit` always follows, and an `error` with no listener would throw in the main process.
  child.on('error', () => {})
  return {
    get pid() {
      return child.pid
    },
    postMessage: (m) => child.postMessage(m),
    kill: () => child.kill(),
    onMessage: (fn) => void child.on('message', fn),
    onExit: (fn) => void child.on('exit', fn),
    onOutput: (fn) => {
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding('utf8')
        stream?.on('data', (text: string) => {
          // The shell's own log shows the server's lines. console ignores a closed stdout.
          console.log(text.trimEnd())
          fn(text)
        })
      }
    },
  }
}
