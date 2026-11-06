// The merge action's gh calls: the fresh PR read (preview, and before and after a merge), the
// merge call itself, the merge-queue question, and how the re-read maps to an outcome. Never passes --admin, --auto,
// --squash, --rebase, or --delete-branch. The rules and why are in pod-docs/feature-details/actions.md.

import type { MergeOutcome, MergePreview, MergeResult } from '@open-aflow/model'
import { rollupChecks, type ExecResult, type GhExec } from './gh.ts'

export const MERGE_TIMEOUT_MS = 60_000
/** gh 2.92's `pr view --json` has no merge-queue field; the queue is asked with QUEUE_QUERY instead. */
export const VIEW_FIELDS = 'number,state,url,title,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,autoMergeRequest'
/** GitHub GraphQL: the PR's merge-queue entry, `null` when it isn't in a queue. */
export const QUEUE_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { mergeQueueEntry { state } } } }'
const MESSAGE_MAX = 500
const SHA = /^[0-9a-f]{40}$/
const STATES: Record<string, MergePreview['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
const MERGEABLE: Record<string, MergePreview['mergeable']> = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting' }
// Escape sequences: CSI (colors, cursor) and OSC (links, titles).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g

export type ReadResult = { ok: true; preview: MergePreview; autoMerge: boolean } | { ok: false; message: string }
export type MergeRun = Omit<MergeResult, 'logged'> & {
  /** Whether the merge call ran (step 2), so the caller drops the PR from gh's cache. */
  ran: boolean
}

/** gh's text without escape codes, trimmed, at most 500 chars; `fallback` when nothing is left. */
export function ghText(stderr: string | undefined, fallback: string): string {
  const text = (stderr ?? '').replace(ANSI, '').trim().slice(0, MESSAGE_MAX).trim()
  return text || fallback
}

const safeExec = async (exec: GhExec, args: string[], cwd: string, timeoutMs?: number): Promise<ExecResult> => {
  try {
    return await (timeoutMs === undefined ? exec(args, cwd) : exec(args, cwd, { timeoutMs }))
  } catch {
    return { status: 'failed', stdout: '' }
  }
}

/** A fresh `gh pr view` of PR `n`. Not ok when gh fails, or its url isn't `https://github.com/<owner>/<name>/pull/<n>`. */
export async function readPr(exec: GhExec, repoPath: string, n: number): Promise<ReadResult> {
  const r = await safeExec(exec, ['pr', 'view', String(n), '--json', VIEW_FIELDS], repoPath)
  if (r.status !== 'ok') return { ok: false, message: ghText(r.stderr, 'gh failed') }
  return parseView(r.stdout, n) ?? { ok: false, message: 'gh failed' }
}

function parseView(stdout: string, n: number): ReadResult | undefined {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  const state = typeof d.state === 'string' ? STATES[d.state] : undefined
  const url = typeof d.url === 'string' ? d.url : ''
  const head = typeof d.headRefOid === 'string' ? d.headRefOid : ''
  if (!state || !isPullUrl(url, n) || !SHA.test(head)) return undefined
  return {
    ok: true,
    preview: {
      number: n,
      url,
      title: typeof d.title === 'string' ? d.title : '',
      headSha: head,
      state,
      checks: rollupChecks(d.statusCheckRollup),
      mergeable: (typeof d.mergeable === 'string' && MERGEABLE[d.mergeable]) || 'unknown',
      mergeState: typeof d.mergeStateStatus === 'string' ? d.mergeStateStatus : '',
    },
    autoMerge: d.autoMergeRequest !== null && typeof d.autoMergeRequest === 'object',
  }
}

/** Owner and name from `https://github.com/<owner>/<name>/pull/<n>`; undefined for any other url. */
const pullRepo = (url: string, n: number): { owner: string; name: string } | undefined => {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d*)$/.exec(url)
  return m && Number(m[3]) === n ? { owner: m[1]!, name: m[2]! } : undefined
}
const isPullUrl = (url: string, n: number) => pullRepo(url, n) !== undefined

/** Whether GitHub shows PR `n` (at `url`) in a merge queue. False when the question fails. */
async function inMergeQueue(exec: GhExec, repoPath: string, url: string, n: number): Promise<boolean> {
  const repo = pullRepo(url, n)
  if (!repo) return false
  // -f for owner and name: -F would turn a name like "123" into a number.
  const args = ['api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${n}`]
  const r = await safeExec(exec, args, repoPath)
  if (r.status !== 'ok') return false
  try {
    const entry = (JSON.parse(r.stdout) as { data?: { repository?: { pullRequest?: { mergeQueueEntry?: unknown } } } })?.data?.repository?.pullRequest?.mergeQueueEntry
    return entry !== null && typeof entry === 'object'
  } catch {
    return false
  }
}

/**
 * Merges PR `n` if its head is still `headSha`: a fresh read, then exactly
 * `gh pr merge <url> --merge --match-head-commit <sha>` (60 s), then always a re-read.
 * `merged` only ever comes from the re-read.
 */
export async function mergePr(exec: GhExec, repoPath: string, n: number, headSha: string): Promise<MergeRun> {
  const before = await readPr(exec, repoPath, n)
  if (!before.ok) return { outcome: 'failed', number: n, message: before.message, ran: false }
  if (before.preview.headSha !== headSha) return { outcome: 'stale', number: n, headSha: before.preview.headSha, ran: false }

  const call = await safeExec(exec, ['pr', 'merge', before.preview.url, '--merge', '--match-head-commit', headSha], repoPath, MERGE_TIMEOUT_MS)
  const after = await readPr(exec, repoPath, n)
  // Asked only when the call succeeded and the re-read is open with no auto-merge.
  const queued = isOpenAfterSuccess(call, after) && (await inMergeQueue(exec, repoPath, after.preview.url, n))
  const { outcome, message } = mergeOutcome(call, after, queued)
  return { outcome, number: n, ...(message !== undefined ? { message } : {}), ran: true }
}

const isOpenAfterSuccess = (call: ExecResult, after: ReadResult): after is Extract<ReadResult, { ok: true }> =>
  call.status === 'ok' && after.ok && after.preview.state === 'open' && !after.autoMerge

/** The contract's step 3, in order. `queued`: GitHub showed the PR in a merge queue. */
function mergeOutcome(call: ExecResult, after: ReadResult, queued: boolean): { outcome: MergeOutcome; message?: string } {
  if (after.ok && after.preview.state === 'merged') return { outcome: 'merged' }
  if (after.ok && after.preview.state === 'open' && after.autoMerge) return { outcome: 'auto-merge' }
  // Open after a successful call: queued only on GitHub's word; else it may be a re-read lagging a merge.
  if (isOpenAfterSuccess(call, after)) {
    if (queued) return { outcome: 'queued' }
    return { outcome: 'unconfirmed', message: "gh ran the merge, but GitHub hasn't confirmed the merge yet. Check it on GitHub." }
  }
  if (call.status !== 'ok') return { outcome: 'failed', message: ghText(call.stderr, 'gh pr merge failed') }
  if (after.ok) return { outcome: 'failed', message: 'PR is closed' }
  return { outcome: 'unconfirmed', message: "gh ran the merge, but couldn't read the PR again to confirm it. Check it on GitHub." }
}
