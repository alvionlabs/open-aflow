import type { Board } from '@pod-board/model'

export type Toast = { title: string; body: string; hash: string }
export type NotifierOptions = {
  now(): number
  supported(): boolean
  send(toast: Toast): void
  setAttention(on: boolean): void
  onError(error: unknown): void
}
export type Notifier = { board(board: Board): void; lost(): void; close(): void }

export function createNotifier(_o: NotifierOptions): Notifier {
  return { board() {}, lost() {}, close() {} }
}
