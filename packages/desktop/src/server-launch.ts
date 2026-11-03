// Where the server bundle is, and the env it starts with.

import { join } from 'node:path'

const PARENT_PID = 'POD_BOARD_PARENT_PID'
/** With this set, Electron's exe runs as plain Node, which a utilityProcess must not. */
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** Unpackaged: <appPath>/../server/dist/app/server.mjs. Packaged: <resourcesPath>/server/server.mjs. Never resources/app, which Electron loads as an app. */
export function serverEntry(o: { packaged: boolean; appPath: string; resourcesPath: string }): string {
  if (o.packaged) return join(o.resourcesPath, 'server', 'server.mjs')
  return join(o.appPath, '..', 'server', 'dist', 'app', 'server.mjs')
}

/** A copy of env with POD_BOARD_PARENT_PID = mainPid, an old value replaced, and ELECTRON_RUN_AS_NODE removed in any case. */
export function serverEnv(env: NodeJS.ProcessEnv, mainPid: number): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (upper !== RUN_AS_NODE && upper !== PARENT_PID) out[key] = value
  }
  out[PARENT_PID] = String(mainPid)
  return out
}
