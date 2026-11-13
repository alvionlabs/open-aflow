// Forget run: whether one run's port claim may be deleted, and which one. Pure; the route
// (packages/server/src/forget-run-routes.ts) reads the file again and deletes it. The rules and why are in
// pod-docs/feature-details/actions.md.

import type { BoardRepo } from './board.ts'
import { listRuns } from './runs.ts'

export type ForgetRefusal = 'not a run' | 'no claim' | 'run is running' | 'still listed'

export type ForgetCheck = { ok: true; portBase: number } | { ok: false; reason: ForgetRefusal }

/** The repo's rows on the runs list that name `run`. */
const rowsOf = (repo: BoardRepo, run: string, now: number) =>
  listRuns({ generatedAt: now, gh: 'ok', repos: [repo] }, now).filter((r) => r.plan === run)

/**
 * Whether `run` of `repo` can be forgotten: listed on the runs list only through one port claim, and not running.
 * Checks, first failure wins: not on the runs list → `not a run`; no claim names it → `no claim`; its state is
 * `running` → `run is running`; two or more claims, or still listed without its claims → `still listed`.
 */
export function forgetCheck(repo: BoardRepo, run: string, now: number): ForgetCheck {
  const row = rowsOf(repo, run, now)[0]
  if (!row) return { ok: false, reason: 'not a run' }
  const claims = repo.claims.filter((c) => c.plan === run)
  if (claims.length === 0) return { ok: false, reason: 'no claim' }
  if (row.state === 'running') return { ok: false, reason: 'run is running' }
  if (claims.length > 1) return { ok: false, reason: 'still listed' }
  if (rowsOf({ ...repo, claims: repo.claims.filter((c) => c.plan !== run) }, run, now).length > 0) return { ok: false, reason: 'still listed' }
  return { ok: true, portBase: claims[0]!.portBase }
}
