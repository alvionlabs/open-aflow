import { describe, expect, it } from 'vitest'
import { KIND_ORDER, entryKind, type EntryKindOf } from './entry-kind.ts'

// Real body openings from pod-docs/handoff-queue.md (2026-10-30), as plain text (no bold or code ticks).
const REAL: [body: string, want: EntryKindOf][] = [
  [
    "someday: fix branches that don't match <sprint>-w<N>-fix aren't counted in their wave's time and tokens.",
    { kind: 'someday', label: 'someday', text: "fix branches that don't match <sprint>-w<N>-fix aren't counted in their wave's time and tokens." },
  ],
  [
    'someday (pod side): the board reads a sprint planner\'s plan from the exact prose for plan <slug>.',
    { kind: 'someday', label: 'someday (pod side)', text: "the board reads a sprint planner's plan from the exact prose for plan <slug>." },
  ],
  [
    'someday (product choice): with the final PR merged but its hand-back entry still pending, the runs row reads final PR.',
    { kind: 'someday', label: 'someday (product choice)', text: 'with the final PR merged but its hand-back entry still pending, the runs row reads final PR.' },
  ],
  [
    "now (product choice): a fix run's title line is always its slug, not the engineer's task text.",
    { kind: 'now', label: 'now (product choice)', text: "a fix run's title line is always its slug, not the engineer's task text." },
  ],
  [
    "now (pod side): ytb-feed's prose-only fix reviewers (kind: fix. Review PR <url>, branch …) don't join their fix run.",
    { kind: 'now', label: 'now (pod side)', text: "ytb-feed's prose-only fix reviewers (kind: fix. Review PR <url>, branch …) don't join their fix run." },
  ],
  [
    'before you turn on Continue: run pnpm exec tsx scripts/resume-spike.ts from packages/server once on macOS.',
    { kind: 'before', label: 'before you turn on Continue', text: 'run pnpm exec tsx scripts/resume-spike.ts from packages/server once on macOS.' },
  ],
  [
    'before hosting: packages/server/src/repo-files.ts MD_FOLDERS reads every pod-docs/research/*.md in full (PR #57).',
    { kind: 'before', label: 'before hosting', text: 'packages/server/src/repo-files.ts MD_FOLDERS reads every pod-docs/research/*.md in full (PR #57).' },
  ],
  [
    'decision: resumed claude -p runs now get no CLAUDE* variables. Value in use: drop them all.',
    { kind: 'decision', label: 'decision', text: 'resumed claude -p runs now get no CLAUDE* variables. Value in use: drop them all.' },
  ],
  [
    'decision (wording): the Next step card text is the engineer\'s pick.',
    { kind: 'decision', label: 'decision (wording)', text: "the Next step card text is the engineer's pick." },
  ],
  // No kind word: the whole body, kind other.
  [
    'plan calm-dashboard complete — final PR https://github.com/iamphduc/pod-board/pull/54, review pass',
    { kind: 'other', label: 'other', text: 'plan calm-dashboard complete — final PR https://github.com/iamphduc/pod-board/pull/54, review pass' },
  ],
  [
    'gate 7 (plan-complete): plan calm-dashboard merged to pod-staging.',
    { kind: 'other', label: 'other', text: 'gate 7 (plan-complete): plan calm-dashboard merged to pod-staging.' },
  ],
  [
    'gate 1 (blocked-concern): L1 (new look) can\'t pass pnpm verify.',
    { kind: 'other', label: 'other', text: "gate 1 (blocked-concern): L1 (new look) can't pass pnpm verify." },
  ],
  ['Needs your decision: 2500 or 3000 games?', { kind: 'other', label: 'other', text: 'Needs your decision: 2500 or 3000 games?' }],
]

describe('entry kind', () => {
  it.each(REAL)('real body %#', (body, want) => {
    expect(entryKind(body)).toEqual(want)
  })

  it('needs the kind word, then a colon', () => {
    // A word that only starts like a kind, or a kind with no colon, is no kind.
    for (const body of ['Now that the wave merged, check it.', 'decision needed on the port', 'somedays it fails', 'nowhere: x', 'decisions: x', 'before: no target']) {
      expect(entryKind(body), body).toEqual({ kind: 'other', label: 'other', text: body })
    }
    // A before target is a short phrase: a sentence with a comma before its colon is no kind.
    const long = 'Before merging PR #3, check the cache: it is stale.'
    expect(entryKind(long).kind).toBe('other')
  })

  it('reads a capital and loose spaces, and labels the word in lowercase', () => {
    expect(entryKind('Someday:  trim the cache.')).toEqual({ kind: 'someday', label: 'someday', text: 'trim the cache.' })
    expect(entryKind('Decision : pick one.')).toEqual({ kind: 'decision', label: 'decision', text: 'pick one.' })
    expect(entryKind('Before Hosting: add TLS.')).toEqual({ kind: 'before', label: 'before Hosting', text: 'add TLS.' })
    expect(entryKind('NOW(pod side): x')).toEqual({ kind: 'now', label: 'now (pod side)', text: 'x' })
  })

  it('keeps the whole body when nothing follows the kind', () => {
    expect(entryKind('someday:')).toEqual({ kind: 'other', label: 'other', text: 'someday:' })
    expect(entryKind('')).toEqual({ kind: 'other', label: 'other', text: '' })
  })

  it('orders kinds most urgent first, someday last', () => {
    expect(KIND_ORDER).toEqual(['now', 'decision', 'before', 'other', 'someday'])
  })
})
