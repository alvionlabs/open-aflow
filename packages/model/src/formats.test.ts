import { describe, expect, test } from 'vitest'
import {
  SUPPORTED_DOCS_VERSION,
  docsVersion,
  needsYou,
  planExtras,
  planFacts,
  stagingBranch,
  prRef,
  sliceDeps,
} from './formats.ts'

const README = (versionLine: string) =>
  `# pod docs\n\n${versionLine}\n\nThis folder holds pod's plans, sprints, and queue.\n`

describe('docsVersion', () => {
  test('docsVersion reads version 2', () => {
    expect(SUPPORTED_DOCS_VERSION).toBe(2)
    expect(docsVersion(README('pod docs: 2'))).toEqual({ supported: true, version: 2 })
    expect(docsVersion('# pod docs\r\n\r\npod docs: 2\r\n\r\nMore text.\r\n')).toEqual({
      supported: true,
      version: 2,
    })
    expect(docsVersion(README('   pod docs: 2  '))).toEqual({ supported: true, version: 2 })
    expect(docsVersion(README('\tpod docs: 2\t'))).toEqual({ supported: true, version: 2 })
    // A file that starts with a byte-order mark and the version line.
    expect(docsVersion('﻿pod docs: 2\n')).toEqual({ supported: true, version: 2 })
    // The last line with no trailing newline.
    expect(docsVersion('# pod docs\n\npod docs: 2')).toEqual({ supported: true, version: 2 })
  })

  test('docsVersion rejects other versions', () => {
    expect(docsVersion(README('pod docs: 1'))).toEqual({ supported: false, version: 1 })
    expect(docsVersion(README('pod docs: 3'))).toEqual({ supported: false, version: 3 })
    expect(docsVersion(README('pod docs: 0'))).toEqual({ supported: false, version: 0 })
    expect(docsVersion(README('pod docs: 20'))).toEqual({ supported: false, version: 20 })
  })

  test('docsVersion with no version line', () => {
    const none = { supported: false, version: undefined }
    expect(docsVersion(undefined)).toEqual(none)
    expect(docsVersion('')).toEqual(none)
    expect(docsVersion('# pod docs\n\nNo version here.\n')).toEqual(none)
    expect(docsVersion(README('pod docs: two'))).toEqual(none)
    expect(docsVersion(README('pod docs: 2.0'))).toEqual(none)
    expect(docsVersion(README('pod docs: -2'))).toEqual(none)
    expect(docsVersion(README('pod docs:'))).toEqual(none)
    expect(docsVersion(README('pod docs: 2 (current)'))).toEqual(none)
    expect(
      docsVersion(
        README(
          'Keep the `pod docs:` line: pod reads it to know this folder\'s layout, and `/pod:init` updates it.',
        ),
      ),
    ).toEqual(none)
    expect(docsVersion(README('The README holds `pod docs: 2` as its version.'))).toEqual(none)
  })

  test('docsVersion first line wins', () => {
    expect(docsVersion('pod docs: 2\npod docs: 3\n')).toEqual({ supported: true, version: 2 })
    expect(docsVersion('pod docs: 3\npod docs: 2\n')).toEqual({ supported: false, version: 3 })
    // A line that isn't a version line doesn't stop the search.
    expect(docsVersion('pod docs: two\npod docs: 2\n')).toEqual({ supported: true, version: 2 })
    // A prose mention before the real line doesn't count.
    expect(
      docsVersion('Keep the `pod docs:` line.\npod docs: 2\n'),
    ).toEqual({ supported: true, version: 2 })
  })
})

