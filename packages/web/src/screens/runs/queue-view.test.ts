import { describe, expect, it } from 'vitest'
import { buildRepoModel, type AnswerResult, type BoardRepo, type RunSummary } from '@pod-board/model'
import { formView, type AnswerState } from './answer-flow.ts'
import { ANSWER_NOTE, ANSWER_NOTE_NEXT_WAVE, ANSWER_WAITING, answerNote, formAnchor, waitingRows } from './queue-view.ts'
import { nextSteps } from './next-step.ts'

const README = '# pod docs\n\npod docs: 2\n'

const plan = (slug: string, sprint: string) =>
  [
    `# Plan: ${slug}`,
    '',
    '_Generated: 2026-10-21 · Status: active · Grilled-with: grilling_',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    `| ${sprint} | goal | active | — |`,
    '',
  ].join('\n')

// Each entry's line is its identity; the body after the header.
const UNJOINED_NOTE = '- [2026-10-20 · NOTE · orchestrator → human] Check the `pnpm` cache **soon**. **Resolution:** pending'
const ALPHA_PENDING = '- [2026-10-21 · PENDING · engineer → human · sprint: one · slice: A1] Pick a [port](http://x) for the dev server. **Resolution:** pending'
const BETA_PENDING = '- [2026-10-21 · PENDING · engineer → human · sprint: two · slice: B1] Beta asks. **Resolution:** pending'
const ALPHA_RESOLVED = '- [2026-10-21 · PENDING · engineer → human · sprint: one · slice: A2] Old ask. **Resolution:** done in #4'
const ALPHA_SOLVED = '- [2026-10-21 · SOLVED · engineer → human · sprint: one · slice: A1] Fixed it. **Resolution:** pending'
const ALPHA_ANSWERED = '- [2026-10-22 · BLOCKED · orchestrator → human · plan: alpha] Gate failed. **Resolution:** pending **Answer (human):** rerun the build'
const UNJOINED_BLOCKED = '- [2026-10-22 · BLOCKED · engineer → orchestrator] Tool missing. **Resolution:** pending'

const QUEUE = ['# Handoff queue', '', UNJOINED_NOTE, ALPHA_PENDING, BETA_PENDING, ALPHA_RESOLVED, ALPHA_SOLVED, ALPHA_ANSWERED, UNJOINED_BLOCKED, ''].join('\n')

function repo(queue = QUEUE): BoardRepo {
  const model = buildRepoModel({
    'pod-docs/README.md': README,
    'pod-docs/plans/alpha.md': plan('alpha', 'one'),
    'pod-docs/plans/beta.md': plan('beta', 'two'),
    'pod-docs/handoff-queue.md': queue,
  })
  return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model, agents: [], prs: [], claims: [] }
}

const run = (over: Partial<RunSummary> = {}): RunSummary => ({ repoId: 'id-r', repo: 'r', plan: 'alpha', where: 'one · wave 1/1', state: 'needs-you', ...over })
const trim = (line: string) => line.trim()

