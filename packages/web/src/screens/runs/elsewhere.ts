import type { Board, RunSummary } from '@pod-board/model'
import type { NextItem } from './next-step.ts'

export type Elsewhere = {
  run: RunSummary
  item: NextItem
  name: string
  repo?: string
  more: number
  href: string
}

export function elsewhere(_runs: RunSummary[], _board: Board | undefined, _selected: RunSummary | undefined, _now: number): Elsewhere | undefined {
  return undefined
}