describe('prRef', () => {
  test('prRef reads every cell form', () => {
    // Forms seen on real chess-web and ytb-feed boards.
    expect(prRef('#76', 'merged')).toEqual({ state: 'merged', number: 76 })
    expect(prRef('#76', 'pending')).toEqual({ state: 'open', number: 76 })
    expect(prRef('#70', 'done')).toEqual({ state: 'merged', number: 70 })
    expect(prRef('merged', 'done')).toEqual({ state: 'merged' })
    expect(prRef('merged', 'pending')).toEqual({ state: 'merged' })
    expect(prRef('https://github.com/iamphduc/chess-web/pull/52', 'done')).toEqual({
      state: 'merged',
      number: 52,
      url: 'https://github.com/iamphduc/chess-web/pull/52',
    })
    expect(prRef('https://github.com/iamphduc/chess-web/pull/12', 'in review')).toEqual({
      state: 'open',
      number: 12,
      url: 'https://github.com/iamphduc/chess-web/pull/12',
    })
    expect(
      prRef('[#225](https://github.com/iamphduc/ytb-feed/pull/225) merged', 'pending'),
    ).toEqual({
      state: 'merged',
      number: 225,
      url: 'https://github.com/iamphduc/ytb-feed/pull/225',
    })
    expect(prRef('[#1](https://github.com/iamphduc/pod-board/pull/1)', 'in progress')).toEqual({
      state: 'open',
      number: 1,
      url: 'https://github.com/iamphduc/pod-board/pull/1',
    })
    expect(prRef('skipped — verification failed', 'pending')).toEqual({ state: 'skipped' })
    expect(prRef('blocked', 'pending')).toEqual({ state: 'blocked' })
    // Surrounding spaces from the table cell and other cases.
    expect(prRef('  #9  ', ' Merged ')).toEqual({ state: 'merged', number: 9 })
    expect(prRef('Merged', 'pending')).toEqual({ state: 'merged' })
    expect(prRef('http://example.test/review/abc', 'pending')).toEqual({
      state: 'open',
      url: 'http://example.test/review/abc',
    })
    // A URL in angle brackets.
    expect(prRef('<https://github.com/o/r/pull/8>', 'pending')).toEqual({
      state: 'open',
      number: 8,
      url: 'https://github.com/o/r/pull/8',
    })
  })

  test('prRef order skipped then blocked then merged', () => {
    expect(prRef('skipped', 'done')).toEqual({ state: 'skipped' })
    expect(prRef('skipped, was merged', 'merged')).toEqual({ state: 'skipped' })
    expect(prRef('skipped blocked', 'pending')).toEqual({ state: 'skipped' })
    expect(prRef('blocked', 'done')).toEqual({ state: 'blocked' })
    expect(prRef('blocked after merged', 'merged')).toEqual({ state: 'blocked' })
    // number and url stay set on skipped, blocked, and merged.
    expect(prRef('#14 skipped', 'pending')).toEqual({ state: 'skipped', number: 14 })
    expect(prRef('[#15](https://github.com/o/r/pull/15) blocked', 'done')).toEqual({
      state: 'blocked',
      number: 15,
      url: 'https://github.com/o/r/pull/15',
    })
    // Words only count as whole words, outside the URL.
    expect(prRef('unmerged', 'pending')).toEqual({ state: 'unknown' })
    expect(prRef('https://github.com/o/merged-blocked-skipped/pull/3', 'pending')).toEqual({
      state: 'open',
      number: 3,
      url: 'https://github.com/o/merged-blocked-skipped/pull/3',
    })
  })

  test('prRef with no reference', () => {
    expect(prRef('—', 'done')).toEqual({ state: 'merged' })
    expect(prRef('—', 'merged')).toEqual({ state: 'merged' })
    expect(prRef('—', 'pending')).toEqual({ state: 'none' })
    expect(prRef('-', 'pending')).toEqual({ state: 'none' })
    expect(prRef('', 'pending')).toEqual({ state: 'none' })
    expect(prRef('   ', 'in progress')).toEqual({ state: 'none' })
    expect(prRef('', 'done')).toEqual({ state: 'merged' })
    expect(prRef('soon', 'pending')).toEqual({ state: 'unknown' })
    expect(prRef('soon', 'done')).toEqual({ state: 'merged' })
    // A status that only contains "done" isn't done.
    expect(prRef('—', 'undone')).toEqual({ state: 'none' })
  })
})

