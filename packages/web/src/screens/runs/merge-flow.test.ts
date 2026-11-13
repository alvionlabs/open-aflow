import { describe, expect, it } from 'vitest'
import type { MergeOutcome, MergePreview, MergeResult } from '@openaflow/model'
import type { ActionReply } from '../../actions-client.ts'
import { confirmView, createMergeFlow, type MergeState, type MergeTarget, type Post } from './merge-flow.ts'

const SHA = 'a'.repeat(40)
const NEW_SHA = 'b1c2d3e'.padEnd(40, 'f')
const A: MergeTarget = { repoId: 'r1', number: 41 }
const B: MergeTarget = { repoId: 'r1', number: 42 }

const preview = (over: Partial<MergePreview> = {}): MergePreview => ({
  number: 41,
  url: 'https://github.com/o/n/pull/41',
  title: 'Wave 2 of merge-actions',
  headSha: SHA,
  state: 'open',
  checks: 'pass',
  mergeable: 'mergeable',
  mergeState: 'CLEAN',
  ...over,
})
const result = (outcome: MergeOutcome, over: Partial<MergeResult> = {}): MergeResult => ({ outcome, number: 41, logged: true, ...over })

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

/** A post that records each call and answers only when the test says so. */
function fakePost() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string, body: object) =>
    new Promise<ActionReply<T>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  return { calls, post }
}

const AT = 1_800_000_000_000

/** A flow, its fake post, and the latest state it reported. With `onMerged`, the flow closes on merged. */
function setup(onMerged?: (number: number, at: number) => void) {
  const p = fakePost()
  const seen: MergeState[] = []
  const flow = createMergeFlow((s) => seen.push(s), p.post, onMerged ? { onMerged, now: () => AT } : {})
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const answer = async (i: number, reply: ActionReply<unknown>) => {
    expect(p.calls[i], `request ${i} was sent`).toBeDefined()
    p.calls[i]!.resolve(reply)
    await tick()
  }
  return { flow, calls: p.calls, seen, answer }
}

const ok = <T,>(data: T): ActionReply<T> => ({ ok: true, data })

/** Opens A and answers its preview, leaving the flow at confirm. */
async function atConfirm(over: Partial<MergePreview> = {}, onMerged?: (number: number, at: number) => void) {
  const t = setup(onMerged)
  t.flow.open(A)
  await t.answer(0, ok(preview(over)))
  return t
}

