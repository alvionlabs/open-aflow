// Readers for the small formats inside pod's docs: the docs version line, a
// status board's PR and Depends on cells, a queue entry's "needs you" rule,
// and the extra lines of a plan doc. Pure string functions: no I/O, and no
// import from the ported pod-flow parsers (the queue entry is typed by shape).

export const SUPPORTED_DOCS_VERSION = 2

export type DocsVersion =
  | { supported: true; version: 2 }
  | { supported: false; version: number | undefined }

export type PrRef = {
  state: 'none' | 'open' | 'merged' | 'skipped' | 'blocked' | 'unknown'
  number?: number
  url?: string
}

function lines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/)
}

/** The value of the first line that is exactly `<label> <integer>`, spaces around it allowed. */
function firstIntegerLine(text: string, label: string): number | undefined {
  for (const line of lines(text)) {
    const m = new RegExp(`^${label}[ \\t]+(\\d+)$`).exec(line.trim())
    if (m?.[1] !== undefined) return Number(m[1])
  }
  return undefined
}

/** The docs version from `pod-docs/README.md`: its first `pod docs: <N>` line. */
export function docsVersion(readme: string | undefined): DocsVersion {
  const version = readme === undefined ? undefined : firstIntegerLine(readme, 'pod docs:')
  return version === SUPPORTED_DOCS_VERSION
    ? { supported: true, version: SUPPORTED_DOCS_VERSION }
    : { supported: false, version }
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]]+/gi
const NO_REFERENCE = new Set(['', '—', '-'])
const DONE_STATUSES = new Set(['done', 'merged'])

/** A status board's PR cell, read with the slice's status. */
export function prRef(cell: string, sliceStatus: string): PrRef {
  const text = cell.trim()
  const url = text.match(URL_PATTERN)?.[0]
  // Words and `#N` count only outside links, so a repo or anchor named
  // "merged" in a URL doesn't change the state.
  const words = text.replace(URL_PATTERN, ' ')
  const pull = url === undefined ? undefined : /\/pull\/(\d+)/.exec(url)?.[1]
  const hash = /#(\d+)\b/.exec(words)?.[1]
  const digits = pull ?? hash
  const ref: Omit<PrRef, 'state'> = {}
  if (digits !== undefined) ref.number = Number(digits)
  if (url !== undefined) ref.url = url

  const has = (word: string) => new RegExp(`\\b${word}\\b`, 'i').test(words)
  const status = sliceStatus.trim().toLowerCase()
  if (has('skipped')) return { state: 'skipped', ...ref }
  if (has('blocked')) return { state: 'blocked', ...ref }
  if (has('merged') || DONE_STATUSES.has(status)) return { state: 'merged', ...ref }
  if (url !== undefined || hash !== undefined) return { state: 'open', ...ref }
  if (NO_REFERENCE.has(text)) return { state: 'none' }
  return { state: 'unknown' }
}

