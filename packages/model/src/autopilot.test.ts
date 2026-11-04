import { describe, expect, it } from 'vitest'
import type { BoardRepo, PrStatus } from './board.ts'
import { buildPipeline, type Pipeline } from './pipeline.ts'
import { runReplies } from './replies.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'
import { listRuns } from './runs.ts'
import { waitingPrs } from './waiting-prs.ts'

// An autopilot run is marked by `<!-- autopilot-run: … -->` in the active sprint doc (the plan doc
// between sprints). Pod merges wave PRs itself then, so the board must not say `you merge`.
// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 9, 25, 12)
const MARKER = '<!-- autopilot-run: started=2026-10-25T08:50:32Z sprints=0 waves=1 -->'

type Row = [wave: number, code: string, pr: string, status: string]
type Opts = { sprints?: [string, string][]; rows?: Row[] | null; sprintMarker?: string; planMarker?: string; queue?: string[] }

const pr = (n: number) => `https://github.com/o/r/pull/${n}`

function files({ sprints = [['one', 'active']], rows = [[1, 'F1', pr(9), 'pushed']], sprintMarker, planMarker, queue = [] }: Opts): RepoFiles {
  const plan = [
    '# Plan: Alpha',
    '',
    '_Generated: 2026-10-25 · Status: active · Grilled-with: grilling_',
    ...(planMarker === undefined ? [] : [planMarker]),
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, st]) => `| ${s} | goal | ${st} | — |`),
    '',
  ].join('\n')
  const out: RepoFiles = { 'pod-docs/README.md': 'pod docs: 2\n', 'pod-docs/plans/alpha.md': plan, 'pod-docs/handoff-queue.md': queue.join('\n') }
  if (rows) {
    out['pod-docs/sprints/one.md'] = [
      '# Sprint: one',
      '',
      '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-10-25_',
      '',
      ...(sprintMarker === undefined ? [] : [sprintMarker, '']),
      '## Status board',
      '',
      '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
      '|------|-------|-------|--------|----|--------|------------|------------|',
      ...rows.map(([w, code, p, st]) => `| ${w} | ${code} | Title ${code} | one-${code} | ${p} | ${st} | medium | — |`),
      '',
    ].join('\n')
  }
  return out
}

const repo = (o: Opts, prs: PrStatus[] = []): BoardRepo => ({
  id: 'id-r',
  name: 'r',
  path: '/r',
  source: 'registered',
  model: buildRepoModel(files(o)),
  agents: [],
  prs,
  claims: [],
})

// The real halt from the pod-trial run, gate 3, with the PR link shortened.
const HALT = `- \`[2026-10-25 · BLOCKED · orchestrator → human · plan: alpha · sprint: one]\` gate 3 auto-merge-fail: wave PR ${pr(9)} has no passing CI; fix Actions billing, then resume \`/pod:autopilot\`. The local wave check passed. **Resolution:** pending`
const answered = (line: string) => line.replace('**Resolution:** pending', '**Resolution:** pending **Answer (human):** billing fixed')

const build = (r: BoardRepo): Pipeline => {
  const p = buildPipeline(r, 'alpha', NOW)
  if (!p) throw new Error('no pipeline')
  return p
}
const step = (p: Pipeline, key: string) => p.stages.flatMap((s) => s.steps).find((s) => s.key === key)

