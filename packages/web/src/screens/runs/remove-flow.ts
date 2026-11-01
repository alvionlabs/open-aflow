// Remove a repo from the board: the ⋯ menu's item opens an in-place confirm under the run header.
// A pure reducer (idle → confirm → removing → idle on success, or → error; cancel → idle) and a
// small driver that sends the request. Every reply carries the number of the request it answers,
// so a reply that arrives after a cancel or another open is dropped.

import type { BoardRepo, RemoveRepoResult, RunSummary } from '@pod-board/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import { hashFor } from '../../selection.ts'

/**
 * The repo to remove. `alsoClaimed`: a port claim lists it too, so it stays on the board. `runs`: how many
 * sidebar runs are its own. `place`: where the confirm opens, `header` or the sidebar card's hash. `returnTo`:
 * the id of the ⋯ button that gets focus back when the confirm closes.
 */
export type RemoveTarget = { repoId: string; name: string; path: string; alsoClaimed: boolean; runs: number; place: string; returnTo: string }

/** The confirm's place under the run header. */
export const HEADER_PLACE = 'header'

/** The ⋯ menus' item. The confirm names the repo. */
export const REMOVE_ITEM = 'Remove repo'

/** A sidebar card's ⋯ button id. */
export const moreButtonId = (run: Pick<RunSummary, 'repoId' | 'plan' | 'fix'>) => `run-more-${hashFor(run)}`
export type Post = <T>(path: string, body: object) => Promise<ActionReply<T>>

export type RemoveState =
  | { kind: 'idle'; seq: number }
  | { kind: 'confirm'; seq: number; target: RemoveTarget }
  | { kind: 'removing'; seq: number; target: RemoveTarget; after?: string | undefined }
  | { kind: 'error'; seq: number; target: RemoveTarget; message: string }

export type RemoveEvent =
  | { type: 'open'; target: RemoveTarget }
  | { type: 'remove'; after?: string | undefined }
  | { type: 'removed'; seq: number; reply: ActionReply<RemoveRepoResult> }
  | { type: 'cancel' }
  | { type: 'key'; key: string }

export const INITIAL: RemoveState = { kind: 'idle', seq: 0 }

