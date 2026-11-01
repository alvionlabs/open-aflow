import type { BoardRepo, RunSummary } from '@pod-board/model'
import type { ActionReply } from '../../actions-client.ts'

export type RemoveTarget = { repoId: string; name: string; path: string; alsoClaimed: boolean }
export type Post = <T>(path: string, body: object) => Promise<ActionReply<T>>
export type RemoveState =
  | { kind: 'idle'; seq: number }
  | { kind: 'confirm'; seq: number; target: RemoveTarget }
  | { kind: 'removing'; seq: number; target: RemoveTarget }
  | { kind: 'error'; seq: number; target: RemoveTarget; message: string }
export type RemoveView = { heading: string; body: string; path: string; claimNote?: string; busy: boolean; status?: string; error?: string }
export type RemoveFlow = { state(): RemoveState; open(t: RemoveTarget): void; remove(): void; cancel(): void; key(k: string): void }

export const removeLabel = (_name: string) => ''
export const removeTarget = (_repo: BoardRepo | undefined): RemoveTarget | undefined => undefined
export const confirmView = (s: RemoveState): RemoveView | undefined => (s.kind === 'idle' ? undefined : { heading: '', body: '', path: '', busy: false })
export const hashAfterRemove = (_runs: RunSummary[], _selected: RunSummary | undefined, _t: RemoveTarget): string | undefined => undefined
export function createRemoveFlow(_onChange: (s: RemoveState) => void, _onRemoved: (t: RemoveTarget) => void, _post?: Post): RemoveFlow {
  const s: RemoveState = { kind: 'idle', seq: 0 }
  return { state: () => s, open: () => {}, remove: () => {}, cancel: () => {}, key: () => {} }
}