describe('waiting on you', () => {
  it('which entries wait on you', () => {
    // The plan's own entries first, in queue order, then the repo's entries that join no plan.
    expect(waitingRows(repo(), run()).map((r) => r.line)).toEqual([ALPHA_PENDING, ALPHA_ANSWERED, UNJOINED_NOTE, UNJOINED_BLOCKED].map(trim))
    // Another plan gets its own entries and the same unjoined ones.
    expect(waitingRows(repo(), run({ plan: 'beta' })).map((r) => r.line)).toEqual([BETA_PENDING, UNJOINED_NOTE, UNJOINED_BLOCKED].map(trim))
    // A fix run and a repo row join no plan, so only the unjoined entries show.
    expect(waitingRows(repo(), run({ plan: 'fix-x', fix: 'x' })).map((r) => r.line)).toEqual([UNJOINED_NOTE, UNJOINED_BLOCKED].map(trim))
    expect(waitingRows(repo(), run({ plan: undefined, state: 'idle' })).map((r) => r.line)).toEqual([UNJOINED_NOTE, UNJOINED_BLOCKED].map(trim))
    // Nothing selected, no repo, or an empty queue: no rows.
    expect(waitingRows(undefined, run())).toEqual([])
    expect(waitingRows(repo(), undefined)).toEqual([])
    expect(waitingRows(repo('# Handoff queue\n'), run())).toEqual([])
  })

  it('rows and their answer state', () => {
    const rows = waitingRows(repo(), run())
    const [pending, answered, note, blocked] = rows
    expect(pending).toMatchObject({
      chip: { cls: 's-you', label: 'PENDING' },
      date: '2026-10-21',
      route: 'engineer → human',
      body: 'Pick a port for the dev server.',
      answerable: true,
    })
    expect(pending?.yourAnswer).toBeUndefined()
    expect(pending?.waiting).toBeUndefined()
    // An answered entry shows its answer and that pod hasn't read it, with no Answer button.
    expect(answered).toMatchObject({
      chip: { cls: 's-bad', label: 'BLOCKED' },
      body: 'Gate failed.',
      answerable: false,
      yourAnswer: 'Your answer: rerun the build',
      waiting: 'Waiting for pod to read it.',
    })
    expect(ANSWER_WAITING).toBe('Waiting for pod to read it.')
    // A NOTE is never answerable; its body is plain text.
    expect(note).toMatchObject({ chip: { cls: 's-idle', label: 'NOTE' }, body: 'Check the pnpm cache soon.', answerable: false })
    // A BLOCKED routed to the orchestrator is listed, but has no Answer button.
    expect(blocked).toMatchObject({ chip: { cls: 's-bad', label: 'BLOCKED' }, answerable: false })
    // Keys are unique even when two lines read the same.
    const twice = waitingRows(repo(['# Q', ALPHA_PENDING, ALPHA_PENDING].join('\n')), run())
    expect(twice).toHaveLength(2)
    expect(new Set(twice.map((r) => r.key)).size).toBe(2)
  })

  it('rows carry the kind and show the body without it', () => {
    const KINDED = '- [2026-10-23 · PENDING · reviewer → human · plan: alpha] **decision (wording):** pick the `port` label. **Resolution:** pending'
    const rows = waitingRows(repo(['# Q', KINDED, ALPHA_PENDING].join('\n')), run())
    // The kind is read from the plain body; the full body stays for the card and the answer form.
    expect(rows[0]).toMatchObject({ kind: 'decision', kindLabel: 'decision (wording)', text: 'pick the port label.', body: 'decision (wording): pick the port label.' })
    // No kind word: kind other, the text is the whole body.
    expect(rows[1]).toMatchObject({ kind: 'other', kindLabel: 'other', text: 'Pick a port for the dev server.', body: 'Pick a port for the dev server.' })
  })

  it('the form says to answer here, then Continue', () => {
    expect(ANSWER_NOTE).toBe('Answer here, then press Continue. pod reads it when the run continues.')
    expect(ANSWER_NOTE).not.toMatch(/chat/i)
    const target = { repoId: 'id-r', line: trim(ALPHA_PENDING) }
    const editing: AnswerState = { kind: 'editing', seq: 1, target, text: '' }
    expect(formView(editing)?.note).toBe(ANSWER_NOTE)
    const answered: AnswerState = { kind: 'result', seq: 2, target, text: 'x', result: { outcome: 'answered', logged: true } }
    expect(formView(answered)?.note).toBe(ANSWER_NOTE)
  })

  it('a plan run reads the answer on Continue; a fix run or repo row at the next wave', () => {
    expect(answerNote(run())).toBe(ANSWER_NOTE)
    // /pod:fix reads no answers and a repo row has no Continue, so the next /pod:code wave reads it.
    expect(ANSWER_NOTE_NEXT_WAVE).toBe('Answer here. pod reads it when a /pod:code run next starts a wave.')
    expect(ANSWER_NOTE_NEXT_WAVE).not.toMatch(/chat|Continue/i)
    expect(answerNote(run({ plan: 'fix-x', fix: 'x' }))).toBe(ANSWER_NOTE_NEXT_WAVE)
    expect(answerNote(run({ plan: undefined, state: 'idle' }))).toBe(ANSWER_NOTE_NEXT_WAVE)
    // The form shows the note it is given.
    const editing: AnswerState = { kind: 'editing', seq: 1, target: { repoId: 'id-r', line: trim(ALPHA_PENDING) }, text: '' }
    expect(formView(editing, ANSWER_NOTE_NEXT_WAVE)?.note).toBe(ANSWER_NOTE_NEXT_WAVE)
  })

  it('the form stays with its row after the answer', () => {
    const line = trim(ALPHA_PENDING)
    const rows = waitingRows(repo(), run())
    const target = { repoId: 'id-r', line }
    expect(formAnchor({ kind: 'idle', seq: 0 }, rows, 'id-r')).toBeUndefined()
    expect(formAnchor({ kind: 'editing', seq: 1, target, text: '' }, rows, 'id-r')).toBe(rows[0]?.key)
    // Once saved, the Board's line carries the answer; the result stays under that row.
    const after = waitingRows(repo(QUEUE.replace(ALPHA_PENDING, `${ALPHA_PENDING} **Answer (human):** port 3030`)), run())
    const result: AnswerResult = { outcome: 'answered', logged: true }
    expect(formAnchor({ kind: 'result', seq: 2, target, text: 'port 3030', result }, after, 'id-r')).toBe(after[0]?.key)
    // The entry gone from the list: the form has no row and shows after the list.
    expect(formAnchor({ kind: 'result', seq: 2, target, text: 'x', result: { outcome: 'changed', logged: true } }, rows.slice(1), 'id-r')).toBe('end')
    // Another repo's form never anchors here.
    expect(formAnchor({ kind: 'editing', seq: 1, target: { repoId: 'other', line }, text: '' }, rows, 'id-r')).toBeUndefined()
  })
})

