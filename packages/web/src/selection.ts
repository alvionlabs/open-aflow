// Which run and view the page shows, from the URL hash:
//   #/<repoId>                        a repo's plan-less run (idle, unsupported, or error)
//   #/<repoId>/<plan>                 a run's pipeline (screen 1)
//   #/<repoId>/<plan>/board           its wave board (screen 2)
//   #/<repoId>/<plan>/board/<code>    the board with slice <code> open (screen 3)
//   #/<repoId>/fix-<slug>             a fix run's pipeline and agent log (it has no wave board)
//   #/<repoId>/fix-<slug>/agent/<id>  the same, with that engineer's view open
// A hash that names no run falls back to the first run's pipeline; no runs means
// none, with an empty hash. `resolveSelection` also returns the hash that names what it picked, so the
// page can put it in the URL and a vanished run's hash doesn't come back to life.

import type { RunSummary } from '@pod-board/model'

/** How often live minutes recompute without a new Board. */
export const LIVE_TICK_MS = 30_000

export type View = 'pipeline' | 'board' | 'agent'
export type RouteKey = { repoId: string; plan?: string; view: View; slice?: string; agent?: string }

const enc = encodeURIComponent

/**
 * The hash for a run's view. A plan-less run only has its pipeline; a slice (`id`) only
 * opens on a plan's board; an agent (`id`) only opens on a fix run.
 */
export function hashFor(r: Pick<RunSummary, 'repoId' | 'plan' | 'fix'>, view: View = 'pipeline', id?: string): string {
  const base = `#/${enc(r.repoId)}`
  if (r.plan === undefined) return base
  const run = `${base}/${enc(r.plan)}`
  if (view === 'agent') return r.fix !== undefined && id !== undefined ? `${run}/agent/${enc(id)}` : run
  if (view !== 'board' || r.fix !== undefined) return run
  return id === undefined ? `${run}/board` : `${run}/board/${enc(id)}`
}

export function parseHash(hash: string): RouteKey | undefined {
  const m = /^#\/([^/]+)(?:\/([^/]+)(?:\/(board)(?:\/([^/]+))?|\/(agent)\/([^/]+))?)?$/.exec(hash)
  if (!m) return undefined
  try {
    const view: View = m[3] !== undefined ? 'board' : m[5] !== undefined ? 'agent' : 'pipeline'
    const key: RouteKey = { repoId: decodeURIComponent(m[1]!), view }
    if (m[2] !== undefined) key.plan = decodeURIComponent(m[2])
    if (m[4] !== undefined) key.slice = decodeURIComponent(m[4])
    if (m[6] !== undefined) key.agent = decodeURIComponent(m[6])
    return key
  } catch {
    return undefined
  }
}

export type Selection = { run: RunSummary | undefined; view: View; slice: string | undefined; agent?: string | undefined; hash: string | undefined }

/**
 * The run, view, and open slice or agent a hash names, corrected: an unknown run → the
 * `fallback` hash's run when it names one, else the first run's pipeline; a plan-less run → its pipeline; a fix run never gets the board, and
 * a plan run never the agent view; a slice that `slicesOf(run)` doesn't list → the board
 * with none open; an agent that `agentsOf(run)` doesn't list → the pipeline. Without
 * `slicesOf` or `agentsOf`, a slice or agent is kept as named.
 */
export function resolveSelection(
  runs: RunSummary[],
  hash: string,
  slicesOf?: (run: RunSummary) => string[],
  agentsOf?: (run: RunSummary) => string[],
  fallback?: string,
): Selection {
  const key = parseHash(hash)
  const named = key && runs.find((r) => r.repoId === key.repoId && r.plan === key.plan)
  // A run that vanished (its repo was just removed) goes to `fallback`, the run the remove planned, when it names one.
  const back = fallback === undefined ? undefined : parseHash(fallback)
  const run = named ?? (back && runs.find((r) => r.repoId === back.repoId && r.plan === back.plan)) ?? runs[0]
  // No runs: an empty hash, so a removed run's hash leaves the URL.
  if (!run) return { run: undefined, view: 'pipeline', slice: undefined, hash: '' }
  const fix = run.fix !== undefined
  const asked = named && key.view === 'agent' && fix ? key.agent : undefined
  const agent = asked !== undefined && (!agentsOf || agentsOf(run).includes(asked)) ? asked : undefined
  const board = named && key.view === 'board' && run.plan !== undefined && !fix
  const view: View = agent !== undefined ? 'agent' : board ? 'board' : 'pipeline'
  const wanted = view === 'board' ? key?.slice : undefined
  const slice = wanted !== undefined && (!slicesOf || slicesOf(run).includes(wanted)) ? wanted : undefined
  return { run, view, slice, agent, hash: hashFor(run, view, view === 'agent' ? agent : slice) }
}

/** Calls `onNow` with the time every `every` ms until the returned stop is called. */
export function startClock(onNow: (now: number) => void, every = LIVE_TICK_MS): () => void {
  const id = setInterval(() => onNow(Date.now()), every)
  return () => clearInterval(id)
}
