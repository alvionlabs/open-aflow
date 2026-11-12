import { describe, expect, it } from 'vitest'
import type { BoardRepo } from './board.ts'
import { buildPipeline, listRuns, parseAgentTranscript, readDispatch, roleOf } from './index.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'

// Prompts and transcripts are built inline in the shape real pod dispatches use:
// test/no-io.test.ts scans this folder, so no file reads here.

const REVIEWER = [
  'Dispatched by /pod:autopilot to review the final PR of plan alpha.',
  '',
  '- **kind:** plan',
  '- **PR URL:** https://github.com/o/r/pull/15',
  '- **merge-target:** alpha',
  '- **plan:** alpha',
  '- **parent-repo path:** /r',
  '- **worktree path:** /r/.claude/worktrees/alpha-review',
  '- **dev ports:** 3010 / 3011',
  '- **browser:** agent-browser',
  '- **round:** 1',
].join('\n')

// A round-2 reviewer: the fix summary it quotes names fields in prose, before and after the real list.
const REVIEWER_ROUND_2 = [
  'Dispatched by /pod:autopilot for round 2 of the final review of plan alpha.',
  '',
  'The fix pass made `readDispatch` read a `plan slug:` field, a `- **plan:**` list field, then',
  'the planner prose. Earlier rounds quoted `round: 1` and `slice code: Z9`.',
  '',
  '- **kind:** plan',
  '- **merge-target:** alpha',
  '- **plan:** alpha',
  '- **round:** 2',
  '',
  'Context: the summary also said the plan slug: field wins.',
].join('\n')

// A plan fix engineer: list fields for where it works, and pasted findings that name fields in prose.
const FIX_ENGINEER = [
  'Dispatched by /pod:autopilot after a gate 2 halt. Findings quote `sprint slug: other`,',
  '`slice code: Z9`, `branch name: wrong-branch`, `round: 3`, and a plan slug: label. in prose.',
  '',
  '- **sprint slug:** one',
  '- **slice code:** plan-fix',
  '- **branch name:** alpha-fix (cut from origin/alpha)',
  '- **merge-target branch:** alpha',
].join('\n')

const PLANNER = 'Draft the next sprint doc for plan `alpha`. Read pod-docs/plans/alpha.md first.'

const ENGINEER = [
  '- **sprint slug:** one',
  '- **slice code:** A1',
  '- **branch name:** one-A1',
  '- **merge-target branch:** alpha',
  '',
  'Context: the sprint planner was told to draft the next sprint doc for plan `beta`.',
].join('\n')

// The reporter's "Plan complete" shape from /pod:code: the slug only in ``for plan `<slug>` `` prose,
// and a `Plan:` item that is a path, so it gives nothing.
const REPORTER = [
  'Plan complete: write the plan report and feature details for plan `alpha` in /r.',
  '- Plan: pod-docs/plans/alpha.md (one sprint, `one`, archived at pod-docs/sprints/archive/one.md).',
  '- Final PR: https://github.com/o/r/pull/9 (`alpha` → `main`), reviewer verdict `pass` on round 1.',
  '- Merge-target: main.',
].join('\n')

