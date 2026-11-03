import type { Board } from '@pod-board/model'

export const RETRY_MS = 5000
export const SILENCE_MS = 45_000

export type BoardStreamOptions = {
  fetch(url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> | null }>
  onBoard(board: Board): void
  onLost(): void
}
export type BoardStream = { moveTo(port: number): void; close(): void }

export function createBoardStream(_o: BoardStreamOptions): BoardStream {
  return { moveTo() {}, close() {} }
}