describe('merge flow', () => {
  it('opens and cancels in place', async () => {
    const t = setup()
    expect(t.flow.state().kind).toBe('idle')
    expect(confirmView(t.flow.state())).toBeUndefined()

    t.flow.open(A)
    expect(t.flow.state()).toMatchObject({ kind: 'loading', target: A })
    expect(t.calls.map((c) => [c.path, c.body])).toEqual([['merge-preview', { repoId: 'r1', number: 41 }]])
    expect(confirmView(t.flow.state())).toMatchObject({ heading: 'PR #41', status: 'Reading the PR from GitHub…', showMerge: false })

    await t.answer(0, ok(preview()))
    expect(t.flow.state()).toMatchObject({ kind: 'confirm', target: A, preview: preview() })
    expect(t.seen.at(-1)?.kind).toBe('confirm')

    // Cancel → idle.
    t.flow.cancel()
    expect(t.flow.state().kind).toBe('idle')

    // Escape → idle from confirm; other keys do nothing.
    t.flow.open(A)
    await t.answer(1, ok(preview()))
    t.flow.key('Enter')
    expect(t.flow.state().kind).toBe('confirm')
    t.flow.key('Escape')
    expect(t.flow.state().kind).toBe('idle')

    // Escape while loading cancels, and the late preview is dropped.
    t.flow.open(A)
    t.flow.key('Escape')
    await t.answer(2, ok(preview()))
    expect(t.flow.state().kind).toBe('idle')

    // A second open closes the first: B loads, and A's late reply can't show over it.
    t.flow.open(A)
    t.flow.open(B)
    expect(t.flow.state()).toMatchObject({ kind: 'loading', target: B })
    await t.answer(3, ok(preview()))
    expect(t.flow.state()).toMatchObject({ kind: 'loading', target: B })
    await t.answer(4, ok(preview({ number: 42 })))
    expect(t.flow.state()).toMatchObject({ kind: 'confirm', target: B })

    // Opening the open one again reads it fresh.
    t.flow.open(B)
    expect(t.flow.state()).toMatchObject({ kind: 'loading', target: B })
    expect(t.calls).toHaveLength(6)
  })

  it('merges the head you saw, once', async () => {
    const t = await atConfirm()
    expect(confirmView(t.flow.state())).toMatchObject({ showMerge: true, canMerge: true, cancelDisabled: false })

    t.flow.merge()
    expect(t.flow.state().kind).toBe('merging')
    expect(t.calls.slice(1).map((c) => [c.path, c.body])).toEqual([['merge', { repoId: 'r1', number: 41, headSha: SHA }]])
    expect(confirmView(t.flow.state())).toMatchObject({ status: 'Merging…', canMerge: false, cancelDisabled: true })

    // A repeat press, Cancel, Escape, or another open while merging send nothing and change nothing.
    t.flow.merge()
    t.flow.cancel()
    t.flow.key('Escape')
    t.flow.open(B)
    expect(t.flow.state().kind).toBe('merging')
    expect(t.calls).toHaveLength(2)

    await t.answer(1, ok(result('merged')))
    expect(t.flow.state()).toMatchObject({ kind: 'result', target: A })
    // Merge from a result isn't offered; the step's button opens a fresh confirm.
    t.flow.merge()
    expect(t.calls).toHaveLength(2)
  })

  it("shows GitHub's result", async () => {
    const words = async (r: MergeResult) => {
      const t = await atConfirm()
      t.flow.merge()
      await t.answer(1, ok(r))
      return confirmView(t.flow.state())
    }
    expect(await words(result('merged'))).toMatchObject({ result: { words: 'Merged', tone: 's-ok' }, showMerge: false, closeLabel: 'Close' })
    expect((await words(result('queued')))?.result).toMatchObject({ words: 'Added to the merge queue', tone: 's-run' })
    expect((await words(result('auto-merge')))?.result).toMatchObject({ words: 'Auto-merge on: GitHub merges it when checks pass', tone: 's-run' })
    expect((await words(result('failed', { message: 'Pull request is not mergeable' })))?.result).toMatchObject({ words: 'Pull request is not mergeable', tone: 's-bad' })
    expect((await words(result('unconfirmed', { message: "GitHub didn't confirm the merge yet." })))?.result).toMatchObject({
      words: "GitHub didn't confirm the merge yet.",
      tone: 's-you',
    })
    // A failed or unconfirmed result with no message still says something, and never Merged.
    expect((await words(result('failed')))?.result?.words).toBe('The merge failed.')
    expect((await words(result('unconfirmed')))?.result?.words).toBe("GitHub hasn't confirmed the merge.")

    // Merged only for merged, whatever the message says.
    for (const outcome of ['queued', 'auto-merge', 'stale', 'failed', 'unconfirmed'] as const) {
      const v = await words(result(outcome, { message: 'x', headSha: NEW_SHA }))
      expect(v?.result?.words, outcome).not.toBe('Merged')
    }

    // logged false adds the note; logged true has none.
    expect((await words(result('merged', { logged: false })))?.result?.note).toBe('Not saved to the action log.')
    expect((await words(result('merged')))?.result?.note).toBeUndefined()
    expect((await words(result('failed', { logged: false, message: 'm' })))?.result).toMatchObject({ words: 'm', note: 'Not saved to the action log.' })
  })

  it('stale head asks to look again', async () => {
    const t = await atConfirm()
    t.flow.merge()
    await t.answer(1, ok(result('stale', { headSha: NEW_SHA })))
    expect(confirmView(t.flow.state())).toMatchObject({
      result: { words: 'The PR changed since you looked (head now b1c2d3e).', tone: 's-you' },
      checkAgain: true,
      showMerge: false,
    })

    // Check again loads the preview again, then a merge sends the new head.
    t.flow.retry()
    expect(t.flow.state()).toMatchObject({ kind: 'loading', target: A })
    expect(t.calls[2]).toMatchObject({ path: 'merge-preview', body: { repoId: 'r1', number: 41 } })
    await t.answer(2, ok(preview({ headSha: NEW_SHA })))
    t.flow.merge()
    expect(t.calls[3]).toMatchObject({ path: 'merge', body: { repoId: 'r1', number: 41, headSha: NEW_SHA } })

    // A stale reply with no sha still reads as a sentence; other outcomes offer no Check again.
    const u = await atConfirm()
    u.flow.merge()
    await u.answer(1, ok(result('stale')))
    expect(confirmView(u.flow.state())?.result?.words).toBe('The PR changed since you looked.')
    const m = await atConfirm()
    m.flow.merge()
    await m.answer(1, ok(result('merged')))
    expect(confirmView(m.flow.state())?.checkAgain).toBe(false)
  })

  it('conflicts block merge', async () => {
    const conflicting = await atConfirm({ mergeable: 'conflicting' })
    const v = confirmView(conflicting.flow.state())
    expect(v).toMatchObject({ canMerge: false, showMerge: true })
    expect(v?.blockReason).toMatch(/conflict/i)
    conflicting.flow.merge()
    expect(conflicting.flow.state().kind).toBe('confirm')
    expect(conflicting.calls).toHaveLength(1)

    // Failing or pending checks are shown, and Merge stays enabled.
    for (const checks of ['fail', 'pending'] as const) {
      const t = await atConfirm({ checks })
      const w = confirmView(t.flow.state())
      expect(w, checks).toMatchObject({ canMerge: true })
      expect(w?.blockReason, checks).toBeUndefined()
      expect(w?.checks).toEqual(checks === 'fail' ? { cls: 's-bad', label: 'checks fail' } : { cls: 's-run', label: 'checks pending' })
    }
    expect(confirmView((await atConfirm({ checks: 'pass' })).flow.state())?.checks).toEqual({ cls: 's-ok', label: 'checks pass' })
    expect(confirmView((await atConfirm({ checks: 'none' })).flow.state())?.checks).toEqual({ cls: 's-idle', label: 'no checks' })

    // Unknown mergeability lets GitHub decide; a PR merged or closed elsewhere can't be merged.
    expect(confirmView((await atConfirm({ mergeable: 'unknown' })).flow.state())).toMatchObject({ canMerge: true })
    for (const state of ['merged', 'closed'] as const) {
      const w = confirmView((await atConfirm({ state })).flow.state())
      expect(w, state).toMatchObject({ canMerge: false })
      expect(w?.blockReason, state).toMatch(state === 'merged' ? /already merged/i : /closed/i)
    }

    // The confirm shows the title, mergeability words, and the short head sha.
    const shown = confirmView((await atConfirm()).flow.state())
    expect(shown).toMatchObject({ title: 'Wave 2 of merge-actions', sha: 'aaaaaaa', mergeability: 'No conflicts' })
  })

  it('client errors are shown', async () => {
    const messages = ['Actions need a page reload.', 'The board restarted. Reload the page.', "Can't reach the board.", 'gh unavailable']
    for (const message of messages) {
      // A failed preview shows the message, with Try again.
      const t = setup()
      t.flow.open(A)
      await t.answer(0, { ok: false, status: 0, message })
      expect(t.flow.state()).toMatchObject({ kind: 'error', target: A, message })
      expect(confirmView(t.flow.state())).toMatchObject({ error: message, tryAgain: true, showMerge: false, cancelDisabled: false })
      t.flow.retry()
      expect(t.flow.state().kind).toBe('loading')
      expect(t.calls[1]?.path).toBe('merge-preview')
    }

    // A failed merge request also shows its message, and Try again reads the PR afresh
    // instead of sending the merge again (the first one may have run).
    const m = await atConfirm()
    m.flow.merge()
    await m.answer(1, { ok: false, status: 0, message: "Can't reach the board." })
    expect(confirmView(m.flow.state())).toMatchObject({ error: "Can't reach the board.", tryAgain: true })
    m.flow.retry()
    expect(m.calls[2]?.path).toBe('merge-preview')
    expect(m.calls.filter((c) => c.path === 'merge')).toHaveLength(1)

    // Escape and Cancel close an error.
    m.flow.key('Escape')
    expect(m.flow.state().kind).toBe('idle')
  })

  it('closes on merged only when asked', async () => {
    // With onMerged: a merged reply calls it once, with the PR and the time, and the panel closes with no result.
    const merged: [number, number][] = []
    const t = await atConfirm({}, (n, at) => merged.push([n, at]))
    t.flow.merge()
    const before = t.seen.length
    await t.answer(1, ok(result('merged')))
    expect(merged).toEqual([[41, AT]])
    expect(t.flow.state().kind).toBe('idle')
    expect(confirmView(t.flow.state())).toBeUndefined()
    // It goes straight to idle: no result state flashes on the way.
    expect(t.seen.slice(before).map((s) => s.kind)).toEqual(['idle'])
    // Not logged closes the same way: the card's item carries no note for a merge.
    const u = await atConfirm({}, (n, at) => merged.push([n, at]))
    u.flow.merge()
    await u.answer(1, ok(result('merged', { logged: false })))
    expect(u.flow.state().kind).toBe('idle')
    expect(merged).toHaveLength(2)
    // The flow works on after it closed: the next open reads the PR again.
    t.flow.open(B)
    expect(t.flow.state()).toMatchObject({ kind: 'loading', target: B })
    expect(merged).toHaveLength(2)

    // Without it (the Waiting tab): today's result, with Merged and Close.
    const w = await atConfirm()
    w.flow.merge()
    await w.answer(1, ok(result('merged')))
    expect(w.flow.state()).toMatchObject({ kind: 'result', target: A })
    expect(confirmView(w.flow.state())).toMatchObject({ result: { words: 'Merged' }, closeLabel: 'Close' })
  })

  it('other outcomes keep the panel', async () => {
    const merged: number[] = []
    for (const outcome of ['queued', 'auto-merge', 'stale', 'failed', 'unconfirmed'] as const) {
      const t = await atConfirm({}, (n) => merged.push(n))
      t.flow.merge()
      await t.answer(1, ok(result(outcome)))
      expect(t.flow.state().kind, outcome).toBe('result')
      expect(confirmView(t.flow.state())?.result?.words, outcome).not.toBe('Merged')
    }
    // A failed request keeps its error and Try again.
    const e = await atConfirm({}, (n) => merged.push(n))
    e.flow.merge()
    await e.answer(1, { ok: false, status: 0, message: "Can't reach the board." })
    expect(confirmView(e.flow.state())).toMatchObject({ error: "Can't reach the board.", tryAgain: true })
    // A late merged reply for a merge you can no longer see is dropped, and calls nothing.
    const late = await atConfirm({}, (n) => merged.push(n))
    late.flow.merge()
    expect(late.flow.state().kind).toBe('merging')
    expect(merged).toEqual([])
    // Check again after stale, then merged: it closes then, once.
    const s = await atConfirm({}, (n) => merged.push(n))
    s.flow.merge()
    await s.answer(1, ok(result('stale', { headSha: NEW_SHA })))
    s.flow.retry()
    await s.answer(2, ok(preview({ headSha: NEW_SHA })))
    s.flow.merge()
    await s.answer(3, ok(result('merged')))
    expect(merged).toEqual([41])
    expect(s.flow.state().kind).toBe('idle')
  })
})