describe('readDispatch', () => {
  it('reads the plan and round from a reviewer dispatch', () => {
    expect(readDispatch(REVIEWER, 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: 1 })
  })

  it('reads the plan from a sprint planner prompt', () => {
    expect(readDispatch(PLANNER, 'pod:sprint-planner').plan).toBe('alpha')
  })

  it('reads the planner prose only for sprint planners and reporters, not engineers or reviewers', () => {
    expect(readDispatch(ENGINEER, 'pod:engineer')).toMatchObject({ plan: undefined, sprint: 'one', slice: 'A1', branch: 'one-A1' })
    expect(readDispatch(PLANNER, 'pod:reviewer').plan).toBeUndefined()
  })

  it('reads the plan from a reporter prompt that names it only in prose', () => {
    expect(readDispatch(REPORTER, 'pod:reporter').plan).toBe('alpha')
  })

  it('reads the reporter prose for reporters only, not engineers, reviewers, or other roles', () => {
    for (const type of ['pod:engineer', 'pod:reviewer', 'pod:researcher', 'pod:scout']) {
      expect(readDispatch(REPORTER, type).plan, type).toBeUndefined()
    }
  })

  it("keeps a reporter's plan slug field ahead of its prose", () => {
    const prompt = '- **plan slug:** gamma\n\nWrite the report for plan `alpha`.'
    expect(readDispatch(prompt, 'pod:reporter').plan).toBe('gamma')
  })

  it("never reads a reporter's prose from a fenced block", () => {
    expect(readDispatch('```\nWrite the report for plan `alpha`.\n```', 'pod:reporter').plan).toBeUndefined()
  })

  it('keeps a plan slug field first', () => {
    expect(readDispatch('- **plan slug:** gamma\n- **plan:** alpha', 'pod:reviewer').plan).toBe('gamma')
  })

  it('reads the plan field only as a list field, not a word in prose or a queue line', () => {
    expect(readDispatch('Fix the plan: alpha is late.', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('`[2026-10-18 · PENDING · engineer → human · plan: alpha]` text', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('Plan `alpha` is next; see the plan `beta` doc.', 'pod:sprint-planner').plan).toBeUndefined()
  })

  it('a plan list field beats a plan slug quoted in prose', () => {
    expect(readDispatch(REVIEWER_ROUND_2, 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: 2 })
  })

  it('a plan slug counts only as a list field, never from prose', () => {
    expect(readDispatch('Read the plan slug: alpha from the doc.', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('- **plan slug:** gamma', 'pod:reviewer').plan).toBe('gamma')
  })

  it('a fix engineer keeps its list fields and gets no plan from prose', () => {
    const d = readDispatch(FIX_ENGINEER, 'pod:engineer')
    expect(d).toEqual({ sprint: 'one', slice: 'plan-fix', branch: 'alpha-fix', plan: undefined, round: undefined })
  })

  it('a field quoted in prose never beats the real list field', () => {
    const prose = 'Quoted: sprint slug: other, slice code: Z9, branch name: wrong, round: 7.\n'
    const list = '- **sprint slug:** one\n- **slice code:** A1\n- **branch name:** one-A1\n- **round:** 2\n'
    expect(readDispatch(prose + list, 'pod:reviewer')).toMatchObject({ sprint: 'one', slice: 'A1', branch: 'one-A1', round: 2 })
  })

  it('reads no field from prose alone', () => {
    const prose = 'Quoted: sprint slug: other, slice code: Z9, branch name: wrong, round: 7, plan: x.'
    expect(readDispatch(prose, 'pod:engineer')).toEqual({ sprint: undefined, slice: undefined, branch: undefined, plan: undefined, round: undefined })
  })

  it('a merge-target branch list field is not the branch', () => {
    expect(readDispatch('- **merge-target branch:** alpha\n- **branch:** one-A1', 'pod:engineer').branch).toBe('one-A1')
    expect(readDispatch('- **merge-target branch:** alpha', 'pod:engineer').branch).toBeUndefined()
  })

  it('a round list field must be a whole number above 0', () => {
    expect(readDispatch('- **round:** 0', 'pod:reviewer').round).toBeUndefined()
    expect(readDispatch('- **round:** two', 'pod:reviewer').round).toBeUndefined()
    expect(readDispatch('- **round:** 3', 'pod:reviewer').round).toBe(3)
  })

  it('accepts a backticked value', () => {
    expect(readDispatch('- **plan:** `alpha`', 'pod:reviewer').plan).toBe('alpha')
  })
})

// ---- Every field shape real pod dispatches use (round 3: #17 read only list items) ----

// One field per line, no list marker: how most engineer dispatches look.
const PLAIN_LINES = ['Dispatched by /pod:code for wave 1.', '', 'sprint slug: two', 'slice code: B1', 'branch name: two-B1', 'merge-target branch: alpha'].join('\n')
// Several fields on one list item, joined with `·`.
const DOT_LIST = '- **sprint slug:** two · **slice code:** B1 · **branch name:** two-B1\n- **merge-target branch:** alpha'
// The same on a plain line, as claude-pod's own register test sends it.
const DOT_LINE = 'sprint slug: two · slice code: B1 · branch: two-B1'
// Bold field names with no list marker.
const BOLD_LINES = '**sprint slug:** two\n**slice code:** B1\n**branch name:** two-B1\n**merge-target branch:** alpha'
const DASH_LIST = '- sprint slug: two\n- slice code: B1\n- branch name: two-B1\n- merge-target branch: alpha'

describe('readDispatch reads every real field shape', () => {
  const engineer = { sprint: 'two', slice: 'B1', branch: 'two-B1', plan: undefined, round: undefined }

  it('one field per plain line', () => {
    expect(readDispatch(PLAIN_LINES, 'pod:engineer')).toEqual(engineer)
  })

  it('fields joined with · on one list item', () => {
    expect(readDispatch(DOT_LIST, 'pod:engineer')).toEqual(engineer)
  })

  it('fields joined with · on a plain line', () => {
    expect(readDispatch(DOT_LINE, 'pod:engineer')).toEqual(engineer)
  })

  it('bold field names with no list marker', () => {
    expect(readDispatch(BOLD_LINES, 'pod:engineer')).toEqual(engineer)
  })

  it('a dash list still works', () => {
    expect(readDispatch(DASH_LIST, 'pod:engineer')).toEqual(engineer)
  })

  it('bold with the colon outside the bold', () => {
    expect(readDispatch('**sprint slug**: two\n- **slice code**: B1', 'pod:engineer')).toMatchObject({ sprint: 'two', slice: 'B1' })
  })

  it('a kind list item with the round after ·', () => {
    expect(readDispatch('- kind: plan · round: 2\n- plan slug: alpha', 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: 2 })
  })

  it('a plan slug name with a bracketed note', () => {
    expect(readDispatch('- **plan slug (= plan branch):** alpha', 'pod:reporter').plan).toBe('alpha')
    expect(readDispatch('**plan slug (= plan branch):** alpha', 'pod:reviewer').plan).toBe('alpha')
  })

  it('a plan path is not a plan slug', () => {
    expect(readDispatch('- **plan:** pod-docs/plans/alpha.md', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('- **plan:** `pod-docs/plans/alpha.md`', 'pod:reviewer').plan).toBeUndefined()
  })

  it('a value stops before a trailing dot', () => {
    expect(readDispatch('plan slug: alpha.\nround: 2.', 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: 2 })
  })

  it('a · part counts only on a line that starts with a field, outside backticks', () => {
    expect(readDispatch('[2026-10-18 · PENDING · engineer → human · plan: alpha] text', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('- sprint slug: two · `slice code: Z9` · branch: two-B1', 'pod:engineer')).toMatchObject({ slice: undefined, branch: 'two-B1' })
    expect(readDispatch('Quote: `- sprint slug: X · slice code: Y`', 'pod:engineer').sprint).toBeUndefined()
  })

  it('a field mid-sentence or in backticks never counts, on any shape', () => {
    expect(readDispatch('See `plan slug: beta` and the round: 4 note.\nplan: alpha', 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: undefined })
    expect(readDispatch('`sprint slug: other`\n`slice code: Z9`', 'pod:engineer')).toMatchObject({ sprint: undefined, slice: undefined })
  })

  it('first match wins across shapes', () => {
    expect(readDispatch('sprint slug: two\n- **sprint slug:** other', 'pod:engineer').sprint).toBe('two')
  })

  it('a merge-target branch is not the branch, in any shape', () => {
    expect(readDispatch('merge-target branch: alpha\n**merge-target branch:** alpha · branch name: two-B1', 'pod:engineer').branch).toBe('two-B1')
    expect(readDispatch('merge-target branch: alpha', 'pod:engineer').branch).toBeUndefined()
  })

  it('engineers never get a plan, even from a plan field', () => {
    expect(readDispatch('sprint slug: two\nplan: alpha\n- **plan slug:** alpha', 'pod:engineer').plan).toBeUndefined()
  })

  it('a field that starts a sentence, as sprint planner prompts write them', () => {
    const planner = 'Dispatched by /pod:autopilot. Repo: /r (branch `alpha`). Plan slug: alpha. Draft the next sprint. Sprint slug: `two`.'
    expect(readDispatch(planner, 'pod:sprint-planner')).toMatchObject({ plan: 'alpha', sprint: 'two' })
    expect(readDispatch('Plan: alpha (pod-docs/plans/alpha.md). Draft the next sprint.', 'pod:sprint-planner').plan).toBe('alpha')
  })

  it('a field that is one whole bold span, anywhere outside backticks', () => {
    expect(readDispatch('Review the final plan PR, dispatched by /pod:autopilot — **round: 2**.', 'pod:reviewer').round).toBe(2)
    expect(readDispatch('Quoted `**round: 2**` here.', 'pod:reviewer').round).toBeUndefined()
  })

  it('a bold field name mid-sentence still never counts', () => {
    expect(readDispatch('The reviewer reads the **plan:** alpha field and a lower-case sentence. plan slug: beta', 'pod:reviewer').plan).toBeUndefined()
  })

  it('the round 2 prose case still reads the real plan field', () => {
    expect(readDispatch(REVIEWER_ROUND_2, 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: 2 })
  })
})

// ---- End to end: a transcript through parseAgentTranscript, listRuns, and buildPipeline ----

const NOW = Date.UTC(2026, 9, 18, 12)
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'

/** A running agent: its prompt ten minutes ago, its last turn a minute ago, not ended. */
function transcript(agentType: string, prompt: string) {
  const run = parseAgentTranscript({
    id: 'a1',
    session: 's1',
    meta: JSON.stringify({ agentType, description: 'Review plan alpha' }),
    jsonl: jsonl(
      { type: 'user', timestamp: at(10), message: { role: 'user', content: prompt } },
      {
        type: 'assistant',
        timestamp: at(1),
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-opus-5-5',
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      },
    ),
  })
  if (!run) throw new Error('not a pod agent')
  return run
}

function planFiles(sprints: [string, string][]): RepoFiles {
  return {
    'pod-docs/README.md': '# pod docs\n\npod docs: 2\n',
    'pod-docs/plans/alpha.md': [
      '# Plan: ALPHA',
      '',
      '_Generated: 2026-10-18 · Status: active · Grilled-with: grilling_',
      '',
      '## Sprint sequence',
      '',
      '| Sprint | Goal | Status | Depends on |',
      '|--------|------|--------|------------|',
      ...sprints.map(([slug, status]) => `| ${slug} | goal of ${slug} | ${status} | — |`),
      '',
    ].join('\n'),
    'pod-docs/handoff-queue.md': '',
    'pod-docs/sprints/archive/one.md': [
      '# Sprint: one',
      '',
      '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: done · Generated: 2026-10-18_',
      '',
      '## Status board',
      '',
      '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
      '|------|-------|-------|--------|----|--------|------------|------------|',
      '| 1 | A1 | Title A1 | one-A1 | [#3](https://github.com/o/r/pull/3) merged | done | medium | — |',
      '',
    ].join('\n'),
  }
}

const repo = (files: RepoFiles, agentType: string, prompt: string): BoardRepo => ({
  id: 'id-r',
  name: 'r',
  path: '/r',
  source: 'registered',
  model: buildRepoModel(files),
  agents: [transcript(agentType, prompt)],
  prs: [],
  claims: [],
})

const stage = (r: BoardRepo, key: string) =>
  buildPipeline(r, 'alpha', NOW)
    ?.stages.filter((s) => s.key === key)
    .flatMap((s) => s.steps.map((x) => [x.label, x.state, x.detail]))

describe('a real-shaped dispatch, end to end', () => {
  it('keeps a plan in final review in the runs list while its reviewer runs', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', REVIEWER)
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'final review', 'running']])
    expect(stage(r, 'check')?.[0]).toEqual(['Final review', 'live', 'round 1'])
  })

  it('keeps a plan in final review while its round 2 reviewer runs, with prose naming fields', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', REVIEWER_ROUND_2)
    expect(r.agents[0]).toMatchObject({ plan: 'alpha', round: 2 })
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'final review', 'running']])
    expect(stage(r, 'check')?.[0]).toEqual(['Final review', 'live', 'round 2'])
  })

  it('a running plan fix engineer gets its fields from the list, not the prose', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:engineer', FIX_ENGINEER)
    expect(r.agents[0]).toMatchObject({ sprint: 'one', slice: 'plan-fix', branch: 'alpha-fix' })
    expect(r.agents[0]).not.toHaveProperty('plan')
    expect(r.agents[0]).not.toHaveProperty('round')
  })

  it('shows a running sprint planner as drafting', () => {
    const r = repo(planFiles([['one', 'done'], ['two', 'planned']]), 'pod:sprint-planner', PLANNER)
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'two · drafting', 'running']])
    expect(stage(r, 'sprint:two')).toEqual([['two', 'live', 'drafting']])
  })
})

