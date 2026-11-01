import type { Board, NewActionEntry } from '@pod-board/model'
import { Hono } from 'hono'
import type { RemoveRepoError } from './repos-config.ts'

export type RemoveRepoRouteDeps = {
  board(): Board
  removeRepo(path: string): Promise<{ path: string } | { error: RemoveRepoError }>
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
}

export function createRemoveRepoRoutes(_deps: RemoveRepoRouteDeps): Hono {
  return new Hono()
}
