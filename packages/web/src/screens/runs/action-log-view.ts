// The action log list under Other activity: the newest actions across every repo,
// each with its time, repo, target, and a result chip.

import type { ActionEntry } from '@pod-board/model'
import type { Chip, ChipClass } from './view.ts'

export const ACTION_LOG_CAP = 20
export const NO_ACTIONS = 'No actions yet.'

const OUTCOME_CLS: Record<ActionEntry['result'], ChipClass> = {
  merged: 's-ok',
  answered: 's-ok',
  closed: 's-ok',
  kept: 's-ok',
  started: 's-ok',
  queued: 's-run',
  'auto-merge': 's-run',
  stale: 's-you',
  unconfirmed: 's-you',
  changed: 's-you',
  failed: 's-bad',
}

/** merged, answered, closed, kept, and started → ok; queued and auto-merge → run; stale, unconfirmed, and changed → you; failed → bad. */
export const outcomeChip = (result: ActionEntry['result']): Chip => ({ cls: OUTCOME_CLS[result], label: result })

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** Local `HH:MM` on the same calendar day as `now`, else `MMM D HH:MM`. */
function when(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return today ? clock : `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock}`
}

/** `auto` marks a resume the automatic check sent; its `target` then ends in ` · auto`, so the list shows it. */
export type ActionLogRow = { key: string; time: string; repo: string; target: string; auto: boolean; chip: Chip }

const isAuto = (e: ActionEntry): boolean => e.action === 'resume' && e.auto

/** The newest ACTION_LOG_CAP entries, newest first. */
export function actionLogRows(entries: ActionEntry[] | undefined, now: number): ActionLogRow[] {
  return (entries ?? [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.at - a.e.at || a.i - b.i)
    .slice(0, ACTION_LOG_CAP)
    .map(({ e, i }) => ({
      key: `${e.at}-${e.repoId}-${e.target}-${i}`,
      time: when(e.at, now),
      repo: e.repo,
      target: isAuto(e) ? `${e.target} · auto` : e.target,
      auto: isAuto(e),
      chip: outcomeChip(e.result),
    }))
}