describe('sliceDeps', () => {
  test('sliceDeps', () => {
    expect(sliceDeps('H1, C1, M1')).toEqual(['H1', 'C1', 'M1'])
    expect(sliceDeps('`A1`')).toEqual(['A1'])
    expect(sliceDeps('`P1`, `F1`, `X1`')).toEqual(['P1', 'F1', 'X1'])
    expect(sliceDeps('B1')).toEqual(['B1'])
    expect(sliceDeps(' L1 ,G1,  C1 ')).toEqual(['L1', 'G1', 'C1'])
    expect(sliceDeps('—')).toEqual([])
    expect(sliceDeps(' — ')).toEqual([])
    expect(sliceDeps('-')).toEqual([])
    expect(sliceDeps('none')).toEqual([])
    expect(sliceDeps('None')).toEqual([])
    expect(sliceDeps('NONE')).toEqual([])
    expect(sliceDeps('')).toEqual([])
    expect(sliceDeps('   ')).toEqual([])
    // A stray comma leaves no empty code.
    expect(sliceDeps('A1, ,B1,')).toEqual(['A1', 'B1'])
    // A repeated code is listed once.
    expect(sliceDeps('A1, A1')).toEqual(['A1'])
  })
})

describe('needsYou', () => {
  const entry = (type: string, route: string, isPending = true) => ({ type, route, isPending })

  test('needsYou', () => {
    expect(needsYou(entry('BLOCKED', 'engineer → orchestrator'))).toBe(true)
    expect(needsYou(entry('BLOCKED', 'engineer -> orchestrator'))).toBe(true)
    expect(needsYou(entry('PENDING', 'engineer → human'))).toBe(true)
    expect(needsYou(entry('PENDING', 'orchestrator -> human'))).toBe(true)
    expect(needsYou(entry('PENDING', 'engineer→human'))).toBe(true)
    expect(needsYou(entry('PENDING', 'engineer → Human '))).toBe(true)
    expect(needsYou(entry('NOTE', 'reporter → human'))).toBe(true)
    expect(needsYou(entry('blocked', 'engineer → orchestrator'))).toBe(true)

    // Resolved never needs you.
    expect(needsYou(entry('BLOCKED', 'engineer → orchestrator', false))).toBe(false)
    expect(needsYou(entry('PENDING', 'engineer → human', false))).toBe(false)
    // SOLVED never needs you.
    expect(needsYou(entry('SOLVED', 'engineer → human'))).toBe(false)
    expect(needsYou(entry('solved', 'engineer → human'))).toBe(false)
    // Pending, not for the human.
    expect(needsYou(entry('PENDING', 'engineer → orchestrator'))).toBe(false)
    expect(needsYou(entry('PENDING', 'engineer -> orchestrator'))).toBe(false)
    // "human" as the sender, not the target.
    expect(needsYou(entry('PENDING', 'human → orchestrator'))).toBe(false)
    // A target that only contains "human".
    expect(needsYou(entry('PENDING', 'engineer → humane'))).toBe(false)
    // No arrow, no target.
    expect(needsYou(entry('PENDING', 'human'))).toBe(false)
    expect(needsYou(entry('PENDING', ''))).toBe(false)
  })
})

