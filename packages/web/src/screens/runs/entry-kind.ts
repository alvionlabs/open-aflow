// The kind word a queue entry body starts with (`now:`, `decision:`, `before hosting:`, `someday (pod side):`),
// which says when the entry matters. Pure; queue-view.ts reads it, next-step.ts sorts by it.

export type EntryKind = 'now' | 'decision' | 'before' | 'other' | 'someday'

/** Most urgent first: the pending tier of the Waiting tab sorts and groups in this order. */
export const KIND_ORDER: readonly EntryKind[] = ['now', 'decision', 'before', 'other', 'someday']

/** `label` is what the row shows (`before hosting`, `someday (pod side)`); `text` is the body without the prefix. */
export type EntryKindOf = { kind: EntryKind; label: string; text: string }

/**
 * The kind word, an optional `(note)`, then a colon. `before` takes a short target with no punctuation
 * (`before hosting`, `before you turn on Continue`), so a sentence such as `Before merging PR #3, check: …`
 * is no kind. Case is ignored; the word is labelled in lowercase, the target and note as written.
 */
const KIND = /^(now|decision|someday|before)(?:\s+([^\s:(),.;][^:(),.;]{0,39}?))?\s*(?:\(([^()]{1,40})\))?\s*:\s*/i

/** The kind a body starts with; `other` with the whole body when it starts with none, or nothing follows it. */
export function entryKind(body: string): EntryKindOf {
  const none: EntryKindOf = { kind: 'other', label: 'other', text: body }
  const m = KIND.exec(body)
  if (!m) return none
  const word = m[1]!.toLowerCase() as Exclude<EntryKind, 'other'>
  const target = m[2]?.trim()
  // Only `before` names a target; `before` with none is no kind.
  if ((word === 'before') !== (target !== undefined)) return none
  const text = body.slice(m[0].length).trim()
  if (text === '') return none
  const note = m[3] === undefined ? '' : ` (${m[3].trim()})`
  return { kind: word, label: `${word}${target === undefined ? '' : ` ${target}`}${note}`, text }
}
