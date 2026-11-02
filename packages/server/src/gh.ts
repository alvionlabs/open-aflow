import { execFile } from 'node:child_process'
import type { GhStatus, PrStatus } from '@pod-board/model'
import { resolveBin, safeChildEnv } from './bin-path.ts'

// The contract types live in the model; re-exported for callers of this module.
export type { GhStatus, PrStatus }

/** `not-found`: the `gh` binary isn't on PATH. `failed`: it ran and exited non-zero, timed out, or was killed. */
export type ExecResult = { status: 'ok' | 'failed' | 'not-found'; stdout: string; stderr?: string }
/** `timeoutMs` replaces the 10 s default (the merge call waits 60 s). */
export type ExecOptions = { timeoutMs?: number }
export type GhExec = (args: string[], cwd: string, opts?: ExecOptions) => Promise<ExecResult>

export type GhReader = {
  status(): GhStatus
  /** When `gh auth status` last ran. */
  checkedAt(): number | undefined
  get(repoPath: string, n: number): PrStatus | undefined
  /** The PR found by its head branch (a fix run's `fix-<slug>`, or a plan's final PR on `<plan-slug>`), with `branch` set. */
  getBranch(repoPath: string, branch: string): PrStatus | undefined
  /**
   * Fetches the PRs that are due, by number and by head branch. `staging` heads are asked about every
   * PR_CACHE_MS even after a merge (every plan reuses the branch). `true` when the gh status or
   * any PR's number, state, checks, or url changed.
   */
  refresh(repoPath: string, numbers: number[], branches?: string[], staging?: string[]): Promise<boolean>
}

/** The reader the merge routes use: it can also drop a PR, so the next refresh fetches it again. */
export type GhCache = GhReader & {
  /** Drops the PR's entry by number and any branch entry holding that number, final or not. */
  forget(repoPath: string, n: number): void
}

export const AUTH_RECHECK_MS = 60_000
export const PR_CACHE_MS = 30_000
export const GH_TIMEOUT_MS = 10_000
const PR_FIELDS = 'number,state,url,statusCheckRollup,baseRefName,mergedAt'
/** `title` names a fix run in its header; only PRs found by branch need it. */
const LIST_FIELDS = `${PR_FIELDS},headRefName,title`
/** A branch gh can't read as a flag, with no spaces or shell characters. */
const BRANCH = /^[A-Za-z0-9][\w./-]{0,199}$/

/** Runs `file` directly (no shell) with a 10 s timeout (or `opts.timeoutMs`) and prompts turned off. */
export const createExec =
  (file: string, env: NodeJS.ProcessEnv = process.env): GhExec =>
  (args, cwd, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: opts?.timeoutMs ?? GH_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
        env: { ...safeChildEnv(env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
        if (!err) return resolve({ status: 'ok', ...out })
        const code = (err as NodeJS.ErrnoException).code
        resolve({ status: code === 'ENOENT' ? 'not-found' : 'failed', ...out })
      },
    )
  })

/** The `gh` binary on the env's PATH. */
/**
 * The absolute path of `gh` on the env's PATH, from absolute entries only, never the
 * current or the repo's folder: a cloned repo could hold its own `gh.exe`. On Windows only
 * `gh.com` and `gh.exe` count, as for the bare-name lookup this replaces (a `.cmd` or `.bat`
 * can't run without a shell).
 */
export const ghBin = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined =>
  resolveBin('gh', env, platform, { exts: ['.com', '.exe'] })

/**
 * Runs `gh` with `env`, by the absolute path `ghBin` finds. The path is looked up once and
 * kept; while none is found, each call looks again (so a `gh` installed later is used) and
 * answers `not-found`.
 */
export const createGhExec = (env: NodeJS.ProcessEnv = process.env): GhExec => {
  let exec: GhExec | undefined
  return (args, cwd, opts) => {
    if (!exec) {
      const file = ghBin(env)
      if (!file) return Promise.resolve({ status: 'not-found', stdout: '' })
      exec = createExec(file, env)
    }
    return exec(args, cwd, opts).then((r) => {
      // The kept gh is gone (uninstalled or moved): look it up again next time.
      if (r.status === 'not-found') exec = undefined
      return r
    })
  }
}

