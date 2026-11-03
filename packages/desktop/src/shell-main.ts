import type { ServerHost } from './server-host.ts'
import type { ShellBus } from './shell-bus.ts'

export type ShellContext = { host: ServerHost; bus: ShellBus; env: NodeJS.ProcessEnv }

export type ShellOptions = {
  env: NodeJS.ProcessEnv
  appPath?: string | undefined
  onServer?(pid: number): void
  onFailed?(error: string): void
}

export function startShell(_o: ShellOptions): ShellContext | undefined {
  return undefined
}
