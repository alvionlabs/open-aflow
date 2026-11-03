// The Reply panel's rows and words: which reply pod waits for, and the chat to paste it in.
// Session ids and commands only, never prompt text.

import { replySession, runReplies, sendableReply, type BoardRepo, type ReplyWord, type RunSummary } from '@pod-board/model'

export const NO_SESSION = 'No pod session found for this run. Paste it in the chat that runs it.'

/**
 * A session id the runner resumes: `^[A-Za-z0-9-]{1,64}$` with no leading `-`, the same rule as
 * the server's claude runner. Any other id, or no session, and a send could only fail.
 */
const SENDABLE_SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

/**
 * `send`: the word the row's Continue or Go button sends, only where sendableReply allows it and
 * the run has a session id the runner accepts. Without it the row keeps only Copy.
 */
export type ReplyRowView = { key: string; word: ReplyWord; why: string; send?: 'continue' | 'go' }
export type ReplySessionView = { line: string; time?: string; path: string; cd: string; resume?: string }
export type ReplyPanelView = { target: { repoId: string; run: string }; rows: ReplyRowView[]; session?: ReplySessionView; noSession?: string }

/** Local `HH:MM`. */
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The `cd` line to copy. A POSIX path (starts with `/`) goes in single quotes, each `'` written
 * `'\''`, so a shell runs no `$(...)` or backtick in it. A Windows path keeps `cd "<path>"`:
 * it can't hold a `"`.
 */
function cdCommand(repoPath: string): string {
  if (repoPath.startsWith('/')) return `cd '${repoPath.replaceAll("'", "'\\''")}'`
  return `cd "${repoPath}"`
}

/** The panel for the selected plan or fix run, when pod waits for a reply; undefined for a repo row or no reply. */
export function replyPanel(run: RunSummary | undefined, repo: BoardRepo | undefined, now: number): ReplyPanelView | undefined {
  if (!run || !repo || run.plan === undefined) return undefined
  const replies = runReplies(repo, run.plan, now)
  if (replies.length === 0) return undefined
  const plan = run.plan
  const s = replySession(repo, plan, now)
  const canSend = s?.resume !== undefined && SENDABLE_SESSION.test(s.id)
  const rows = replies.map((r): ReplyRowView => {
    const row: ReplyRowView = { key: r.reply, word: r.reply, why: r.why }
    if (canSend && r.reply !== 'try' && sendableReply(repo, plan, r.reply, now)?.key === r.key) row.send = r.reply
    return row
  })
  const target = { repoId: repo.id, run: plan }
  if (!s) return { target, rows, noSession: NO_SESSION }
  const session: ReplySessionView = { line: `Session ${s.id}`, path: s.repoPath, cd: cdCommand(s.repoPath) }
  if (s.startedAt !== undefined) session.time = `first agent ${clock(s.startedAt)}`
  if (s.resume !== undefined) session.resume = s.resume
  return { target, rows, session }
}
