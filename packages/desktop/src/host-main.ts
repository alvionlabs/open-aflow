import type { ServerProcess } from './server-host.ts'

export function forkServer(_o: { entry: string; env: NodeJS.ProcessEnv; onSpawn?(pid: number): void }): ServerProcess {
  throw new Error('not built')
}