/** A status board's Depends on cell: slice codes, in order, each once. */
export function sliceDeps(cell: string): string[] {
  const text = cell.trim()
  if (NO_REFERENCE.has(text) || text.toLowerCase() === 'none') return []
  const codes = text.split(',').map((part) => part.replace(/[`\s]/g, ''))
  return [...new Set(codes.filter((code) => code !== ''))]
}

/** Whether a queue entry waits on the human. */
export function needsYou(entry: { type: string; route: string; isPending: boolean }): boolean {
  if (!entry.isPending) return false
  const type = entry.type.trim().toUpperCase()
  if (type === 'SOLVED') return false
  if (type === 'BLOCKED') return true
  const arrow = /(?:→|->)\s*(.*)$/.exec(entry.route)
  return arrow?.[1]?.trim().toLowerCase() === 'human'
}

/** The plan doc lines the board reads beyond `parsePlan`. */
export function planExtras(md: string): { portBase?: number; go: 'unknown' } {
  const portBase = firstIntegerLine(md, 'Port base:')
  // pod doesn't record `go` yet (decisions.md, 2026-10-18), so no format is guessed.
  return portBase !== undefined && portBase >= 1 && portBase <= 65535
    ? { portBase, go: 'unknown' }
    : { go: 'unknown' }
}

export type PlanLook = { kind: 'set' | 'none' | 'empty'; direction?: string }
/** What a plan doc records about the steps before its sprints; each field only when the doc shows it. */
/**
 * `generated`: the metadata line's `Generated:` date, `YYYY-MM-DD` as written. `autopilotStartedAt`: the
 * plan doc's `<!-- autopilot-run: started=<ISO time> … -->` stamp, in ms.
 */
export type PlanFacts = { grilledWith?: string; look?: PlanLook; researchLinks?: string[]; generated?: string; autopilotStartedAt?: number }

/** A `YYYY-MM-DD` that names a real day. */
function isDay(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d
}

/** A full ISO date and time with `Z` or an offset, in ms; undefined for anything else. */
function isoTime(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return undefined
  const at = Date.parse(text)
  return Number.isNaN(at) ? undefined : at
}

/** The doc's lines with fenced code blocks blanked, so an example never counts. */
function unfenced(md: string): string[] {
  let fence = false
  return lines(md).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      return ''
    }
    return fence ? '' : line
  })
}

/** The body of the first `## <title>` section, up to the next `## ` heading; undefined with no such section. */
function section(md: string, title: string): string | undefined {
  const all = unfenced(md)
  const start = all.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, 'i').test(l.trim()))
  if (start < 0) return undefined
  const rest = all.slice(start + 1)
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

const NO_UI = /^(?:none\b|n\/a\b|no ui\b|no visual\b)/i

/**
 * The plan doc's `Grilled-with:` value (from its metadata line, up to ` · ` or the closing `_`), its
 * `## Look` section read as set (with the picked `direction X` if it names one), none (it says no UI),
 * or empty, and the research reports it links (`research/<slug>.md` or `.html`), each once.
 */
export function planFacts(md: string): PlanFacts {
  const out: PlanFacts = {}
  const all = unfenced(md)
  const meta = all.find((l) => /^_.*\bGrilled-with:/.test(l.trim()))
  const grilled = meta && /\bGrilled-with:\s*([^·_]*)/.exec(meta)?.[1]?.trim()
  if (grilled) out.grilledWith = grilled
  // `Generated:` opens the line (`_Generated:`) or follows a space; `_` is a word character, so no `\b`.
  const GENERATED = /(?:^_|\s)Generated:\s*([^\s·_]+)/
  const dated = all.find((l) => l.trim().startsWith('_') && GENERATED.test(l.trim()))
  const generated = dated && GENERATED.exec(dated.trim())?.[1]
  if (generated && isDay(generated)) out.generated = generated
  const stamp = all.find((l) => /^[ \t]*<!--\s*autopilot-run(?![\w-])/i.test(l))
  const started = stamp && /\bstarted=(\S+)/.exec(stamp)?.[1]
  const startedAt = started ? isoTime(started) : undefined
  if (startedAt !== undefined) out.autopilotStartedAt = startedAt
  const look = section(md, 'Look')
  if (look !== undefined) {
    if (look === '') out.look = { kind: 'empty' }
    else if (NO_UI.test(look.replace(/^[-*\s]+/, ''))) out.look = { kind: 'none' }
    else {
      const d = /\bdirection\s+([A-Z]|\d+)\b/i.exec(look)?.[1]
      out.look = d === undefined ? { kind: 'set' } : { kind: 'set', direction: `direction ${d.toUpperCase()}` }
    }
  }
  const links = [...unfenced(md).join('\n').matchAll(/\bresearch\/([\w.-]+?)\.(?:md|html)\b/g)].map((m) => m[1]!)
  if (links.length > 0) out.researchLinks = [...new Set(links)]
  return out
}

/**
 * The staging branch from `pod-docs/decisions.md`: a `## … merge target: staging` decision names it in
 * backticks within its section (the first name holding `staging`), else pod's `pod-staging`. Undefined with no such decision.
 */
export function stagingBranch(decisions: string | undefined): string | undefined {
  if (decisions === undefined) return undefined
  const all = unfenced(decisions)
  const start = all.findIndex((l) => /^##\s.*\bmerge target:\s*staging\b/i.test(l.trim()))
  if (start < 0) return undefined
  const rest = all.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n')
  return /`([A-Za-z0-9][\w./-]*staging[\w./-]*)`/.exec(body)?.[1] ?? 'pod-staging'
}