/** Runs `gh`. */
export const defaultGhExec: GhExec = createGhExec()

type Entry = { value?: PrStatus; fetchedAt?: number; inflight?: Promise<boolean> }

export function createGhReader(opts: { exec?: GhExec; now?: () => number } = {}): GhCache {
  const exec = opts.exec ?? defaultGhExec
  const now = opts.now ?? Date.now
  let status: GhStatus = 'unknown'
  let authAt: number | undefined
  let authInflight: Promise<boolean> | undefined
  const cache = new Map<string, Entry>()

  const keyOf = (repoPath: string, n: number) => `${n}\u0000${repoPath}`
  const branchKey = (repoPath: string, branch: string) => `branch\u0000${branch}\u0000${repoPath}`

  const safeExec = async (args: string[], cwd: string): Promise<ExecResult> => {
    try {
      return await exec(args, cwd)
    } catch {
      return { status: 'failed', stdout: '' }
    }
  }

  const setStatus = (next: GhStatus) => {
    const changed = next !== status
    status = next
    return changed
  }

  /** Runs `gh auth status` when it's due; returns whether the status changed. */
  const checkAuth = (cwd: string): Promise<boolean> => {
    if (authInflight) return authInflight
    if (authAt !== undefined && now() - authAt < AUTH_RECHECK_MS) return Promise.resolve(false)
    authInflight = (async () => {
      const r = await safeExec(['auth', 'status'], cwd)
      authAt = now()
      return setStatus(r.status === 'ok' ? 'ok' : r.status === 'not-found' ? 'missing' : 'logged-out')
    })().finally(() => {
      authInflight = undefined
    })
    return authInflight
  }

  /** Runs one gh read for an entry and keeps what `parse` makes of it; `undefined` keeps the last value. */
  const fetchInto = async (
    args: string[],
    repoPath: string,
    entry: Entry,
    parse: (stdout: string, at: number) => PrStatus | undefined,
  ): Promise<boolean> => {
    const r = await safeExec(args, repoPath)
    const at = now()
    entry.fetchedAt = at
    if (r.status === 'not-found') return setStatus('missing')
    if (r.status !== 'ok') return false
    const next = parse(r.stdout, at)
    if (!next) return false
    const prev = entry.value
    entry.value = next
    return !prev || prev.number !== next.number || prev.state !== next.state || prev.checks !== next.checks || prev.url !== next.url
  }

  /**
   * Fetches an entry when it's due: not final, and not fetched in the last PR_CACHE_MS. By number,
   * merged and closed are final. By branch, only merged is: a closed PR can be reopened, or a new PR
   * opened on the same branch, while the run lasts.
   */
  const refreshEntry = (key: string, fetch: (entry: Entry) => Promise<boolean>, isFinal: (pr: PrStatus) => boolean): Promise<boolean> => {
    let entry = cache.get(key)
    if (!entry) cache.set(key, (entry = {}))
    if (entry.inflight) return entry.inflight
    if (entry.value && isFinal(entry.value)) return Promise.resolve(false)
    if (entry.fetchedAt !== undefined && now() - entry.fetchedAt < PR_CACHE_MS) return Promise.resolve(false)
    const e = entry
    e.inflight = fetch(e).finally(() => {
      e.inflight = undefined
    })
    return e.inflight
  }

  const refreshPr = (repoPath: string, n: number) =>
    refreshEntry(
      keyOf(repoPath, n),
      (e) => fetchInto(['pr', 'view', String(n), '--json', PR_FIELDS], repoPath, e, (out, at) => parsePrView(out, n, at)),
      (pr) => pr.state !== 'open',
    )

  /** `reused`: a branch every plan merges through (staging), so even a merged PR on it is asked about again. */
  const refreshBranch = (repoPath: string, branch: string, reused = false) =>
    refreshEntry(
      branchKey(repoPath, branch),
      (e) =>
        fetchInto(['pr', 'list', '--head', branch, '--state', 'all', '--json', LIST_FIELDS, '--limit', '10'], repoPath, e, (out, at) =>
          parsePrList(out, branch, at),
        ),
      (pr) => !reused && pr.state === 'merged',
    )

  return {
    status: () => status,
    checkedAt: () => authAt,
    get: (repoPath, n) => cache.get(keyOf(repoPath, n))?.value,
    getBranch: (repoPath, branch) => cache.get(branchKey(repoPath, branch))?.value,
    forget(repoPath, n) {
      cache.delete(keyOf(repoPath, n))
      for (const [key, entry] of cache) {
        const pr = entry.value
        if (pr?.number === n && pr.branch !== undefined && key === branchKey(repoPath, pr.branch)) cache.delete(key)
      }
    },
    async refresh(repoPath, numbers, branches = [], staging = []) {
      let changed = await checkAuth(repoPath)
      if (status !== 'ok') return changed
      const wanted = [...new Set(numbers)].filter((n) => Number.isSafeInteger(n) && n > 0)
      const heads = [...new Set(branches)].filter((b) => BRANCH.test(b))
      const reused = [...new Set(staging)].filter((b) => BRANCH.test(b) && !heads.includes(b))
      const results = await Promise.all([
        ...wanted.map((n) => refreshPr(repoPath, n)),
        ...heads.map((b) => refreshBranch(repoPath, b)),
        ...reused.map((b) => refreshBranch(repoPath, b, true)),
      ])
      for (const r of results) changed ||= r
      return changed
    },
  }
}

