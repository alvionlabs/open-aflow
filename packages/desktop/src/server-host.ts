export const READY_LIMIT_MS = 0
export const STOP_KILL_MS = 0
export const STABLE_MS = 0
export type ServerProcess = {
  pid: number | undefined
  postMessage(m: unknown): void
  kill(): boolean
  onMessage(fn: (m: unknown) => void): void
  onExit(fn: (code: number) => void): void
  onOutput(fn: (text: string) => void): void
}
export type ServerHost = {
  start(): void
  stop(): Promise<'stopped' | 'killed' | 'not running'>
  port(): number | undefined
  onReady(fn: (port: number) => void): () => void
  onFailed(fn: (error: string) => void): () => void
}
export function createServerHost(_o: { fork(): ServerProcess }): ServerHost {
  return { start() {}, stop: async () => 'stopped', port: () => undefined, onReady: () => () => {}, onFailed: () => () => {} }
}
