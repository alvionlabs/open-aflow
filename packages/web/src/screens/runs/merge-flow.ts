// The merge confirm that opens in place under a step with a PR waiting on you.
// A pure reducer (idle → loading → confirm → merging → result, or → error; cancel → idle)
// and a small driver that sends the requests. Every reply carries the number of the
// request it answers, so a reply that arrives after a cancel or another open is dropped.

import type { MergeOutcome, MergePreview, MergeResult, PrStatus } from '@openaflow/model'
import { postAction, type ActionReply } from '../../actions-client.ts'
import { outcomeChip } from './action-log-view.ts'
import type { Chip, ChipClass } from './view.ts'

export type MergeTarget = { repoId: string; number: number }
export type Post = <T>(path: string, body: object) => Promise<ActionReply<T>>

/** `seq` counts requests; a reply for an older one is ignored. */
export type MergeState =
  | { kind: 'idle'; seq: number }
  | { kind: 'loading'; seq: number; target: MergeTarget }
  | { kind: 'confirm'; seq: number; target: MergeTarget; preview: MergePreview }
  | { kind: 'merging'; seq: number; target: MergeTarget; preview: MergePreview }
  | { kind: 'result'; seq: number; target: MergeTarget; preview: MergePreview; result: MergeResult }
  | { kind: 'error'; seq: number; target: MergeTarget; message: string }

export type MergeEvent =
  | { type: 'open'; target: MergeTarget }
  | { type: 'previewed'; seq: number; reply: ActionReply<MergePreview> }
  | { type: 'merge' }
  | { type: 'merged'; seq: number; reply: ActionReply<MergeResult> }
  | { type: 'retry' }
  | { type: 'cancel' }
  | { type: 'key'; key: string }

export const INITIAL: MergeState = { kind: 'idle', seq: 0 }

/** Why Merge is off for this preview, or undefined when it can run. Checks never block it. */
function blockReason(p: MergePreview): string | undefined {
  if (p.state === 'merged') return 'This PR is already merged.'
  if (p.state === 'closed') return 'This PR is closed.'
  if (p.mergeable === 'conflicting') return 'This PR has conflicts with its base branch. Resolve them on GitHub first.'
  return undefined
}

export function reduce(s: MergeState, e: MergeEvent): MergeState {
  switch (e.type) {
    case 'open':
      // One confirm at a time: opening another closes this one, but never mid-merge.
      return s.kind === 'merging' ? s : { kind: 'loading', seq: s.seq + 1, target: e.target }
    case 'previewed':
      if (s.kind !== 'loading' || e.seq !== s.seq) return s
      return e.reply.ok
        ? { kind: 'confirm', seq: s.seq, target: s.target, preview: e.reply.data }
        : { kind: 'error', seq: s.seq, target: s.target, message: e.reply.message }
    case 'merge':
      if (s.kind !== 'confirm' || blockReason(s.preview) !== undefined) return s
      return { kind: 'merging', seq: s.seq + 1, target: s.target, preview: s.preview }
    case 'merged':
      if (s.kind !== 'merging' || e.seq !== s.seq) return s
      return e.reply.ok
        ? { kind: 'result', seq: s.seq, target: s.target, preview: s.preview, result: e.reply.data }
        : { kind: 'error', seq: s.seq, target: s.target, message: e.reply.message }
    case 'retry':
      // Check again and Try again read the PR afresh; a merge is never resent from here.
      return s.kind === 'result' || s.kind === 'error' ? { kind: 'loading', seq: s.seq + 1, target: s.target } : s
    case 'cancel':
      return s.kind === 'idle' || s.kind === 'merging' ? s : { kind: 'idle', seq: s.seq }
    case 'key':
      return e.key === 'Escape' ? reduce(s, { type: 'cancel' }) : s
  }
}

export type MergeFlow = {
  state(): MergeState
  open(target: MergeTarget): void
  merge(): void
  retry(): void
  cancel(): void
  key(key: string): void
}