// ---- End to end: an engineer on an active sprint's slice, in each real shape ----

const SPRINT_TWO = [
  '# Sprint: two',
  '',
  '_From plan: pod-docs/plans/alpha.md · Slug: two · Status: active · Generated: 2026-10-18_',
  '',
  '## Status board',
  '',
  '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
  '|------|-------|-------|--------|----|--------|------------|------------|',
  '| 1 | B1 | Title B1 | two-B1 | — | in progress | — | — |',
  '',
].join('\n')

const activeFiles = (): RepoFiles => ({ ...planFiles([['one', 'done'], ['two', 'active']]), 'pod-docs/sprints/two.md': SPRINT_TWO })

describe('a running engineer, end to end, in every real shape', () => {
  const shapes: [string, string][] = [
    ['plain lines', PLAIN_LINES],
    ['· on a list item', DOT_LIST],
    ['· on a plain line', DOT_LINE],
    ['bold, no marker', BOLD_LINES],
    ['dash list', DASH_LIST],
  ]
  it.each(shapes)('%s: the engineer runs its slice', (_name, prompt) => {
    const r = repo(activeFiles(), 'pod:engineer', prompt)
    const plan = r.model.plans.find((p) => p.slug === 'alpha')!
    expect(roleOf(r.agents[0]!, plan)).toEqual({ kind: 'slice', sprint: 'two', code: 'B1' })
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.state])).toEqual([['alpha', 'running']])
    const row = buildPipeline(r, 'alpha', NOW)?.log.find((g) => g.sprint === 'two')?.rows[0]
    expect(row).toMatchObject({ code: 'B1', live: true, minutes: 10 })
  })
})