describe('autopilot marker', () => {
  const autopilot = (o: Opts) => buildRepoModel(files(o)).plans[0]?.autopilot

  it('the active sprint doc carries it', () => {
    expect(autopilot({ sprintMarker: MARKER })).toBe(true)
    // No marker anywhere: a /pod:code run, with no field at all.
    expect(buildRepoModel(files({})).plans[0]).not.toHaveProperty('autopilot')
  })

  it('between sprints, the plan doc carries it', () => {
    expect(autopilot({ sprints: [['one', 'planned']], rows: null, planMarker: MARKER })).toBe(true)
    expect(autopilot({ sprints: [['one', 'planned']], rows: null })).toBeUndefined()
  })

  it('a started sprint doc decides, not a marker left in the plan doc', () => {
    expect(autopilot({ planMarker: MARKER })).toBeUndefined()
  })

  it('tolerant parse: its presence counts, whatever its fields say', () => {
    for (const m of ['<!-- autopilot-run -->', '<!--autopilot-run: started=? -->', '  <!-- autopilot-run: sprints=x waves= -->', '<!-- AUTOPILOT-RUN: started=2026 -->']) {
      expect(autopilot({ sprintMarker: m }), m).toBe(true)
    }
    // Prose that only quotes the marker isn't one.
    expect(autopilot({ sprintMarker: 'Autopilot keeps `<!-- autopilot-run: … -->` here.' })).toBeUndefined()
    expect(autopilot({ sprintMarker: '<!-- autopilot-runs: x -->' })).toBeUndefined()
  })
})

describe('autopilot run, not halted', () => {
  const r = repo({ sprintMarker: MARKER })

  it('a waiting wave PR is autopilot’s to merge, not yours', () => {
    const wave = step(build(r), 'one/wave-1')
    // The run is running (pod merges the pushed PR), so the wave in progress reads running too.
    expect(wave).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: 'live', detail: 'PR #9 · autopilot merges' })
    expect(waitingPrs(r, NOW)).toEqual([])
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe('running')
  })

  it('no reply: autopilot never waits for continue between waves', () => {
    expect(runReplies(r, 'alpha', NOW)).toEqual([])
    // gh says the wave PR merged: autopilot moves on by itself.
    expect(runReplies(repo({ sprintMarker: MARKER }, [{ number: 9, state: 'merged', checks: 'pass', checkedAt: NOW }]), 'alpha', NOW)).toEqual([])
    // A done sprint with the next not drafted: autopilot drafts it by itself.
    const between = repo({ sprints: [['zero', 'done'], ['one', 'planned']], rows: null, planMarker: MARKER })
    expect(runReplies(between, 'alpha', NOW)).toEqual([])
  })

  it('no Go step: autopilot never records one', () => {
    const plan = build(r).stages.find((s) => s.key === 'plan')
    expect(plan?.steps.map((s) => s.key)).toEqual(['plan'])
  })
})

describe('autopilot run, halted', () => {
  const r = repo({ sprintMarker: MARKER, queue: [HALT] })

  it('the wave step says autopilot stopped and keeps Merge as an override', () => {
    expect(step(build(r), 'one/wave-1')).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: 'you', detail: 'PR #9 · autopilot stopped', merge: { number: 9 } })
    expect(waitingPrs(r, NOW)).toEqual([{ kind: 'wave', number: 9, run: 'alpha', sprint: 'one', wave: 1 }])
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe('blocked')
  })

  it('no wave-waiting reply; answering the halt gives the answered reply', () => {
    expect(runReplies(r, 'alpha', NOW)).toEqual([])
    const replies = runReplies(repo({ sprintMarker: MARKER, queue: [answered(HALT)] }), 'alpha', NOW)
    expect(replies.map((x) => x.signal)).toEqual(['answered'])
  })
})

