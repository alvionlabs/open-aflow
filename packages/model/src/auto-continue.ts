// Auto-continue: which reply the board may send for a run, and which toggled runs it sends now.
// Pure. The rules and why are in pod-docs/feature-details/queue-and-replies.md.

import type { Board, BoardRepo } from './board.ts'
import { SEND_SIGNALS, replySession, runReplies, type RunReply } from './replies.ts'

/**
 * A run whose auto-continue toggle is on. `path` is its repo's `repoPathKey`, not its id: an id changes when
 * a clash with another repo forms or ends, and another repo can take it. `lastKey` is the stop it last sent for; `answeredKeys` the
 * `answered` keys it sent (newest last, at most `ANSWERED_KEYS_MAX`), so a pod that never rewrites an
 * answered entry's Resolution doesn't get the same answers sent again after another stop.
 */
export type AutoToggle = { path: string; run: string; lastKey?: string; answeredKeys?: string[] }

/** How a toggle names a repo: its normalized path, case-folded where its file system ignores case (the `sameRepoPath` rule). */
export const repoPathKey = (repo: { path: string; caseless?: boolean }): string => (repo.caseless ? repo.path.toLowerCase() : repo.path)

/** How many sent `answered` keys a toggle remembers. */
export const ANSWERED_KEYS_MAX = 20

/** The toggle's `answeredKeys` after a send of `key`: an `answered` key joins once, newest last, bounded. */
export function withAnsweredKey(keys: string[] | undefined, key: string): string[] | undefined {
  if (!key.startsWith('answered:')) return keys
  return [...(keys ?? []).filter((k) => k !== key), key].slice(-ANSWERED_KEYS_MAX)
}

/** One automatic `continue` to send now. */
export type AutoSend = { repoId: string; run: string; session: string; key: string }

/**
 * The reply of `word` the board may send, from a run's replies: `continue` only on a send signal
 * (the `*-waiting` ones need your merge first), `go` only on `not-started`. Any other word, `try`
 * included, gives nothing.
 */
export function sendableFrom(replies: RunReply[], word: 'continue' | 'go'): RunReply | undefined {
  if (word === 'continue') return replies.find((r) => r.reply === 'continue' && SEND_SIGNALS.has(r.signal))
  if (word === 'go') return replies.find((r) => r.reply === 'go' && r.signal === 'not-started')
  return undefined
}

/** The reply of `word` the board may send on a run now. The resume route and the buttons use this one rule. */
export function sendableReply(repo: BoardRepo, run: string, word: 'continue' | 'go', now: number): RunReply | undefined {
  return sendableFrom(runReplies(repo, run, now), word)
}

/** How long after a fix PR's merge the board may still send `continue` by itself. */
export const AUTO_MERGED_MS = 30 * 60 * 1000

/**
 * Whether auto-continue may send this reply. A merged fix run stays listed until cleanup frees its claim, so its
 * `fix-merged` can be days old, with a session long gone quiet. Only a merge in the last AUTO_MERGED_MS sends, and never
 * one with no merge time. The Continue button has no such limit.
 */
export function autoMaySend(repo: BoardRepo, reply: RunReply, now: number): boolean {
  if (reply.signal !== 'fix-merged') return true
  const mergedAt = repo.prs.find((p) => p.number === reply.pr)?.mergedAt
  return mergedAt !== undefined && now - mergedAt < AUTO_MERGED_MS
}

/**
 * The `continue` sends due now: for each toggle, in order, its repo on the Board, a sendable
 * `continue` whose key isn't the toggle's `lastKey` and that `autoMaySend` allows, a session with a safe id, and that session idle.
 * At most one per session, the first toggle's. Never `go`, `try`, or a queue answer. `idle` is only
 * asked about a safe session id.
 */
export function autoSends(board: Board, toggles: AutoToggle[], now: number, idle: (repo: BoardRepo, session: string) => boolean): AutoSend[] {
  const out: AutoSend[] = []
  const taken = new Set<string>()
  for (const t of toggles) {
    const repo = board.repos.find((r) => repoPathKey(r) === t.path)
    if (!repo) continue
    const reply = sendableFrom(runReplies(repo, t.run, now), 'continue')
    if (!reply || reply.reply !== 'continue' || reply.key === t.lastKey) continue
    if (reply.signal === 'answered' && t.answeredKeys?.includes(reply.key)) continue
    if (!autoMaySend(repo, reply, now)) continue
    const session = replySession(repo, t.run, now)
    if (!session?.resume || taken.has(session.id)) continue
    if (!idle(repo, session.id)) continue
    taken.add(session.id)
    out.push({ repoId: repo.id, run: t.run, session: session.id, key: reply.key })
  }
  return out
}