describe('a reviewer, end to end, in the other real shapes', () => {
  it('a reviewer with kind and round on one · line keeps its round', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', '- kind: plan · round: 2\n- plan slug: alpha')
    expect(stage(r, 'check')?.[0]).toEqual(['Final review', 'live', 'round 2'])
  })

  it('a reviewer with a bold plan slug note keeps its plan', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', '**plan slug (= plan branch):** alpha\nround: 3')
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'final review', 'running']])
    expect(stage(r, 'check')?.[0]).toEqual(['Final review', 'live', 'round 3'])
  })

  it('a reviewer given a plan path gets no plan from it', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', '- **plan:** pod-docs/plans/alpha.md\n- **round:** 1')
    expect(r.agents[0]).not.toHaveProperty('plan')
    expect(roleOf(r.agents[0]!, r.model.plans[0]!)).toEqual({ kind: 'other' })
  })
})

// ---- Round 4: Windows drive paths and fenced code blocks ----

const DRIVE_PLANNER =
  'Plan: E:/Projects/ytb-feed/pod-docs/plans/friends-on-a-server.md. Draft the next sprint doc for plan `friends-on-a-server`.'

// A fenced example before the real fields, as pasted findings or instructions show one.
const FENCED_REVIEWER = [
  'An example of the old shape:',
  '',
  '```md',
  '- **plan:** beta',
  '- **round:** 7',
  '```',
  '',
  '~~~',
  'sprint slug: other · slice code: Z9',
  '~~~',
  '',
  '- **plan:** alpha',
  '- **round:** 2',
  '- **sprint slug:** one',
].join('\n')