describe('autopilot run, stopped at a PENDING gate', () => {
  // Gates 5, 6, and 7 halt with PENDING; gate 6 withholds a mergeable PR for the human to merge.
  const gate = (body: string) => `- \`[2026-10-25 · PENDING · orchestrator → human · plan: alpha · sprint: one]\` ${body} **Resolution:** pending`
  const GATE6 = gate(`gate 6 escalation-valve: wave PR ${pr(9)} withheld, slice F1 reported Confidence: low; merge it if you agree.`)
  const GATE5 = gate('gate 5 safety-bound: --max-waves=1 reached.')

  it('gate 6 and gate 5: the step says autopilot stopped and Merge is yours', () => {
    for (const entry of [GATE6, GATE5]) {
      const r = repo({ sprintMarker: MARKER, queue: [entry] })
      expect(step(build(r), 'one/wave-1'), entry).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: 'you', detail: 'PR #9 · autopilot stopped', merge: { number: 9 } })
      expect(waitingPrs(r, NOW)).toEqual([{ kind: 'wave', number: 9, run: 'alpha', sprint: 'one', wave: 1 }])
      // A PENDING halt isn't BLOCKED: the run needs you, it isn't blocked.
      expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe('needs-you')
      // No wave reply: answering the entry is what resumes it.
      expect(runReplies(r, 'alpha', NOW)).toEqual([])
    }
  })

  // Real PENDING · orchestrator → human bodies from pod queues and Queue logs (chess-web, sparring-liem,
  // watchless, pod-board, pod-trial), cut short; PR links point at #9. A halt starts with its gate
  // (skills/autopilot/policy.md: gates 1–7, by number or by name); a note that only mentions one is no stop.
  const STOPS: [string, string][] = [
    ['gate 5 by number and name', 'Gate 5 (safety-bound): `--max-runtime` (default 4h) hit — run started 2026-10-04T06:58:18Z, halted 22:56Z before dispatching wave 2 (`D1`).'],
    ['gate 6, capitalised', `Gate 6 (escalation-valve): wave PR ${pr(9)} is mergeable but withheld because F1 is a one-way door.`],
    ['gate 6 after Autopilot', `Autopilot gate 6 (escalation-valve): wave PR ${pr(9)} is mergeable (CI green, clean) but withheld because D1 is a one-way door (GPL-3.0-or-later \`LICENSE\`). Merge it with a merge commit (\`gh pr merge 9 --merge\`).`],
    ['gate 6 in bold', `**gate 6** (escalation-valve): wave 1 PR ${pr(9)} is a one-way door (schema 2; older builds refuse a migrated file). Merge it yourself with \`gh pr merge 9 --merge\`, then reply \`continue\`.`],
    ['gate 3 filed as PENDING', `gate 3 (auto-merge-fail): wave 1 PR ${pr(9)} is two-way but stacked on the unmerged #23–#27, so merging it would land them unreviewed. Merge it after #27.`],
    ['gate 7 by number', 'gate 7 (plan-complete): staging PR open; never merged by pod.'],
    ['safety-bound by name only', 'safety-bound: `--max-waves=1` reached before wave 2.'],
    ['escalation-valve by name only', `escalation-valve: wave PR ${pr(9)} withheld, F1 reported Confidence: low.`],
    ['plan-complete by name only, any case', 'PLAN-COMPLETE: no planned sprint left.'],
    ['gate 1 by name', 'blocked-concern: an engineer stalled twice on F1.'],
    ['gate 2 by name', 'plan-review-fail: the final review still finds FIX items.'],
    ['gate 4 by name, any case', 'Inter-Wave-Verify: the wave check failed on the merged board.'],
    ['leading whitespace', `   gate 6 (escalation-valve): wave PR ${pr(9)} withheld.`],
    ['gate without a space', 'gate6 (escalation-valve): withheld.'],
  ]
  const NOTES: [string, string][] = [
    ['now: note', "now: YouTube's plain channel RSS feed returns 404 in long bursts (measured for 6+ minutes across 4 channels), so some nights a channel's new videos may be missed."],
    ['someday: note', 'someday: `packages/server/src/claude-runner.test.ts › isRunning stays true while any child for the session lives` is flaky.'],
    ['Someday (Look) note', 'Someday (Look): on phones the review’s graph sits above the "vs Liem / Two players" tabs, so the tabs move.'],
    ['agent default', 'Default recorded: keep the old flag (agent default — override anytime).'],
    ['decision ask', 'Needs your decision: Lichess’s real grade levels are **5 / 10 / 15** win-% points, not the 10 / 20 / 30 the plan took.'],
    ['Look note in bold', '**Look:** at 375 px his name reads "Le Quang Li…" on the in-game Liem card.'],
    ['a gate name mid-sentence', 'someday: the plan-complete review should also re-run the e2e suite; kept going.'],
    ['a gate number mid-sentence', 'Runtime safety bound (gate 6) note: run clock reads ~12h at W2 dispatch, over the default `--max-runtime=4h`. NOT halted; continuing.'],
    ['the hand-back (the Ship step’s, not a wave stop)', 'plan alpha complete — final PR https://github.com/o/r/pull/12, review pass, 4 open entries.'],
    ['PLAN COMPLETE in words', '**PLAN COMPLETE — `alpha`.** All sprints done. Plan-complete gate (gate 9): no `planned` rows remain.'],
    ['gate 50', 'gate 50 notes: see the wave log.'],
    ['gate 8', 'gate 8: no such gate.'],
    ['gate 0', 'gate 0: no such gate.'],
    ['regate 5', 'regate 5 after the fix.'],
    ['a gate name glued to a word', 'safety-bounded: the run stayed under every bound.'],
  ]
  const stopOf = (body: string) => step(build(repo({ sprintMarker: MARKER, queue: [gate(body)] })), 'one/wave-1')

  it.each(STOPS)('stops autopilot: %s', (_, body) => {
    const r = repo({ sprintMarker: MARKER, queue: [gate(body)] })
    expect(stopOf(body)).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: 'you', detail: 'PR #9 · autopilot stopped', merge: { number: 9 } })
    expect(waitingPrs(r, NOW)).toEqual([{ kind: 'wave', number: 9, run: 'alpha', sprint: 'one', wave: 1 }])
    // A PENDING stop reads needs-you, never blocked: isHalted is for BLOCKED only.
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe('needs-you')
  })

  it.each(NOTES)('is no stop: %s', (_, body) => {
    const r = repo({ sprintMarker: MARKER, queue: [gate(body)] })
    // Pod still merges the PR, so its wave reads running. A note leaves the run running too; a plan-complete
    // hand-back is no wave stop, but it stops the run (`stopsRun`), and that reads first on the wave.
    const handBack = /complete/i.test(body) && /^\W*plan\b/i.test(body)
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe(handBack ? 'needs-you' : 'running')
    expect(stopOf(body)).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: handBack ? 'you' : 'live', detail: 'PR #9 · autopilot merges' })
    // No wave PR waits on you (the hand-back case still lists its final PR, the Ship step's own rule).
    expect(waitingPrs(r, NOW).filter((w) => w.kind === 'wave')).toEqual([])
  })

  it('a BLOCKED from the orchestrator stops it whatever its body says', () => {
    const blocked = `- \`[2026-10-25 · BLOCKED · orchestrator → human · plan: alpha · sprint: one]\` someday: the plan-complete review should re-run e2e. **Resolution:** pending`
    const r = repo({ sprintMarker: MARKER, queue: [blocked] })
    expect(step(build(r), 'one/wave-1')?.detail).toBe('PR #9 · autopilot stopped')
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe('blocked')
  })

  it('only a pending entry from the orchestrator to you stops it', () => {
    const others = [
      GATE6.replace('**Resolution:** pending', '**Resolution:** 2026-10-25 — merged by hand'),
      '- `[2026-10-25 · PENDING · reviewer → human · plan: alpha]` someday: keep the old flag? **Resolution:** pending',
      '- `[2026-10-25 · PENDING · orchestrator → engineer · plan: alpha · sprint: one]` re-run the check **Resolution:** pending',
    ]
    for (const entry of others) {
      const r = repo({ sprintMarker: MARKER, queue: [entry] })
      expect(step(build(r), 'one/wave-1')?.detail, entry).toBe('PR #9 · autopilot merges')
      expect(waitingPrs(r, NOW), entry).toEqual([])
    }
  })
})

describe('a /pod:code run (no marker) is unchanged', () => {
  it('reads you merge, with Merge, the wave-waiting reply, and the Go step', () => {
    const r = repo({})
    const p = build(r)
    expect(step(p, 'one/wave-1')).toEqual({ key: 'one/wave-1', label: 'Wave 1', state: 'you', detail: 'PR #9 · you merge', merge: { number: 9 } })
    expect(step(p, 'go')).toEqual({ key: 'go', label: 'Go', state: 'unknown', detail: 'not recorded yet' })
    expect(runReplies(r, 'alpha', NOW).map((x) => x.signal)).toEqual(['wave-waiting'])
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW)[0]?.state).toBe('needs-you')
  })
})
