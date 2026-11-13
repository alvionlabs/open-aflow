import { describe, expect, it } from 'vitest'
import type { Board, ResumeResult, RunSummary } from '@openaflow/model'
import { NEED_RELOAD, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import {
  NOT_LOGGED,
  RESUME_FAILED,
  createResumeFlow,
  createToggleFlow,
  reduceResume,
  reduceToggle,
  resumeView,
  sendLabel,
  startedText,
  switchView,
  toggleView,
  type Post,
  type ResumeState,
  type ResumeWord,
  type RunTarget,
  type ToggleState,
} from './resume-flow.ts'

const T: RunTarget = { repoId: 'r1', run: 'alpha' }
const RESUME = 'claude --resume 0f6c1e2a-5b7d'

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

/** A post that records each call and answers only when the test says so. */
function fakePost() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string, body: object) =>
    new Promise<ActionReply<T>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  return { calls, post }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const ok = <T,>(data: T): ActionReply<T> => ({ ok: true, data })
const fail = (status: number, message: string): ActionReply<never> => ({ ok: false, status, message })

const runOf = (over: Partial<RunSummary> = {}): RunSummary => ({ repoId: 'r1', repo: 'r', plan: 'alpha', where: 'one · wave 1/1', state: 'needs-you', ...over })
const boardOf = (autoContinue?: Board['autoContinue']): Board => ({ generatedAt: 0, gh: 'ok', repos: [], ...(autoContinue ? { autoContinue } : {}) })

describe('auto-continue switch', () => {
  it('switch state from the Board', () => {
    const on = boardOf([{ repoId: 'r1', run: 'alpha' }])
    expect(switchView(runOf(), on)).toEqual({ on: true })
    // A fix run takes its claim name as its run.
    expect(switchView(runOf({ plan: 'fix-scroll', fix: 'scroll' }), boardOf([{ repoId: 'r1', run: 'fix-scroll' }]))).toEqual({ on: true })
    // Off when the run isn't in the list: another run, another repo with the same plan, or an empty list.
    expect(switchView(runOf(), boardOf([{ repoId: 'r1', run: 'beta' }]))).toEqual({ on: false })
    expect(switchView(runOf(), boardOf([{ repoId: 'r2', run: 'alpha' }]))).toEqual({ on: false })
    expect(switchView(runOf(), boardOf([]))).toEqual({ on: false })
    // Off when the field is absent (all off), or before the first Board.
    expect(switchView(runOf(), boardOf())).toEqual({ on: false })
    expect(switchView(runOf(), undefined)).toEqual({ on: false })
    // None for a repo row, or with no run selected.
    expect(switchView(runOf({ plan: undefined, where: 'no active plan', state: 'idle' }), on)).toBeUndefined()
    expect(switchView(undefined, on)).toBeUndefined()
  })

  it('toggle posts and reverts on failure', async () => {
    const p = fakePost()
    const seen: ToggleState[] = []
    const flow = createToggleFlow(T, (s) => seen.push(s), p.post)
    expect(toggleView(false, flow.state())).toEqual({ on: false, disabled: false })

    // Press: posts the flipped value, shows it, and is off while the request runs.
    flow.board(false)
    flow.press()
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0]).toMatchObject({ path: 'auto-continue', body: { repoId: 'r1', run: 'alpha', on: true } })
    expect(toggleView(false, flow.state())).toEqual({ on: true, disabled: true })
    // A second press while saving sends nothing.
    flow.press()
    expect(p.calls).toHaveLength(1)

    // It fails: back to the previous state, with the message.
    p.calls[0]!.resolve(fail(500, "Couldn't save the toggle."))
    await tick()
    expect(toggleView(false, flow.state())).toEqual({ on: false, disabled: false, error: "Couldn't save the toggle." })
    expect(flow.state()).toMatchObject({ kind: 'error', on: false })

    // The action client's own failures read the same way.
    flow.press()
    p.calls[1]!.resolve(fail(0, UNREACHABLE))
    await tick()
    expect(toggleView(false, flow.state())).toEqual({ on: false, disabled: false, error: UNREACHABLE })

    // Pressing again clears the message and sends again; this time it saves.
    flow.press()
    expect(toggleView(false, flow.state())).toEqual({ on: true, disabled: true })
    p.calls[2]!.resolve(ok({ on: true }))
    await tick()
    // The Board may lag the reply: the saved value shows until the Board agrees.
    expect(toggleView(false, flow.state())).toEqual({ on: true, disabled: false })
    flow.board(true)
    expect(flow.state().kind).toBe('idle')
    expect(toggleView(true, flow.state())).toEqual({ on: true, disabled: false })

    // Turning off posts on false.
    flow.press()
    expect(p.calls[3]).toMatchObject({ path: 'auto-continue', body: { repoId: 'r1', run: 'alpha', on: false } })
    // The Board already agrees when the reply lands (it was rebuilt before the response).
    flow.board(false)
    p.calls[3]!.resolve(ok({ on: false }))
    await tick()
    expect(flow.state().kind).toBe('idle')
    expect(toggleView(false, flow.state())).toEqual({ on: false, disabled: false })
    // Later the Board changes (another tab): the switch follows it.
    flow.board(true)
    expect(toggleView(true, flow.state()).on).toBe(true)
    expect(p.calls).toHaveLength(4)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('a failure reverts to the Board even when it flipped', async () => {
    // Off, pressed on, fails while the Board stays off: the switch reads off.
    const p = fakePost()
    const flow = createToggleFlow(T, () => {}, p.post)
    flow.board(true)
    flow.press()
    expect(p.calls[0]!.body).toEqual({ repoId: 'r1', run: 'alpha', on: false })
    p.calls[0]!.resolve(fail(404, 'not a run'))
    await tick()
    expect(toggleView(true, flow.state())).toEqual({ on: true, disabled: false, error: 'not a run' })
  })

  it('a reply for an older press is dropped', () => {
    // Not reachable through the switch (disabled while saving), but the reducer guards it.
    const saving: ToggleState = { kind: 'saving', seq: 2, on: true }
    expect(reduceToggle(saving, { type: 'reply', seq: 1, reply: fail(500, 'late'), boardOn: false })).toBe(saving)
    const saved: ToggleState = { kind: 'saved', seq: 2, on: true }
    expect(reduceToggle(saved, { type: 'reply', seq: 2, reply: fail(500, 'late'), boardOn: false })).toBe(saved)
    const sending: ResumeState = { kind: 'sending', seq: 3, word: 'continue' }
    expect(reduceResume(sending, { type: 'reply', seq: 2, reply: fail(409, 'late') })).toBe(sending)
    const result: ResumeState = { kind: 'result', seq: 3, word: 'continue', result: { outcome: 'started', logged: true } }
    expect(reduceResume(result, { type: 'reply', seq: 3, reply: fail(409, 'late') })).toBe(result)
  })

  it('never posts go or resume', async () => {
    const p = fakePost()
    const flow = createToggleFlow(T, () => {}, p.post)
    for (let i = 0; i < 4; i++) {
      flow.board(i % 2 === 0)
      flow.press()
      p.calls[i]!.resolve(ok({ on: i % 2 !== 0 }))
      await tick()
    }
    expect(p.calls.map((c) => c.path)).toEqual(['auto-continue', 'auto-continue', 'auto-continue', 'auto-continue'])
    for (const c of p.calls) expect(Object.keys(c.body).sort()).toEqual(['on', 'repoId', 'run'])
  })
})