describe('readDispatch: drive paths and fenced blocks', () => {
  it('a Windows drive path is a path and gives nothing', () => {
    expect(readDispatch('- **plan:** E:/r/pod-docs/plans/alpha.md', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch(String.raw`- **plan:** E:\r\pod-docs\plans\alpha.md`, 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('- **plan:** `E:/r/pod-docs/plans/alpha.md`', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('Plan: c:/r/alpha.md.', 'pod:reviewer').plan).toBeUndefined()
    expect(readDispatch('- **branch name:** E:/r/x', 'pod:engineer').branch).toBeUndefined()
  })

  it('a value followed by a colon that is not a drive path keeps its value', () => {
    expect(readDispatch('- **plan:** alpha: the first plan', 'pod:reviewer').plan).toBe('alpha')
    expect(readDispatch('- **slice code:** A1:', 'pod:engineer').slice).toBe('A1')
  })

  it('a drive-path plan field falls through to the planner prose', () => {
    expect(readDispatch(DRIVE_PLANNER, 'pod:sprint-planner').plan).toBe('friends-on-a-server')
    expect(readDispatch(DRIVE_PLANNER, 'pod:reviewer').plan).toBeUndefined()
  })

  it('a drive-path plan field falls through to a plan slug field', () => {
    expect(readDispatch('- **plan:** E:/r/pod-docs/plans/alpha.md\n- **plan slug:** alpha', 'pod:reviewer').plan).toBe('alpha')
    expect(readDispatch('- **plan slug:** E:/r/x\n- **plan:** alpha', 'pod:reviewer').plan).toBe('alpha')
  })

  it('fields inside fenced code blocks never count', () => {
    expect(readDispatch(FENCED_REVIEWER, 'pod:reviewer')).toMatchObject({ plan: 'alpha', round: 2, sprint: 'one', slice: undefined })
  })

  it('a fence closes only on the same fence character, at least as long', () => {
    const prompt = ['````', '```', 'plan: beta', '~~~', '````', 'plan: alpha'].join('\n')
    expect(readDispatch(prompt, 'pod:reviewer').plan).toBe('alpha')
  })

  it('an indented or list-item fence counts as a fence', () => {
    expect(readDispatch('- example:\n  ```\n  - **plan:** beta\n  ```\n- **plan:** alpha', 'pod:reviewer').plan).toBe('alpha')
  })

  it('an unclosed fence runs to the end of the prompt', () => {
    expect(readDispatch('- **round:** 2\n```\n- **plan:** beta', 'pod:reviewer')).toMatchObject({ plan: undefined, round: 2 })
  })

  it('inline triple backticks on a prose line are not a fence', () => {
    expect(readDispatch('Quote ```x``` here.\n- **plan:** alpha', 'pod:reviewer').plan).toBe('alpha')
  })

  it('planner prose inside a fenced block never counts', () => {
    expect(readDispatch('```\nfor plan `beta`\n```\nDraft the next sprint doc for plan `alpha`.', 'pod:sprint-planner').plan).toBe('alpha')
  })
})

describe('drive paths and fenced blocks, end to end', () => {
  it('a sprint planner given a drive-path plan shows the sprint as drafting', () => {
    const prompt = DRIVE_PLANNER.replaceAll('friends-on-a-server', 'alpha')
    const r = repo(planFiles([['one', 'done'], ['two', 'planned']]), 'pod:sprint-planner', prompt)
    expect(r.agents[0]).toMatchObject({ plan: 'alpha' })
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'two · drafting', 'running']])
    expect(stage(r, 'sprint:two')).toEqual([['two', 'live', 'drafting']])
  })

  it('a reviewer given a drive-path plan slug and a plan field stays in final review', () => {
    const prompt = '- **kind:** plan\n- **plan slug:** E:/r/pod-docs/plans/alpha.md\n- **plan:** alpha\n- **round:** 4'
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', prompt)
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'final review', 'running']])
    expect(stage(r, 'check')?.[0]).toEqual(['Final review', 'live', 'round 4'])
  })

  it('a reviewer given only a drive-path plan gets no plan, not its drive letter', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', '- **plan:** E:/r/pod-docs/plans/alpha.md\n- **round:** 1')
    expect(r.agents[0]).not.toHaveProperty('plan')
  })

  it('a reviewer with a fenced example before its fields keeps the real plan and round', () => {
    const r = repo(planFiles([['one', 'done']]), 'pod:reviewer', FENCED_REVIEWER)
    expect(listRuns({ generatedAt: NOW, gh: 'ok', repos: [r] }, NOW).map((x) => [x.plan, x.where, x.state])).toEqual([['alpha', 'final review', 'running']])
    expect(stage(r, 'check')?.[0]).toEqual(['Final review', 'live', 'round 2'])
  })
})

