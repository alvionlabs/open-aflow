// Forget this run: the header ⋯ item opens the shared confirm modal, and Forget asks the server to delete the run's
// one port claim file (`forget-run`). A pure reducer (idle → confirm → forgetting → idle on success, or → error) and a
// small driver that sends the request. Every reply carries the number of the request it answers; a reply that arrives
// after a cancel, or after the modal sent again, is dropped.

import { forgetCheck, type BoardRepo, type ForgetRunResult, type RunSummary } from '@openaflow/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import { hashFor } from '../../selection.ts'
import type { ModalView, Post } from './remove-flow.ts'

/** The ⋯ menu's item. */
export const FORGET_ITEM = 'Forget this run'

/** The header ⋯ trigger's id (BarMenu's MENU_TRIGGER_ID): it is on the page before and after a forget. */
const RETURN_TO = 'run-menu-trigger'

/**
 * The run to forget, taken when the modal opens: the Board drops the run once its claim is gone, so the modal keeps
 * what it showed. `run` is the claim's name, `name` the run's human name, `worktree` the folder that stays.
 */
export type ForgetTarget = { repoId: string; run: string; name: string; worktree: string; portBase: number }

/**
 * Where the run's work stays on disk, with the repo path's own separator: `<repo>/.claude/worktrees/<run>` for a
 * one-off run, or the `.claude/worktrees` folder itself for a plan run, which has one worktree per slice.
 */
export function worktreePath(repoPath: string, run: string, oneOff: boolean): string {
  const sep = repoPath.includes('\\') ? '\\' : '/'
  const folder = [repoPath.replace(/[\\/]+$/, ''), '.claude', 'worktrees'].join(sep)
  return oneOff ? `${folder}${sep}${run}` : folder
}

/** What Forget acts on, or undefined unless `forgetCheck` allows it: a run listed only through its one claim, not running. */
export function forgetTarget(repo: BoardRepo | undefined, run: RunSummary | undefined, name: string, now: number): ForgetTarget | undefined {
  if (!repo || !run || run.plan === undefined) return undefined
  const check = forgetCheck(repo, run.plan, now)
  if (!check.ok) return undefined
  return { repoId: repo.id, run: run.plan, name, worktree: worktreePath(repo.path, run.plan, run.fix !== undefined), portBase: check.portBase }
}

export type ForgetState =
  | { kind: 'idle'; seq: number }
  | { kind: 'confirm'; seq: number; target: ForgetTarget }
  | { kind: 'forgetting'; seq: number; target: ForgetTarget; after?: string | undefined }
  | { kind: 'error'; seq: number; target: ForgetTarget; message: string }

export type ForgetEvent =
  | { type: 'open'; target: ForgetTarget }
  | { type: 'forget'; after?: string | undefined }
  | { type: 'forgotten'; seq: number; reply: ActionReply<ForgetRunResult> }
  | { type: 'cancel' }

export const INITIAL: ForgetState = { kind: 'idle', seq: 0 }

/**
 * A cancel while forgetting closes the modal and drops the reply. The modal itself can't cancel then (busy); only a
 * run change does, as when the new Board comes first and the page has already moved to the planned run.
 */
export function reduce(s: ForgetState, e: ForgetEvent): ForgetState {
  switch (e.type) {
    case 'open':
      return s.kind === 'forgetting' ? s : { kind: 'confirm', seq: s.seq, target: e.target }
    case 'forget':
      return s.kind === 'confirm' || s.kind === 'error' ? { kind: 'forgetting', seq: s.seq + 1, target: s.target, after: e.after } : s
    case 'forgotten':
      if (s.kind !== 'forgetting' || e.seq !== s.seq) return s
      return e.reply.ok ? { kind: 'idle', seq: s.seq } : { kind: 'error', seq: s.seq, target: s.target, message: e.reply.message }
    case 'cancel':
      return s.kind === 'idle' ? s : { kind: 'idle', seq: s.seq }
  }
}

