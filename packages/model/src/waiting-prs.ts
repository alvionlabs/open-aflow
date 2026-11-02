// PRs waiting on you: the one rule for which PRs the human merges from the board.
// The final PR (a pending hand-back), the staging → main PR once the final PR merged, a reviewed fix
// PR, and a wave handed back.
// Imports only pipeline.ts and fix-runs.ts, so runs.ts can use the same rules without a cycle.
// Pure. The rules and why are in pod-docs/feature-details/runs-and-pipeline.md.

import type { BoardRepo } from './board.ts'
import { fixWaitingPr, listedFixRuns } from './fix-runs.ts'
import { finalWaitingPr, isRun, stagingWaitingPr, waveWaitingPr } from './pipeline.ts'

/** `run` is the plan slug, or the fix claim name `fix-<slug>`. */
export type WaitingPr = { kind: 'wave' | 'fix' | 'final' | 'staging'; number: number; url?: string; run: string; sprint?: string; wave?: number }

/**
 * Every PR of the repo waiting on you to merge: for each listed plan in model order, its current
 * sprint's handed-back waves in wave order, then its final PR, then its staging branch's open PR to main
 * (several plans that share one staging branch each list it); then each listed fix run's reviewed
 * PR, in claim order. `url` only when gh knows it.
 */
export function waitingPrs(repo: BoardRepo, now: number): WaitingPr[] {
  const out: WaitingPr[] = []
  const add = (pr: WaitingPr) => {
    const url = repo.prs.find((p) => p.number === pr.number)?.url
    out.push(url === undefined ? pr : { ...pr, url })
  }
  for (const plan of repo.model.plans) {
    if (!isRun(repo, plan, now)) continue
    const sprint = plan.sprints.find((s) => s.slug === plan.currentSprint)
    for (const w of sprint?.waves ?? []) {
      const n = waveWaitingPr(repo, plan, sprint!, w, now)
      if (n !== undefined) add({ kind: 'wave', number: n, run: plan.slug, sprint: sprint!.slug, wave: w.wave })
    }
    const final = finalWaitingPr(repo, plan, now)
    if (final !== undefined) add({ kind: 'final', number: final, run: plan.slug })
    const staging = stagingWaitingPr(repo, plan, now)
    if (staging !== undefined) add({ kind: 'staging', number: staging, run: plan.slug })
  }
  for (const name of listedFixRuns(repo, now)) {
    const pr = fixWaitingPr(repo, name, now)
    if (pr) add({ kind: 'fix', number: pr.number, run: name })
  }
  return out
}