// /pod:task dispatch shapes (pod 0.10.0+), as real ones write them (made-up values): the engineer's
// `branch name` and the reviewer's `kind: task` and `branch` come after a long free-text `task` field.
const TASK_ENGINEER = [
  'Standalone /pod:task dispatch (no sprint slug).',
  '',
  "- **task:** Make the board read `/pod:task` runs. Today it knows only `fix-<slug>` claims and `kind: fix` reviewers.",
  '- **branch name:** task-support-pod-task (off origin/main)',
  '- **merge-target branch:** pod-staging',
  '- **worktree path:** E:/r/.claude/worktrees/task-support-pod-task',
].join('\n')
const TASK_REVIEWER = [
  '- **kind:** task',
  '- **PR URL:** https://github.com/o/r/pull/104',
  '- **merge-target:** main',
  '- **task:**',
  '  Add a 404 page. Human decisions: one heading, a link to /.',
  '- **branch:** task-404-page',
  '- **parent-repo path:** E:/r',
  '- **round:** 1',
].join('\n')

describe('readDispatch reads a /pod:task engineer and reviewer', () => {
  it('reads the engineer branch, and no plan', () => {
    expect(readDispatch(TASK_ENGINEER, 'pod:engineer')).toMatchObject({ branch: 'task-support-pod-task', plan: undefined, sprint: undefined, slice: undefined })
  })

  it('reads the reviewer kind, PR number, branch, and round', () => {
    expect(readDispatch(TASK_REVIEWER, 'pod:reviewer')).toMatchObject({ kind: 'task', pr: 104, branch: 'task-404-page', round: 1, plan: undefined })
  })
})

