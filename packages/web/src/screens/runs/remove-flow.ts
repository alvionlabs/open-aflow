// Remove a repo from the board: the ⋯ menu's item opens an in-place confirm under the run header.
// A pure reducer (idle → confirm → removing → idle on success, or → error; cancel → idle) and a
// small driver that sends the request. Every reply carries the number of the request it answers,
// so a reply that arrives after a cancel or another open is dropped.

import type { BoardRepo, RemoveRepoResult, RunSummary } from '@pod-board/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import { hashFor } from '../../selection.ts'

/** The repo to remove. `alsoClaimed`: a port claim lists it too, so it stays on the board. */
export type RemoveTarget = { repoId: string; name: string; path: string; alsoClaimed: boolean }
export type Post = <T>(path: string, body: object) => Promise<ActionReply<T>>

export type RemoveState =
  | { kind: 'idle'; seq: number }
  | { kind: 'confirm'; seq: number; target: RemoveTarget }
  | { kind: 'removing'; seq: number; target: RemoveTarget }
  | { kind: 'error'; seq: number; target: RemoveTarget; message: string }

export type RemoveEvent =
  | { type: 'open'; target: RemoveTarget }
  | { type: 'remove' }
  | { type: 'removed'; seq: number; reply: ActionReply<RemoveRepoResult> }
  | { type: 'cancel' }
  | { type: 'key'; key: string }

export const INITIAL: RemoveState = { kind: 'idle', seq: 0 }

export function reduce(s: RemoveState, e: RemoveEvent): RemoveState {
  switch (e.type) {
    case 'open':
      return s.kind === 'removing' ? s : { kind: 'confirm', seq: s.seq, target: e.target }
    case 'remove':
      return s.kind === 'confirm' || s.kind === 'error' ? { kind: 'removing', seq: s.seq + 1, target: s.target } : s
    case 'removed':
      if (s.kind !== 'removing' || e.seq !== s.seq) return s
      return e.reply.ok ? { kind: 'idle', seq: s.seq } : { kind: 'error', seq: s.seq, target: s.target, message: e.reply.message }
    case 'cancel':
      return s.kind === 'idle' || s.kind === 'removing' ? s : { kind: 'idle', seq: s.seq }
    case 'key':
      return e.key === 'Escape' ? reduce(s, { type: 'cancel' }) : s
  }
}

export type RemoveFlow = {
  state(): RemoveState
  open(target: RemoveTarget): void
  remove(): void
  cancel(): void
  key(key: string): void
}

/** Runs the reducer, sends `remove-repo` as it moves to removing, and calls `onRemoved` after a removal. */
export function createRemoveFlow(
  onChange: (s: RemoveState) => void,
  onRemoved: (target: RemoveTarget) => void,
  post: Post = (path, body) => postAction(path, body),
): RemoveFlow {
  let state = INITIAL
  const dispatch = (e: RemoveEvent) => {
    const prev = state
    state = reduce(state, e)
    if (state === prev) return
    onChange(state)
    if (prev.kind === 'removing' && state.kind === 'idle') onRemoved(prev.target)
    const s = state
    if (s.kind === 'removing') {
      void post<RemoveRepoResult>('remove-repo', { repoId: s.target.repoId }).then((reply) => dispatch({ type: 'removed', seq: s.seq, reply }))
    }
  }
  return {
    state: () => state,
    open: (target) => dispatch({ type: 'open', target }),
    remove: () => dispatch({ type: 'remove' }),
    cancel: () => dispatch({ type: 'cancel' }),
    key: (key) => dispatch({ type: 'key', key }),
  }
}

/** The ⋯ menu item's label. */
export const removeLabel = (name: string) => `Remove ${name} from the board`

/** What Remove acts on, or undefined for a repo only a port claim lists: the board would list it again from the claim. */
export function removeTarget(repo: BoardRepo | undefined): RemoveTarget | undefined {
  if (!repo || repo.source === 'claim') return undefined
  return { repoId: repo.id, name: repo.name, path: repo.path, alsoClaimed: repo.source === 'both' }
}

export type RemoveView = { heading: string; body: string; path: string; claimNote?: string; busy: boolean; status?: string; error?: string }

const BODY = "This changes only the board's list. The repo's files, pod docs, and runs are not touched. You can add it again with Add repo."
const CLAIM_NOTE = 'A running pod run also lists this repo through its port claim, so it stays in the sidebar until that run ends.'

const ERRORS: Record<string, string> = {
  'not registered': "This repo is no longer in the board's list.",
  'not on the board': "This repo is no longer in the board's list.",
  'config unreadable': "The board's config file can't be read, so nothing changed. Fix or delete config.json, then try again.",
  'config unwritable': "The board couldn't save its config file, so nothing changed.",
}

/** The panel's words and state; undefined while closed. */
export function confirmView(s: RemoveState): RemoveView | undefined {
  if (s.kind === 'idle') return undefined
  const v: RemoveView = { heading: `${removeLabel(s.target.name)}?`, body: BODY, path: s.target.path, busy: s.kind === 'removing' }
  if (s.target.alsoClaimed) v.claimNote = CLAIM_NOTE
  if (s.kind === 'removing') v.status = 'Removing…'
  if (s.kind === 'error') v.error = ERRORS[s.message] ?? s.message
  return v
}

/**
 * Where the page goes after a removal: the next run of another repo after the selected one, else the
 * nearest one before it; `''` when no run is left (the empty state); undefined to stay, when a claim
 * keeps the repo on the board.
 */
export function hashAfterRemove(runs: RunSummary[], selected: RunSummary | undefined, target: RemoveTarget): string | undefined {
  if (target.alsoClaimed) return undefined
  const at = selected ? runs.indexOf(selected) : -1
  const others = (list: RunSummary[]) => list.filter((r) => r.repoId !== target.repoId)
  const next = others(runs.slice(at + 1))[0] ?? others(runs.slice(0, Math.max(at, 0))).at(-1)
  return next ? hashFor(next) : ''
}

export const repoOfRun = (_repos: BoardRepo[], _run: RunSummary | undefined): BoardRepo | undefined => undefined
