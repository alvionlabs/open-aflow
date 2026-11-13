import { describe, expect, it } from 'vitest'
import type { AgentRun, BoardRepo, Claim, PrStatus } from './board.ts'
import { forgetCheck } from './index.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 10, 12, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]

function planDoc(slug: string, sprints: SprintRow[], opts: { status?: string; extra?: string } = {}): string {
  return [
    `# Plan: ${slug}`,
    '',
    `_Generated: 2026-11-12 · Status: ${opts.status ?? 'active'} · Grilled-with: grilling_`,
    opts.extra ?? '',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, status]) => `| ${s} | goal | ${status} | — |`),
    '',
  ].join('\n')
}

function sprintDoc(slug: string, plan: string): string {
  return [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-11-12_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    `| 1 | A1 | Title A1 | ${slug}-A1 | [#3](https://github.com/o/r/pull/3) merged | done | medium | — |`,
    '',
  ].join('\n')
}

const queueLine = (type: string, route: string, fields: string, body: string) =>
  `- \`[2026-11-12 · ${type} · ${route} · ${fields}]\` ${body} **Resolution:** pending`

/** Plan `alpha`, its first sprint `one` with a doc. */
function planFiles(opts: { status?: string; sprints?: SprintRow[]; queue?: string[]; extra?: string } = {}): RepoFiles {
  const sprints = opts.sprints ?? [['one', 'active'], ['two', 'planned']]
  return {
    'pod-docs/README.md': README,
    'pod-docs/plans/alpha.md': planDoc('alpha', sprints, opts),
    'pod-docs/handoff-queue.md': (opts.queue ?? []).join('\n'),
    'pod-docs/sprints/one.md': sprintDoc('one', 'alpha'),
  }
}

const NO_PLANS: RepoFiles = { 'pod-docs/README.md': README }

const claim = (plan: string, portBase = 3100): Claim => ({ portBase, repoPath: '/r/web', plan })

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', tokens: 0, ended: false, ...over }
}
const span = (from: number, to: number) => ({ startedAt: NOW - from * MIN, lastAt: NOW - to * MIN })
const endedEngineer = () => agent({ branch: 'fix-scroll', ...span(120, 90), ended: true })
const endedReviewer = () => agent({ type: 'pod:reviewer', kind: 'fix', branch: 'fix-scroll', ...span(80, 70), ended: true })
const runningEngineer = () => agent({ branch: 'fix-scroll', ...span(10, 1) })
const mergedPr = (): PrStatus => ({ number: 7, state: 'merged', checks: 'pass', checkedAt: NOW, branch: 'fix-scroll', mergedAt: NOW - 60 * MIN })

function repo(extra: Partial<BoardRepo> = {}, files: RepoFiles = NO_PLANS): BoardRepo {
  return { id: 'id-web', name: 'web', path: '/r/web', source: 'both', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}

describe('forgetCheck', () => {
  it('leftover fix run can be forgotten', () => {
    const r = repo({ claims: [claim('fix-scroll', 3100)], agents: [endedEngineer(), endedReviewer()], prs: [mergedPr()] })
    expect(forgetCheck(r, 'fix-scroll', NOW)).toEqual({ ok: true, portBase: 3100 })
  })

  it('refusal reasons', () => {
    const leftover = { agents: [endedEngineer(), endedReviewer()], prs: [mergedPr()] }
    // 1. Not on the runs list: an unknown name, a claim that names no run, a repo that can't be read.
    expect(forgetCheck(repo({ claims: [claim('fix-scroll')], ...leftover }), 'fix-other', NOW)).toEqual({ ok: false, reason: 'not a run' })
    expect(forgetCheck(repo({ claims: [claim('somename')] }), 'somename', NOW)).toEqual({ ok: false, reason: 'not a run' })
    expect(forgetCheck(repo({ claims: [claim('fix-scroll')], error: 'folder not found' }), 'fix-scroll', NOW)).toEqual({ ok: false, reason: 'not a run' })
    // 2. Listed, but no claim names it: the plan's doc `Port base:` isn't a claim.
    const withPort = planFiles({ extra: 'Port base: 3100' })
    expect(forgetCheck(repo({}, withPort), 'alpha', NOW)).toEqual({ ok: false, reason: 'no claim' })
    // 3. Running wins over two claims.
    const twoClaims = [claim('fix-scroll', 3100), claim('fix-scroll', 3200)]
    expect(forgetCheck(repo({ claims: twoClaims, agents: [runningEngineer()] }), 'fix-scroll', NOW)).toEqual({ ok: false, reason: 'run is running' })
    // 4. Two claims: one delete would leave it listed.
    expect(forgetCheck(repo({ claims: twoClaims, ...leftover }), 'fix-scroll', NOW)).toEqual({ ok: false, reason: 'still listed' })
    // 4. A live plan mid-sprint stays listed with its claim taken out.
    expect(forgetCheck(repo({ claims: [claim('alpha', 3300)] }, planFiles()), 'alpha', NOW)).toEqual({ ok: false, reason: 'still listed' })
  })

  it('closing-out plan run', () => {
    // Archived, every sprint done, the hand-back pending, its PR merged: listed only by the claim, needs-you.
    const handBack = queueLine('PENDING', 'orchestrator → human', 'plan: alpha', 'plan alpha complete — final PR https://github.com/o/r/pull/12, review pass')
    const files = planFiles({ status: 'archived', sprints: [['one', 'done']], queue: [handBack] })
    const merged: PrStatus = { number: 12, state: 'merged', checks: 'pass', checkedAt: NOW }
    const r = repo({ claims: [claim('alpha', 3200)], prs: [merged] }, files)
    expect(forgetCheck(r, 'alpha', NOW)).toEqual({ ok: true, portBase: 3200 })
  })
})
