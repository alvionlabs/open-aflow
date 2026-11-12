// The board's read of one pod dispatch prompt: sprint, slice, branch, plan, and
// round, plus a reviewer's kind and PR, read only from the prompt's fields (a name
// that starts a line, a list item, or a `·`-separated part), plus the sprint
// planner's and reporter's plan prose. Pure.
// The rules and why are in pod-docs/feature-details/run-model.md.

import type { parseDispatch } from './pod-flow/model.ts'

/** The ported fields, plus a reviewer's `kind` (`plan` or `fix`) and PR number. */
export type DispatchFields = ReturnType<typeof parseDispatch> & { kind: string | undefined; pr: number | undefined }

/** A line's start: indent, then an optional list marker (`-`, `*`, `+`, `1.`, `1)`). */
const LINE_START = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?/

/** A field name, bold or not, an optional bracketed note, then a colon (inside or after the bold). */
const fieldHead = (name: string) => `(?:\\*\\*)?(?:${name})(?:[ \\t]*\\([^)\\n]*\\))?(?::\\*\\*|\\*\\*[ \\t]*:|[ \\t]*:)`

/** Any field name, so a `·` part counts only on a line that starts with a field. */
const ANY_FIELD = new RegExp(`^${fieldHead('[A-Za-z][\\w -]{0,40}?')}`)

/** Backtick spans blanked to spaces, so a quoted field never counts and offsets stay put. */
const blankCode = (line: string) => line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))

/** A fence line: indent, an optional list marker, 3+ backticks or tildes, then its info text. */
const FENCE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/

/**
 * The prompt's lines, each line of a fenced code block (``` or ~~~, fence lines too)
 * blanked, so a field in a quoted example never counts. A fence closes on a line of only
 * the same character, at least as many; an unclosed fence runs to the end, as in
 * CommonMark. A backtick fence whose info text holds a backtick is inline code, not a fence.
 */
function unfencedLines(prompt: string): string[] {
  let open: string | undefined
  return prompt.split(/\r?\n/).map((line) => {
    if (open !== undefined) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1]
      if (close !== undefined && close[0] === open[0] && close.length >= open.length) open = undefined
      return ''
    }
    const m = FENCE.exec(line)
    if (!m || (m[1]![0] === '`' && m[2]!.includes('`'))) return line
    open = m[1]!
    return ''
  })
}

const isSlash = (c: string | undefined) => c === '/' || c === '\\'

/** The two characters after a value make it a path: `/` or `\`, or a drive's `:` then one (`E:/`, `E:\`). */
const isPath = (next: string | undefined, after: string | undefined) => isSlash(next) || (next === ':' && isSlash(after))

/** A sentence end (`.`, then space) before a capital letter: `… repo. Plan slug: x.` */
const SENTENCE = /\.[ \t]+(?=[A-Z*])/g

/**
 * Where on one line a field can start, in line order: the line itself (after its list
 * marker); when that starts with a field, each part after a ` · `; and each new sentence.
 * Each is outside backticks. `whole` marks a `**` that may open a whole bold field.
 */
function fieldStarts(line: string): { at: number; text: string; whole?: true }[] {
  const lead = LINE_START.exec(line)?.[0].length ?? 0
  const plain = blankCode(line)
  const starts: { at: number; text: string; whole?: true }[] = [{ at: lead, text: line.slice(lead) }]
  const skip = (i: number) => i + (/^[ \t]*/.exec(line.slice(i))?.[0].length ?? 0)
  if (ANY_FIELD.test(line.slice(lead))) {
    for (let i = plain.indexOf('·', lead); i >= 0; i = plain.indexOf('·', i + 1)) starts.push({ at: skip(i + 1), text: line.slice(skip(i + 1)) })
  }
  for (const m of plain.matchAll(SENTENCE)) starts.push({ at: m.index + m[0].length, text: line.slice(m.index + m[0].length) })
  for (let i = plain.indexOf('**'); i >= 0; i = plain.indexOf('**', i + 2)) starts.push({ at: i, text: line.slice(i), whole: true })
  return starts.sort((a, b) => a.at - b.at)
}