const STATES: Record<string, PrStatus['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
// CheckRun conclusions and StatusContext states that mean the check failed.
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'])

/** Maps `gh pr view --json number,state,url,statusCheckRollup` output; `undefined` when it isn't usable. */
export function parsePrView(stdout: string, n: number, checkedAt: number): PrStatus | undefined {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return undefined
  }
  return prOf(data, n, checkedAt)
}

function prOf(data: unknown, n: number, checkedAt: number): PrStatus | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const state = typeof d.state === 'string' ? STATES[d.state] : undefined
  if (!state) return undefined
  const pr: PrStatus = { number: n, state, checks: rollupChecks(d.statusCheckRollup), checkedAt }
  if (typeof d.url === 'string' && d.url) pr.url = d.url
  if (typeof d.baseRefName === 'string' && d.baseRefName) pr.base = d.baseRefName
  const mergedAt = typeof d.mergedAt === 'string' ? Date.parse(d.mergedAt) : NaN
  if (Number.isFinite(mergedAt)) pr.mergedAt = mergedAt
  if (typeof d.title === 'string' && d.title) pr.title = d.title
  return pr
}

/**
 * Maps `gh pr list --head <branch> --json number,state,url,statusCheckRollup,headRefName,title` output to
 * the branch's PR, with `branch` set: the open one, else the newest. Entries for another head are
 * skipped. `undefined` when the output isn't a list or holds no usable entry (no PR yet).
 */
export function parsePrList(stdout: string, branch: string, checkedAt: number): PrStatus | undefined {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(data)) return undefined
  const prs: PrStatus[] = []
  for (const item of data) {
    const d = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (d.headRefName !== branch || typeof d.number !== 'number' || !Number.isSafeInteger(d.number) || d.number < 1) continue
    const pr = prOf(d, d.number, checkedAt)
    if (pr) prs.push(pr)
  }
  const pick = prs.find((p) => p.state === 'open') ?? prs.sort((a, b) => b.number - a.number)[0]
  return pick && { ...pick, branch }
}

/** The checks of a `statusCheckRollup`: any failed → fail, any not done → pending, none → none, else pass. */
export function rollupChecks(rollup: unknown): PrStatus['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const item of rollup) {
    const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (c.__typename === 'StatusContext' || (c.status === undefined && typeof c.state === 'string')) {
      const s = String(c.state)
      if (FAILED.has(s)) return 'fail'
      if (s !== 'SUCCESS') pending = true
    } else if (c.status !== 'COMPLETED') {
      pending = true
    } else if (FAILED.has(String(c.conclusion))) {
      return 'fail'
    }
  }
  return pending ? 'pending' : 'pass'
}
