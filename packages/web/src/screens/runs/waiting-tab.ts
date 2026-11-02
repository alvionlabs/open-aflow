// The Waiting tab's logic: which rows are open, and where the open answer form and merge confirm sit.
// Rows are kept by NextItem.key (stable across Boards), never by position. Pure; WaitingTab.tsx is the glue.

import type { AnswerState } from './answer-flow.ts'
import type { MergeState } from './merge-flow.ts'
import type { NextItem } from './next-step.ts'
import type { RunTarget } from './resume-flow.ts'
import { formAnchor, type WaitingRow } from './queue-view.ts'
import type { Chip, ChipClass } from './view.ts'
import { KIND_ORDER, type EntryKind } from './entry-kind.ts'

export const NOTHING_ELSE = 'Nothing else waits on you.'

/** `key` opened or closed; keys whose item left the list are dropped, and a key not in it never opens. */
export function toggleOpen(open: ReadonlySet<string>, key: string, keys: readonly string[]): Set<string> {
  const next = new Set([...open].filter((k) => keys.includes(k)))
  if (next.has(key)) next.delete(key)
  else if (keys.includes(key)) next.add(key)
  return next
}

/** The open keys whose item is still listed; the same set when none left, so state doesn't change. */
export function keepOpen(open: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  const kept = [...open].filter((k) => keys.includes(k))
  return kept.length === open.size ? open : new Set(kept)
}

/** An entry's route and date, on one line. */
export const rowMeta = (row: WaitingRow): string => [row.route, row.date].filter((x) => !!x).join(' · ')

/**
 * The key of the item the open answer form sits under; `end` once its entry left the list (the form
 * then shows after it, so a result is never lost); undefined while closed or for another repo.
 */
export function answerAnchor(s: AnswerState, items: NextItem[], repoId: string): string | undefined {
  const withEntry = items.filter((i): i is NextItem & { entry: WaitingRow } => i.entry !== undefined)
  // formAnchor matches by line, also an answered line that starts with the form's; map its row back to the item.
  const rowKey = formAnchor(s, withEntry.map((i) => i.entry), repoId)
  if (rowKey === undefined || rowKey === 'end') return rowKey
  return withEntry.find((i) => i.entry.key === rowKey)?.key ?? 'end'
}

/** The key of the PR item the open merge confirm sits under; `end` once the PR left; undefined while closed or for another repo. */
export function mergeAnchor(s: MergeState, items: NextItem[], repoId: string): string | undefined {
  if (s.kind === 'idle' || s.target.repoId !== repoId) return undefined
  const n = s.target.number
  return items.find((i) => i.action.kind === 'merge' && i.action.number === n)?.key ?? 'end'
}

/** The reply row last seen: kept so a Continue or Go result stays after the Board drops the reply. */
export type ReplySeen = { key: string; target: RunTarget }

/** The reply item in the list, as ReplySeen; undefined when there is none. */
export function replySeen(items: NextItem[]): ReplySeen | undefined {
  const r = items.find((i) => i.action.kind === 'reply')
  return r && r.action.kind === 'reply' ? { key: r.key, target: r.action.panel.target } : undefined
}

/** The reply row to keep mounted after its item left (its panel then shows only the last result), else undefined. */
export const replyGhost = (items: NextItem[], last: ReplySeen | undefined): ReplySeen | undefined =>
  last && !items.some((i) => i.key === last.key) ? last : undefined

const KIND_CLS: Record<EntryKind, ChipClass> = { now: 's-you', before: 's-you', decision: 's-run', other: 's-idle', someday: 's-idle' }

/** The row's kind as a status dot and word; a BLOCKED entry with no kind word reads `blocked`. */
export function kindChip(row: WaitingRow): Chip {
  if (row.kind === 'other' && row.chip.label === 'BLOCKED') return { cls: 's-bad', label: 'blocked' }
  return { cls: KIND_CLS[row.kind], label: row.kindLabel }
}

/**
 * A run of rows in the tab. `group:top` (blocked, merge, reply) has no header and is always open; each
 * pending kind and `group:info` (answered, or not yours to answer) have a header with a count.
 */
export type WaitGroup = { key: string; label?: string; items: NextItem[]; startsOpen: boolean }

const KIND_LABEL: Record<EntryKind, string> = { now: 'Now', decision: 'Decisions', before: 'Before a step', other: 'Other', someday: 'Someday' }
export const INFO_LABEL = 'No answer needed'

/** The items in groups, list order kept inside each; empty groups left out. */
export function waitGroups(items: NextItem[]): WaitGroup[] {
  const groups: WaitGroup[] = [{ key: 'group:top', items: items.filter((i) => i.tier !== 'pending' && i.tier !== 'info'), startsOpen: true }]
  for (const kind of KIND_ORDER) {
    const of = items.filter((i) => i.tier === 'pending' && (i.entry?.kind ?? 'other') === kind)
    groups.push({ key: `group:${kind}`, label: KIND_LABEL[kind], items: of, startsOpen: kind !== 'someday' })
  }
  groups.push({ key: 'group:info', label: INFO_LABEL, items: items.filter((i) => i.tier === 'info'), startsOpen: true })
  return groups.filter((g) => g.items.length > 0)
}

/**
 * Whether a group's rows show: its start state, flipped when its key is in `flipped` (kept with toggleOpen
 * and keepOpen, like the rows). A group holding an anchor (the open answer form or merge confirm) shows,
 * so an open form is never hidden.
 */
export function groupOpen(g: WaitGroup, flipped: ReadonlySet<string>, anchors: readonly (string | undefined)[]): boolean {
  if (g.items.some((i) => anchors.includes(i.key))) return true
  return g.startsOpen !== flipped.has(g.key)
}

/**
 * A header click: flips the group, except while it holds the open answer form or merge confirm (it shows
 * open whatever the state, so a flip there would close it under you once the form closes).
 */
export function toggleGroup(flipped: ReadonlySet<string>, g: WaitGroup, keys: readonly string[], anchors: readonly (string | undefined)[]): ReadonlySet<string> {
  if (g.items.some((i) => anchors.includes(i.key))) return flipped
  return toggleOpen(flipped, g.key, keys)
}

export const SHOW_MORE = 'Show more'
export const SHOW_LESS = 'Show less'

/**
 * The words under an entry's body: `Show more` while it is cut to two lines, `Show less` while open.
 * `clamped` is wouldClamp: whether the body is over two lines; a body that fits gets neither.
 */
export const moreLabel = (open: boolean, clamped: boolean): string | undefined => (!clamped ? undefined : open ? SHOW_LESS : SHOW_MORE)

/** Lines a closed body shows: `.wait-body.clamp` in tabs.css. */
export const CLAMP_LINES = 2

/**
 * Whether a body is (or, while open, would be) cut: its full text height is over CLAMP_LINES lines by more
 * than a pixel of rounding. The same rule open or closed, so a resize updates Show more and Show less alike.
 */
export function wouldClamp(scrollHeight: number, lineHeight: number): boolean {
  if (!(lineHeight > 0)) return false
  return scrollHeight > CLAMP_LINES * lineHeight + 1
}