describe('Continue and Go', () => {
  function setup() {
    const p = fakePost()
    const seen: ResumeState[] = []
    const flow = createResumeFlow(T, (s) => seen.push(s), p.post)
    return { flow, calls: p.calls, seen }
  }
  const started = (over: Partial<ResumeResult> = {}): ResumeResult => ({ outcome: 'started', logged: true, ...over })

  it('one send per press', async () => {
    const { flow, calls } = setup()
    expect(resumeView(flow.state(), RESUME)).toEqual({ busy: false })
    // Nothing is sent until a press.
    expect(calls).toHaveLength(0)
    flow.press('continue')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.objectContaining({ path: 'resume', body: { repoId: 'r1', run: 'alpha', reply: 'continue' } }))
    expect(resumeView(flow.state(), RESUME)).toMatchObject({ busy: true, word: 'continue', status: 'Sending continue…' })
    // A second press, of either button, while in flight sends nothing.
    flow.press('continue')
    flow.press('go')
    flow.close()
    expect(calls).toHaveLength(1)
    expect(flow.state().kind).toBe('sending')

    calls[0]!.resolve(ok(started()))
    await tick()
    expect(resumeView(flow.state(), RESUME)).toMatchObject({ busy: false, word: 'continue' })
    expect(flow.state()).toMatchObject({ kind: 'result', result: { outcome: 'started' } })

    // A new press after the result is a new send; Go sends go.
    flow.press('go')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual({ repoId: 'r1', run: 'alpha', reply: 'go' })
    calls[1]!.resolve(fail(409, 'resume in progress'))
    await tick()
    // Close clears the result.
    flow.close()
    expect(resumeView(flow.state(), RESUME)).toEqual({ busy: false })
  })

  it('result text', async () => {
    const { flow, calls } = setup()
    const send = async (reply: ActionReply<unknown>) => {
      flow.press('continue')
      calls[calls.length - 1]!.resolve(reply)
      await tick()
      return resumeView(flow.state(), RESUME)
    }

    // started → the started line, with the resume hint.
    const s = await send(ok(started()))
    expect(s.result).toEqual({ chip: { cls: 's-ok', label: 'started' }, words: startedText(RESUME) })
    expect(startedText(RESUME)).toBe(
      `The session started again. A terminal open on it won't show the board's send: run ${RESUME} to see it.`,
    )
    // No resume command known: the line without the hint.
    expect(startedText(undefined)).toBe("The session started again. A terminal open on it won't show the board's send.")
    expect(resumeView(flow.state(), undefined).result?.words).toBe(startedText(undefined))

    // failed → its message; no message → plain words.
    expect((await send(ok({ outcome: 'failed', message: 'claude not found', logged: true }))).result).toEqual({
      chip: { cls: 's-bad', label: 'failed' },
      words: 'claude not found',
    })
    expect((await send(ok({ outcome: 'failed', message: '  ', logged: true }))).result?.words).toBe(RESUME_FAILED)
    expect((await send(ok({ outcome: 'failed', logged: true }))).result?.words).toBe(RESUME_FAILED)
    expect(RESUME_FAILED).toBe("The session didn't start.")

    // Not logged → a note, whatever the outcome.
    expect((await send(ok(started({ logged: false })))).result?.note).toBe(NOT_LOGGED)
    expect((await send(ok({ outcome: 'failed', message: 'x', logged: false }))).result?.note).toBe(NOT_LOGGED)
    expect(NOT_LOGGED).toBe('Not saved to the action log.')

    // 409, 404, and the action client's own errors → their message, no result.
    for (const [status, message] of [
      [409, 'session is busy'],
      [409, 'resume in progress'],
      [404, 'not waiting on you'],
      [404, 'no session'],
      [404, 'HTTP 404'],
      [400, 'bad request'],
      [0, NEED_RELOAD],
      [0, UNREACHABLE],
    ] as const) {
      const v = await send(fail(status, message))
      expect(v, message).toEqual({ busy: false, word: 'continue', error: message })
    }
  })

  it('Sending label', async () => {
    const { flow, calls } = setup()
    const labels = () => {
      const v = resumeView(flow.state(), RESUME)
      return { busy: v.busy, continue: sendLabel(v, 'continue'), go: sendLabel(v, 'go') }
    }
    expect(labels()).toEqual({ busy: false, continue: 'Continue', go: 'Go' })
    // In flight: the pressed row reads Sending…, the other keeps its word, and every send button is off.
    flow.press('continue')
    expect(labels()).toEqual({ busy: true, continue: 'Sending…', go: 'Go' })
    calls[0]!.resolve(ok(started()))
    await tick()
    expect(labels()).toEqual({ busy: false, continue: 'Continue', go: 'Go' })
    flow.press('go')
    expect(labels()).toEqual({ busy: true, continue: 'Continue', go: 'Sending…' })
    // An error gives the word back.
    calls[1]!.resolve(fail(409, 'session is busy'))
    await tick()
    expect(labels()).toEqual({ busy: false, continue: 'Continue', go: 'Go' })
  })

  it('onSent takes the result; a started one leaves no result block', async () => {
    const p = fakePost()
    const sent: [ResumeWord, number, ResumeResult][] = []
    const flow = createResumeFlow(T, () => {}, p.post, { onSent: (w, at, r) => sent.push([w, at, r]), now: () => 42 })
    flow.press('continue')
    p.calls[0]!.resolve(ok(started({ logged: false })))
    await tick()
    expect(sent).toEqual([['continue', 42, { outcome: 'started', logged: false }]])
    // No result to show, and no word left: an empty slot draws nothing after the Board drops the reply.
    expect(flow.state().kind).toBe('idle')
    expect(resumeView(flow.state(), RESUME)).toEqual({ busy: false })
    // A failed start is passed on too, and keeps its result block, with Close.
    flow.press('go')
    p.calls[1]!.resolve(ok({ outcome: 'failed', message: 'claude not found', logged: true }))
    await tick()
    expect(sent[1]).toEqual(['go', 42, { outcome: 'failed', message: 'claude not found', logged: true }])
    expect(resumeView(flow.state(), RESUME)).toMatchObject({ word: 'go', result: { words: 'claude not found' } })
    // A refused request isn't a result: no call, and its error stays.
    flow.press('continue')
    p.calls[2]!.resolve(fail(404, 'no session'))
    await tick()
    expect(sent).toHaveLength(2)
    expect(resumeView(flow.state(), RESUME)).toMatchObject({ error: 'no session' })
  })
})