// /pod:fix reviewer shapes, as real ones write them (made-up values).
const FIX_REVIEWER_LINES = [
  'kind: fix',
  'round: 1',
  '',
  'Task as given: make the clock test use fake timers.',
  '',
  'PR: https://github.com/o/r/pull/45',
  'Branch: fix-clock',
  'Merge-target: main',
].join('\n')
const FIX_REVIEWER_SENTENCES =
  'kind: fix. Task as given: break the import cycle.\nPR: https://github.com/o/r/pull/96. Branch: fix-cycle. Merge-target: main. Parent repo: E:/r.'
const FIX_REVIEWER_BOLD = 'kind: fix — one-pass review of a standalone /pod:fix PR.\n\n## Required dispatch context\n- **Task as given:** x\n- **PR:** https://github.com/o/r/pull/22\n- **Branch:** fix-idle'
// A hand-written shape: the PR and branch only in prose, so neither is read.
const FIX_REVIEWER_PROSE = 'kind: fix. Review PR https://github.com/o/r/pull/36, branch fix-scroll → merge-target main. Parent repo: E:\r.'

describe('readDispatch reads a fix reviewer kind and PR', () => {
  it('reads kind, PR number, and branch from line fields', () => {
    expect(readDispatch(FIX_REVIEWER_LINES, 'pod:reviewer')).toMatchObject({ kind: 'fix', pr: 45, branch: 'fix-clock', round: 1 })
  })

  it('reads them from sentence fields and bold list fields', () => {
    expect(readDispatch(FIX_REVIEWER_SENTENCES, 'pod:reviewer')).toMatchObject({ kind: 'fix', pr: 96, branch: 'fix-cycle' })
    expect(readDispatch(FIX_REVIEWER_BOLD, 'pod:reviewer')).toMatchObject({ kind: 'fix', pr: 22, branch: 'fix-idle' })
  })

  it('reads a plan reviewer kind and its PR URL field', () => {
    expect(readDispatch(REVIEWER, 'pod:reviewer')).toMatchObject({ kind: 'plan', pr: 15, plan: 'alpha' })
  })

  it('reads a PR URL followed by a note', () => {
    expect(readDispatch('kind: fix\nPR: https://github.com/o/r/pull/34 (fix-a → main)', 'pod:reviewer').pr).toBe(34)
  })

  it('reads no PR or branch from prose', () => {
    const d = readDispatch(FIX_REVIEWER_PROSE, 'pod:reviewer')
    expect(d).toMatchObject({ kind: 'fix' })
    expect(d.pr).toBeUndefined()
    expect(d.branch).toBeUndefined()
  })

  it('a PR field that is not a GitHub pull URL gives nothing, and ends the search', () => {
    expect(readDispatch('PR: #22\nPR URL: https://github.com/o/r/pull/9', 'pod:reviewer').pr).toBeUndefined()
    expect(readDispatch('PR: https://example.com/o/r/pull/9', 'pod:reviewer').pr).toBeUndefined()
    expect(readDispatch('PR: `https://github.com/o/r/pull/9`', 'pod:reviewer').pr).toBe(9)
  })

  it('reads no kind or PR in backticks, fences, or mid-sentence', () => {
    expect(readDispatch('Use `kind: fix` and `PR: https://github.com/o/r/pull/9`.', 'pod:reviewer')).toMatchObject({ kind: undefined, pr: undefined })
    expect(readDispatch('```\nkind: fix\nPR: https://github.com/o/r/pull/9\n```', 'pod:reviewer')).toMatchObject({ kind: undefined, pr: undefined })
    expect(readDispatch('the kind: fix one, see the PR: https://github.com/o/r/pull/9', 'pod:reviewer')).toMatchObject({ kind: undefined, pr: undefined })
  })

  it('reads kind and PR for reviewers only', () => {
    for (const type of ['pod:engineer', 'pod:sprint-planner', 'pod:reporter', 'pod:researcher']) {
      const d = readDispatch(FIX_REVIEWER_LINES, type)
      expect([d.kind, d.pr], type).toEqual([undefined, undefined])
    }
  })

  it('a fix engineer reads its branch from a sentence field', () => {
    const prompt = 'Standalone /pod:fix slice. Parent repo: E:\r. Merge-target: main. Branch: fix-scroll. Ports: 3110/3111.'
    expect(readDispatch(prompt, 'pod:engineer')).toEqual({ sprint: undefined, slice: undefined, branch: 'fix-scroll', plan: undefined, round: undefined })
  })
})