/**
 * The value of the first field `name` in the prompt, in document order. A field starts a
 * line, a list item, a `·` part, or a sentence (`slice code: D1`, `- **slice code:** D1`,
 * `**plan slug (= plan branch):** x`, `… · round: 2`, `… repo. Plan slug: x.`), or is one
 * whole bold span anywhere (`… — **round: 2**`). A trailing `.` drops; a value that's a
 * path gives nothing (see `isPath`), and that still ends the search for this name. A name mid-sentence or in backticks never counts, and
 * `merge-target branch` is not `branch`.
 */
function field(lines: string[], name: string): string | undefined {
  const head = new RegExp(`^${fieldHead(name)}[ \\t]*\`?([\\w.-]*)(.?)(.?)`, 'i')
  const whole = new RegExp(`^\\*\\*(?:${name})[ \\t]*:[ \\t]*\`?([\\w.-]+?)\\.?\`?\\*\\*`, 'i')
  for (const line of lines) {
    for (const start of fieldStarts(line)) {
      const m = (start.whole ? whole : head).exec(start.text)
      if (!m) continue
      const value = m[1]!.replace(/\.+$/, '')
      return value === '' || isPath(m[2], m[3]) ? undefined : value
    }
  }
  return undefined
}

/** A GitHub pull URL, optionally in backticks or angle brackets: its number. */
const PULL_URL = /^`?<?https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)(?![\w/])/i

/**
 * The PR number of the first `PR URL` or `PR` field, read where `field` reads a field
 * (not a whole bold span). A value that isn't a GitHub pull URL gives nothing, and that
 * still ends the search, as in `field`.
 */
function prField(lines: string[]): number | undefined {
  const head = new RegExp(`^${fieldHead('pr(?: url)?')}[ \\t]*`, 'i')
  for (const line of lines) {
    for (const start of fieldStarts(line)) {
      const m = start.whole ? null : head.exec(start.text)
      if (!m) continue
      const n = PULL_URL.exec(start.text.slice(m[0].length))?.[1]
      return n === undefined ? undefined : Number(n)
    }
  }
  return undefined
}

/** The prose sprint planners and reporters are dispatched with: "… sprint doc for plan `<slug>`", "… feature details for plan `<slug>` in …". */
const PLAN_PROSE = /\bfor plan `([\w.-]+)`/

const isType = (type: string, role: string) => new RegExp(`(^|:)${role}$`).test(type)

/** The roles whose plan pod names only in prose: the sprint planner, and the reporter at plan complete. */
const readsPlanProse = (type: string) => isType(type, 'sprint-planner') || isType(type, 'reporter')

/**
 * The dispatch fields of an agent of type `agentType`, each from its field only.
 * Fenced code blocks never count. Plan, the first source that gives a value: a `plan slug`
 * field, a `plan` field, then (sprint planners and reporters only) the exact prose form
 * ``for plan `<slug>` ``. A source that gives nothing (no field, or a path) never blocks
 * the next one. Branch: the `branch name` field, then a `branch` field, so a `Branch: …` sentence in a
 * /pod:task engineer's task text (which comes before `branch name`) never counts. Engineers get no plan.
 * Reviewers alone get `kind` and `pr`.
 */
export function readDispatch(prompt: string, agentType: string): DispatchFields {
  const lines = unfencedLines(prompt)
  const round = Number(field(lines, 'round'))
  const plan = isType(agentType, 'engineer')
    ? undefined
    : (field(lines, 'plan slug') ??
      field(lines, 'plan') ??
      (readsPlanProse(agentType) ? PLAN_PROSE.exec(lines.join('\n'))?.[1] : undefined))
  const reviewer = isType(agentType, 'reviewer')
  return {
    sprint: field(lines, 'sprint slug'),
    slice: field(lines, 'slice code'),
    branch: field(lines, 'branch name') ?? field(lines, 'branch'),
    plan,
    round: Number.isInteger(round) && round > 0 ? round : undefined,
    kind: reviewer ? field(lines, 'kind') : undefined,
    pr: reviewer ? prField(lines) : undefined,
  }
}
