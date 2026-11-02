// Board actions: the shapes the merge routes send and the action log keeps. Types only;
// times are epoch ms. The shapes are the sprint's shared contract (pod-docs/sprints/merge-actions.md).

import type { PrStatus } from './board.ts'

/** A fresh read of a waiting PR, shown before you confirm a merge. */
export type MergePreview = {
  number: number
  url: string
  title: string
  headSha: string
  state: PrStatus['state']
  checks: PrStatus['checks']
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  mergeState: string
}

export type MergeOutcome = 'merged' | 'queued' | 'auto-merge' | 'stale' | 'failed' | 'unconfirmed'

/** `merged` only ever comes from re-reading the PR after the merge call. */
export type MergeResult = { outcome: MergeOutcome; number: number; message?: string; headSha?: string; logged: boolean }

export type AnswerOutcome = 'answered' | 'changed' | 'failed'

/** What the answer route sends back. */
export type AnswerResult = { outcome: AnswerOutcome; message?: string; logged: boolean }

/** Close or Keep: the entry's `**Resolution:** pending` rewritten (`closed`, `kept`), or why not. */
export type ResolveOutcome = 'closed' | 'kept' | 'changed' | 'failed'

/** What the resolve route sends back. */
export type ResolveResult = { outcome: ResolveOutcome; message?: string; logged: boolean }

export type ResumeOutcome = 'started' | 'failed'

/** What the resume route sends back. */
export type ResumeResult = { outcome: ResumeOutcome; message?: string; logged: boolean }

export type RemoveRepoOutcome = 'removed' | 'failed'

/** What the remove-repo route sends back on success: the path taken out of the board's config. */
export type RemoveRepoResult = { outcome: 'removed'; path: string; logged: boolean }

/**
 * One logged action. A merge's `target` is `PR #N`; an answer's is the queue entry's
 * `<date> · <TYPE> · <from → to>`, never the answer text or the body; a resolve's (Close or Keep) the same. A resume's is
 * `<run> · <word>`; `auto` marks one the automatic check sent. A remove-repo's is the repo's path.
 */
export type ActionEntry = { at: number; repoId: string; repo: string; target: string; message?: string } & (
  | { action: 'merge'; result: MergeOutcome }
  | { action: 'answer'; result: AnswerOutcome }
  | { action: 'resolve'; result: ResolveOutcome }
  | { action: 'resume'; result: ResumeOutcome; reply: 'continue' | 'go'; auto: boolean }
  | { action: 'remove-repo'; result: RemoveRepoOutcome }
)

/** An entry before the log stamps its time. Omit spreads over the union, so `action` and `result` stay paired. */
export type NewActionEntry = ActionEntry extends infer E ? (E extends ActionEntry ? Omit<E, 'at'> : never) : never