export function reduce(s: RemoveState, e: RemoveEvent): RemoveState {
  switch (e.type) {
    case 'open':
      return s.kind === 'removing' ? s : { kind: 'confirm', seq: s.seq, target: e.target }
    case 'remove':
      return s.kind === 'confirm' || s.kind === 'error' ? { kind: 'removing', seq: s.seq + 1, target: s.target, after: e.after } : s
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
  /** `after`: the hash to go to once removed, planned now from the runs and the selection (`hashAfterRemove`). */
  remove(after?: string): void
  cancel(): void
  key(key: string): void
}

/**
 * Runs the reducer, sends `remove-repo` as it moves to removing, and calls `onRemoved` after a removal with
 * the hash planned at Remove: by then the new Board may already have moved the selection.
 */
export function createRemoveFlow(
  onChange: (s: RemoveState) => void,
  onRemoved: (target: RemoveTarget, after: string | undefined) => void,
  post: Post = (path, body) => postAction(path, body),
): RemoveFlow {
  let state = INITIAL
  const dispatch = (e: RemoveEvent) => {
    const prev = state
    state = reduce(state, e)
    if (state === prev) return
    onChange(state)
    if (prev.kind === 'removing' && state.kind === 'idle') onRemoved(prev.target, prev.after)
    const s = state
    if (s.kind === 'removing') {
      void post<RemoveRepoResult>('remove-repo', { repoId: s.target.repoId, path: s.target.path }).then((reply) => dispatch({ type: 'removed', seq: s.seq, reply }))
    }
  }
  return {
    state: () => state,
    open: (target) => dispatch({ type: 'open', target }),
    remove: (after) => dispatch({ type: 'remove', after }),
    cancel: () => dispatch({ type: 'cancel' }),
    key: (key) => dispatch({ type: 'key', key }),
  }
}


/**
 * The Board repo a run belongs to. Two paths that differ only in non-alphanumeric characters
 * (`chess-web`, `chess_web`) share an id, so a run's repo name picks between them.
 */
export function repoOfRun(repos: BoardRepo[], run: RunSummary | undefined): BoardRepo | undefined {
  if (!run) return undefined
  const withId = repos.filter((r) => r.id === run.repoId)
  return withId.length > 1 ? (withId.find((r) => r.name === run.repo) ?? withId[0]) : withId[0]
}

/**
 * What Remove acts on, or undefined for a repo only a port claim lists (the board would list it again
 * from the claim) and for a repo whose id another Board repo shares (the rest of the page can't tell them apart).
 */
export function removeTarget(
  repo: BoardRepo | undefined,
  ctx: { repos: BoardRepo[]; runs: RunSummary[]; place: string; returnTo: string },
): RemoveTarget | undefined {
  if (!repo || repo.source === 'claim') return undefined
  if (ctx.repos.filter((r) => r.id === repo.id).length > 1) return undefined
  const runs = ctx.runs.filter((r) => isRunOf(r, repo.id, repo.name)).length
  return { repoId: repo.id, name: repo.name, path: repo.path, alsoClaimed: repo.source === 'both', runs, place: ctx.place, returnTo: ctx.returnTo }
}

/** Whether a run is this repo's: its id and, since two repos can share an id, its name. */
const isRunOf = (run: RunSummary, repoId: string, name: string) => run.repoId === repoId && run.repo === name

export type RemoveView = { heading: string; body: string; path: string; runsLine?: string; claimNote?: string; busy: boolean; status?: string; error?: string }

const BODY = "Only the board's list changes; its files aren't touched."
const CLAIM_NOTE = 'A running pod run also lists this repo through its port claim, so it stays in the sidebar until that run ends.'

const ERRORS: Record<string, string> = {
  'not registered': "This repo is no longer in the board's list.",
  'not on the board': "This repo is no longer in the board's list.",
  'config unreadable': "The board's config file can't be read, so nothing changed. Fix or delete config.json, then try again.",
  'config unwritable': "The board couldn't save its config file, so nothing changed.",
  'ambiguous repo': "Another repo on the board has the same id, so the board can't tell which one to remove. Nothing changed.",
}

/** The panel's words and state; undefined while closed. */
export function confirmView(s: RemoveState): RemoveView | undefined {
  if (s.kind === 'idle') return undefined
  const v: RemoveView = { heading: `Remove ${s.target.name}?`, body: BODY, path: s.target.path, busy: s.kind === 'removing' }
  const n = s.target.runs
  // A claim keeps the repo, and its runs, on the board.
  if (s.target.alsoClaimed) v.claimNote = CLAIM_NOTE
  else v.runsLine = n === 1 ? 'Its 1 run leaves the sidebar.' : `Its ${n} runs leave the sidebar.`
  if (s.kind === 'removing') v.status = 'Removing…'
  if (s.kind === 'error') v.error = ERRORS[s.message] ?? s.message
  return v
}

/**
 * Where the page goes after a removal: the next run of another repo after the selected one, else the
 * nearest one before it; `''` when no run is left (the empty state); undefined to stay, when a claim
 * keeps the repo on the board or the open run is another repo's (a remove from the sidebar).
 */
export function hashAfterRemove(runs: RunSummary[], selected: RunSummary | undefined, target: RemoveTarget): string | undefined {
  if (target.alsoClaimed) return undefined
  if (selected && !isRunOf(selected, target.repoId, target.name)) return undefined
  const at = selected ? runs.indexOf(selected) : -1
  // A run whose repo shares the id but not the name is a sibling repo's, and stays.
  const others = (list: RunSummary[]) => list.filter((r) => !isRunOf(r, target.repoId, target.name))
  const next = others(runs.slice(at + 1))[0] ?? others(runs.slice(0, Math.max(at, 0))).at(-1)
  return next ? hashFor(next) : ''
}


/**
 * Where the page goes when the remove succeeds: the hash planned at Remove, but only while the page still
 * shows the removed repo's run, the planned run (the new Board came first), or no run. A run the user
 * opened during the request stays.
 */
export function navigateAfterRemove(selected: RunSummary | undefined, target: RemoveTarget, after: string | undefined): string | undefined {
  if (after === undefined) return undefined
  if (!selected || isRunOf(selected, target.repoId, target.name) || hashFor(selected) === after) return after
  return undefined
}

/** The sidebar ⋯ label's run part: `<run name> (<repo>)`, or just the name when the run is named after its repo. */
export const moreName = (name: string, repo: string) => (name === repo ? name : `${name} (${repo})`)