describe('planExtras', () => {
  const plan = (extra: string) =>
    `# Plan: Board read\n\n_Slug: board-read · Status: active_\n${extra}\n## Goal\n\nShow every run.\n`

  test('planExtras', () => {
    expect(planExtras(plan('Port base: 3000\n'))).toEqual({ portBase: 3000, go: 'unknown' })
    expect(planExtras(plan('  Port base: 3100  \r\n'))).toEqual({ portBase: 3100, go: 'unknown' })
    expect(planExtras(plan(''))).toEqual({ go: 'unknown' })
    expect(planExtras(plan(''))).not.toHaveProperty('portBase')
    expect(planExtras(plan('Port base: tbd\n'))).toEqual({ go: 'unknown' })
    expect(planExtras(plan('Port base: tbd\n'))).not.toHaveProperty('portBase')
    expect(planExtras(plan('Port base: 3000.5\n'))).toEqual({ go: 'unknown' })
    expect(planExtras(plan('Port base:\n'))).toEqual({ go: 'unknown' })
    expect(planExtras('')).toEqual({ go: 'unknown' })
    // A prose mention isn't the line.
    expect(planExtras(plan('Reuse the plan doc\'s `Port base: 3000` line.\n'))).toEqual({
      go: 'unknown',
    })
    // A port outside 1 to 65535 isn't a port.
    expect(planExtras(plan('Port base: 0\n'))).toEqual({ go: 'unknown' })
    expect(planExtras(plan('Port base: 70000\n'))).toEqual({ go: 'unknown' })
    // The first line wins.
    expect(planExtras(plan('Port base: 3200\nPort base: 3300\n'))).toEqual({
      portBase: 3200,
      go: 'unknown',
    })
    // go stays unknown whatever the doc says.
    expect(planExtras(plan('go: yes\nGo: 2026-10-18\n')).go).toBe('unknown')
  })
})