export type ForgetFlow = {
  state(): ForgetState
  open(target: ForgetTarget): void
  /** `after`: the hash to go to once forgotten, planned now (`hashAfterForget`). */
  forget(after?: string): void
  cancel(): void
}

/** Runs the reducer, sends `forget-run` as it moves to forgetting, and calls `onForgotten` after a success. */
export function createForgetFlow(
  onChange: (s: ForgetState) => void,
  onForgotten: (target: ForgetTarget, after: string | undefined) => void,
  post: Post = (path, body) => postAction(path, body),
): ForgetFlow {
  let state = INITIAL
  const dispatch = (e: ForgetEvent) => {
    const prev = state
    state = reduce(state, e)
    if (state === prev) return
    onChange(state)
    if (prev.kind === 'forgetting' && state.kind === 'idle' && e.type === 'forgotten') onForgotten(prev.target, prev.after)
    const s = state
    if (s.kind === 'forgetting') {
      const { repoId, run, portBase } = s.target
      void post<ForgetRunResult>('forget-run', { repoId, run, portBase }).then((reply) => dispatch({ type: 'forgotten', seq: s.seq, reply }))
    }
  }
  return {
    state: () => state,
    open: (target) => dispatch({ type: 'open', target }),
    forget: (after) => dispatch({ type: 'forget', after }),
    cancel: () => dispatch({ type: 'cancel' }),
  }
}

const DETAIL = 'The board stops listing this run. Its worktree and branch stay.'

/** The forget-run route's words; any other message (the client's own, or a new word) shows as is. */
const ERRORS: Record<string, string> = {
  'bad request': "The board couldn't read this request. Reload the page, then try again.",
  'not on the board': "This run's repo is no longer on the board.",
  'not a run': 'This run is no longer on the board.',
  'no claim': "This run's port claim is already gone.",
  'still listed': 'The board would still list this run without its port claim, so nothing changed.',
  'ambiguous repo': "Another repo on the board has the same id, so the board can't tell which run to forget. Nothing changed.",
  'run is running': 'This run is running again, so the board keeps it. Nothing changed.',
  'claim changed': 'The port claim file now names another run, so nothing was deleted.',
  'claim unremovable': "The board couldn't delete the port claim file, so the run stays.",
}

/** The modal's words and state; undefined while closed. The mono lines are what a hand undo needs. */
export function forgetView(s: ForgetState): ModalView | undefined {
  if (s.kind === 'idle') return undefined
  const v: ModalView = {
    heading: `Forget ${s.target.name}?`,
    detail: DETAIL,
    mono: [s.target.worktree, `port base ${s.target.portBase}`],
    confirmLabel: 'Forget',
    busy: s.kind === 'forgetting',
    returnFocusTo: RETURN_TO,
  }
  if (s.kind === 'forgetting') v.status = 'Forgetting…'
  if (s.kind === 'error') v.error = ERRORS[s.message] ?? s.message
  return v
}

const isTarget = (run: RunSummary, t: ForgetTarget) => run.repoId === t.repoId && run.plan === t.run

/**
 * Where the page goes after a forget: the next run after the forgotten one, else the one before it, else `''` (the
 * empty state). Undefined to stay, when the open run is another one.
 */
export function hashAfterForget(runs: RunSummary[], selected: RunSummary | undefined, target: ForgetTarget): string | undefined {
  if (!selected || !isTarget(selected, target)) return undefined
  const at = runs.indexOf(selected)
  const others = (list: RunSummary[]) => list.filter((r) => !isTarget(r, target))
  const next = others(runs.slice(at + 1))[0] ?? others(runs.slice(0, Math.max(at, 0))).at(-1)
  return next ? hashFor(next) : ''
}

/** Where the page goes when the reply comes: the planned hash, while the page shows the forgotten run, the planned one, or none. */
export function navigateAfterForget(selected: RunSummary | undefined, target: ForgetTarget, after: string | undefined): string | undefined {
  if (after === undefined) return undefined
  if (!selected || isTarget(selected, target) || hashFor(selected) === after) return after
  return undefined
}