/** Runs the reducer and sends `merge-preview` and `merge` as it moves to loading and merging. */
export function createMergeFlow(onChange: (s: MergeState) => void, post: Post = (path, body) => postAction(path, body)): MergeFlow {
  let state = INITIAL
  const dispatch = (e: MergeEvent) => {
    const prev = state
    state = reduce(state, e)
    if (state === prev) return
    onChange(state)
    const s = state
    if (s.kind === 'loading') {
      void post<MergePreview>('merge-preview', { repoId: s.target.repoId, number: s.target.number }).then((reply) =>
        dispatch({ type: 'previewed', seq: s.seq, reply }),
      )
    } else if (s.kind === 'merging') {
      void post<MergeResult>('merge', { repoId: s.target.repoId, number: s.target.number, headSha: s.preview.headSha }).then((reply) =>
        dispatch({ type: 'merged', seq: s.seq, reply }),
      )
    }
  }
  return {
    state: () => state,
    open: (target) => dispatch({ type: 'open', target }),
    merge: () => dispatch({ type: 'merge' }),
    retry: () => dispatch({ type: 'retry' }),
    cancel: () => dispatch({ type: 'cancel' }),
    key: (key) => dispatch({ type: 'key', key }),
  }
}

/** Whether the flow's panel belongs to this PR of this repo. */
export const isOpenFor = (s: MergeState, repoId: string, number: number) => s.kind !== 'idle' && s.target.repoId === repoId && s.target.number === number

const CHECKS: Record<PrStatus['checks'], Chip> = {
  pass: { cls: 's-ok', label: 'checks pass' },
  fail: { cls: 's-bad', label: 'checks fail' },
  pending: { cls: 's-run', label: 'checks pending' },
  none: { cls: 's-idle', label: 'no checks' },
}

const MERGEABILITY: Record<MergePreview['mergeable'], string> = {
  mergeable: 'No conflicts',
  conflicting: 'Conflicts with the base branch',
  unknown: "GitHub hasn't checked for conflicts yet",
}

const sha7 = (sha: string) => sha.slice(0, 7)

/** The words for each outcome. `Merged` comes only from `merged`. */
function resultWords(r: MergeResult): string {
  const fixed: Partial<Record<MergeOutcome, string>> = {
    merged: 'Merged',
    queued: 'Added to the merge queue',
    'auto-merge': 'Auto-merge on: GitHub merges it when checks pass',
  }
  const word = fixed[r.outcome]
  if (word !== undefined) return word
  if (r.outcome === 'stale') return r.headSha ? `The PR changed since you looked (head now ${sha7(r.headSha)}).` : 'The PR changed since you looked.'
  const message = r.message?.trim()
  if (message) return message
  return r.outcome === 'failed' ? 'The merge failed.' : "GitHub hasn't confirmed the merge."
}

export type ConfirmView = {
  heading: string
  /** What's happening while a request runs. */
  status?: string
  title?: string
  checks?: Chip
  mergeability?: string
  /** The head sha you'd merge, 7 chars. */
  sha?: string
  result?: { words: string; tone: ChipClass; chip: Chip; note?: string }
  error?: string
  showMerge: boolean
  canMerge: boolean
  blockReason?: string
  checkAgain: boolean
  tryAgain: boolean
  closeLabel: 'Cancel' | 'Close'
  cancelDisabled: boolean
}

/** What the panel shows; undefined while closed. */
export function confirmView(s: MergeState): ConfirmView | undefined {
  if (s.kind === 'idle') return undefined
  const base: ConfirmView = {
    heading: `PR #${s.target.number}`,
    showMerge: false,
    canMerge: false,
    checkAgain: false,
    tryAgain: false,
    closeLabel: 'Cancel',
    cancelDisabled: false,
  }
  switch (s.kind) {
    case 'loading':
      return { ...base, status: 'Reading the PR from GitHub…' }
    case 'error':
      return { ...base, error: s.message, tryAgain: true, closeLabel: 'Close' }
    case 'confirm':
    case 'merging': {
      const p = s.preview
      const reason = blockReason(p)
      const shown = { ...base, title: p.title, checks: CHECKS[p.checks], mergeability: MERGEABILITY[p.mergeable], sha: sha7(p.headSha), showMerge: true }
      if (s.kind === 'merging') return { ...shown, status: 'Merging…', cancelDisabled: true }
      return reason === undefined ? { ...shown, canMerge: true } : { ...shown, blockReason: reason }
    }
    case 'result': {
      const r = s.result
      const chip = outcomeChip(r.outcome)
      const result: ConfirmView['result'] = { words: resultWords(r), tone: chip.cls, chip }
      if (!r.logged) result.note = 'Not saved to the action log.'
      return { ...base, title: s.preview.title, result, checkAgain: r.outcome === 'stale', closeLabel: 'Close' }
    }
  }
}