describe('planFacts', () => {
  const plan = (meta: string, body = '') => `# Plan: Board read\n\n_Generated: 2026-10-17 · Status: active${meta}_\n\n## Goal\n\nShow every run.\n${body}`

  test('grilled-with', () => {
    expect(planFacts(plan(' · Grilled-with: grilling (fast)')).grilledWith).toBe('grilling (fast)')
    expect(planFacts(plan(' · Grilled-with: grill-me · Port: 3')).grilledWith).toBe('grill-me')
    // No value, or no field: not recorded.
    expect(planFacts(plan(' · Grilled-with: ')).grilledWith).toBeUndefined()
    expect(planFacts(plan(''))).not.toHaveProperty('grilledWith')
    // A prose mention isn't the field.
    expect(planFacts(plan('', '\nWe never wrote `Grilled-with:` here.\n'))).not.toHaveProperty('grilledWith')
  })

  test('look', () => {
    // No Look section: not set at all.
    expect(planFacts(plan(''))).not.toHaveProperty('look')
    // An empty section proves nothing.
    expect(planFacts(plan('', '\n## Look\n\n## Key decisions\n\nx\n')).look).toEqual({ kind: 'empty' })
    // A section that says there is no UI.
    expect(planFacts(plan('', '\n## Look\nNone: no UI change.\n')).look).toEqual({ kind: 'none' })
    expect(planFacts(plan('', '\n## Look\n\nNo UI in this plan.\n')).look).toEqual({ kind: 'none' })
    expect(planFacts(plan('', '\n## Look\nN/A\n')).look).toEqual({ kind: 'none' })
    // A picked direction, by letter or number, stops at the section's end.
    expect(planFacts(plan('', '\n## Look\nThe human picked direction C, simplified.\n## Key decisions\ndirection D\n')).look).toEqual({ kind: 'set', direction: 'direction C' })
    expect(planFacts(plan('', '\n## Look\nDirection 2 won.\n')).look).toEqual({ kind: 'set', direction: 'direction 2' })
    // Text with no direction: set.
    expect(planFacts(plan('', '\n## Look\n- **Thesis:** a quiet page.\n')).look).toEqual({ kind: 'set' })
    // A `## Look` inside a code fence isn't the section.
    expect(planFacts(plan('', '\n```\n## Look\ndirection A\n```\n'))).not.toHaveProperty('look')
  })

  test('generated date', () => {
    // The metadata line's `Generated:` date, as written (no time zone shift).
    expect(planFacts(plan('')).generated).toBe('2026-10-17')
    expect(planFacts('# Plan: P\n\n_Status: active · Generated: 2025-01-05 · Grilled-with: x_\n').generated).toBe('2025-01-05')
    // Not a date, a prose mention, a code fence, or a date that doesn't exist: not recorded.
    expect(planFacts('# Plan: P\n\n_Generated: soon · Status: active_\n')).not.toHaveProperty('generated')
    expect(planFacts("# Plan: P\n\nThe Generated: 2026-10-17 field is pod's.\n")).not.toHaveProperty('generated')
    expect(planFacts('# Plan: P\n\n```\n_Generated: 2026-10-17 · Status: active_\n```\n')).not.toHaveProperty('generated')
    expect(planFacts('# Plan: P\n\n_Generated: 2026-13-45 · Status: active_\n')).not.toHaveProperty('generated')
    expect(planFacts('# Plan: P\n\n_Generated: 2026-02-30 · Status: active_\n')).not.toHaveProperty('generated')
  })

  test('autopilot started stamp', () => {
    const withStamp = (line: string) => planFacts(`# Plan: P\n\n_Generated: 2026-10-17 · Status: active_\n${line}\n\n## Goal\n`)
    expect(withStamp('<!-- autopilot-run: started=2026-10-18T10:31:18Z sprints=0 waves=3 -->').autopilotStartedAt).toBe(Date.UTC(2026, 9, 18, 10, 31, 18))
    // An offset counts.
    expect(withStamp('<!-- autopilot-run: started=2026-10-09T17:30:00+07:00 sprints=1 waves=2 -->').autopilotStartedAt).toBe(Date.UTC(2026, 9, 9, 10, 30))
    // Extra text after the fields is fine.
    expect(withStamp('<!-- autopilot-run: started=2026-06-04T19:01:08Z sprints=6 waves=15 · COMPLETE 2026-06-05 -->').autopilotStartedAt).toBe(Date.UTC(2026, 5, 4, 19, 1, 8))
    // No stamp, no started field, or a value that isn't a full time: not recorded.
    expect(withStamp('')).not.toHaveProperty('autopilotStartedAt')
    expect(withStamp('<!-- autopilot-run: sprints=0 waves=3 -->')).not.toHaveProperty('autopilotStartedAt')
    expect(withStamp('<!-- autopilot-run: started=? -->')).not.toHaveProperty('autopilotStartedAt')
    expect(withStamp('<!-- autopilot-run: started=2026 -->')).not.toHaveProperty('autopilotStartedAt')
    expect(withStamp('<!-- autopilot-run: started=2026-10-18T25:00:00Z -->')).not.toHaveProperty('autopilotStartedAt')
    // Prose that quotes the marker isn't one.
    expect(withStamp('Autopilot keeps `<!-- autopilot-run: started=2026-10-18T10:31:18Z -->` here.')).not.toHaveProperty('autopilotStartedAt')
  })

  test('research links', () => {
    expect(planFacts(plan('', '\nSee [research](../research/folder-picker.md) and research/folder-picker.html, and pod-docs/research/live-feed.md.\n')).researchLinks).toEqual([
      'folder-picker',
      'live-feed',
    ])
    expect(planFacts(plan(''))).not.toHaveProperty('researchLinks')
  })
})

describe('stagingBranch', () => {
  const doc = (body: string) => `# Decisions\n\n${body}\n`
  test('stagingBranch', () => {
    // The decision's backticked staging branch.
    expect(stagingBranch(doc('## 2026-10-18 — merge target: staging\n\nDecision: autopilot merges land on `pod-staging`. The human moves them to `main`.\n'))).toBe('pod-staging')
    expect(stagingBranch(doc('## 2026-10-18 — Merge target: staging\n\nLand on `release-staging`.\n\n## Other\n`x-staging`\n'))).toBe('release-staging')
    // The decision with no branch named: pod's default.
    expect(stagingBranch(doc('## 2026-10-18 — merge target: staging\n\nWe use staging.\n'))).toBe('pod-staging')
    // A branch named only in a later section doesn't count.
    expect(stagingBranch(doc('## 2026-10-18 — merge target: staging\n\nYes.\n\n## Later\n`other-staging`\n'))).toBe('pod-staging')
    // No such decision, or no file.
    expect(stagingBranch(doc('## 2026-10-18 — merge target: main\n\n`pod-staging` is gone.\n'))).toBeUndefined()
    expect(stagingBranch(undefined)).toBeUndefined()
  })
})