describe('Done and Value in use on the rows', () => {
  const archived = (slug: string) => plan(slug, 'one').replace('Status: active', 'Status: archived')
  const GATE = '- `[2026-10-20 · PENDING · orchestrator → human · plan: old]` gate 4 (wave-check-failed): A1 stuck. Value in use: skip A1. **Resolution:** pending'
  const DECISION = '- `[2026-10-21 · PENDING · engineer → human · plan: old]` decision: the badge colour. value in use: `white`. Answer to change. **Resolution:** pending'
  const PLAIN = '- `[2026-10-21 · PENDING · engineer → human · plan: old]` someday: tidy the logs. **Resolution:** pending'
  const TO_POD = '- `[2026-10-21 · BLOCKED · engineer → orchestrator · plan: old]` gate 1 (blocked-concern): for pod. **Resolution:** pending'

  function oldRepo(): BoardRepo {
    const model = buildRepoModel({
      'pod-docs/README.md': README,
      'pod-docs/plans/archive/old.md': archived('old'),
      'pod-docs/handoff-queue.md': ['# Handoff queue', '', GATE, DECISION, PLAIN, TO_POD, ''].join('\n'),
    })
    return { id: 'id-r', name: 'r', path: '/r', source: 'registered', model, agents: [], prs: [], claims: [] }
  }

  it('a Done entry shows its reason and no default; a value in use shows as the default', () => {
    const [gate, decision, plain, toPod] = waitingRows(oldRepo(), run({ plan: 'old' }))
    // Done wins over the gate's own value in use.
    expect(gate).toMatchObject({ done: 'plan old is archived' })
    expect(gate?.keep).toBeUndefined()
    expect(decision).toMatchObject({ keep: 'white' })
    expect(decision?.done).toBeUndefined()
    for (const r of [plain, toPod]) {
      expect(r?.done).toBeUndefined()
      expect(r?.keep).toBeUndefined()
    }
  })

  it('the Next step card carries the same row', () => {
    const steps = nextSteps(run({ plan: 'old' }), oldRepo(), Date.UTC(2026, 9, 31))
    const items = steps ? [steps.card, ...steps.rest] : []
    expect(items.find((i) => i.entry?.done !== undefined)?.entry?.done).toBe('plan old is archived')
    expect(items.find((i) => i.entry?.keep !== undefined)?.entry?.keep).toBe('white')
  })
})
