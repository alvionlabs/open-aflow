// Skeleton: the tests fail on assertions until the real code lands.
import type { Env } from './config.ts'

export const STOP_MESSAGE = { type: 'pod-board:stop' } as const
export type ReadyMessage = { type: 'pod-board:ready'; port: number }
export type ParentChannel = { onMessage(fn: (m: unknown) => void): void; send(m: unknown): void }
export type ProcessLike = {
  parentPort?: { on(event: 'message', fn: (e: { data: unknown }) => void): unknown; postMessage(m: unknown): void }
  send?: (m: unknown, cb: (err: Error | null) => void) => unknown
  on?: (event: 'message', fn: (m: unknown) => void) => unknown
}
export type StopPath = { request(): void; signal(): void; attach(stop: () => void): void }

export function parentChannel(_proc?: ProcessLike): ParentChannel | undefined {
  return undefined
}
export const isStopMessage = (_m: unknown): boolean => false
export const processAlive = (_pid: number, _kill?: (pid: number, signal: number) => unknown): boolean => false
export const createStopPath = (): StopPath => ({ request() {}, signal() {}, attach() {} })
export const parentPid = (_env: Env): number | undefined => undefined
export const watchParent = (_o: { pid: number; onGone(): void; alive?: (pid: number) => boolean; intervalMs?: number }): (() => void) => () => {}
export const guardOutput = (_stream: { on(event: 'error', fn: (err: Error) => void): unknown }): void => {}
export const linkParent = (_o: { env: Env; stops: StopPath; proc?: ProcessLike }): { ready(port: number): void } => ({ ready() {} })
