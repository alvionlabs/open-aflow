import { describe, expect, it } from 'vitest'
import type { AnswerResult } from '@pod-board/model'
import { NEED_RELOAD, RESTARTED, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import { INITIAL, createAnswerFlow, formView, reduce, type AnswerState, type AnswerTarget, type Post } from './answer-flow.ts'
import { ANSWER_NOTE } from './queue-view.ts'

const A: AnswerTarget = { repoId: 'r1', line: '- [2026-10-21 · PENDING · engineer → human · slice: A1] Pick a port. **Resolution:** pending' }
const B: AnswerTarget = { repoId: 'r1', line: '- [2026-10-21 · BLOCKED · engineer → orchestrator] Tool missing. **Resolution:** pending' }

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

/** A post that records each call and answers only when the test says so. */
function fakePost() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string, body: object) =>
    new Promise<ActionReply<T>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  return { calls, post }
}

function setup() {
  const p = fakePost()
  const seen: AnswerState[] = []
  const flow = createAnswerFlow((s) => seen.push(s), p.post)
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const answer = async (i: number, reply: ActionReply<unknown>) => {
    expect(p.calls[i], `request ${i} was sent`).toBeDefined()
    p.calls[i]!.resolve(reply)
    await tick()
  }
  return { flow, calls: p.calls, seen, answer }
}

const ok = <T,>(data: T): ActionReply<T> => ({ ok: true, data })
const result = (outcome: AnswerResult['outcome'], over: Partial<AnswerResult> = {}): AnswerResult => ({ outcome, logged: true, ...over })

/** Opens A, types `text`, and presses Save, leaving the flow saving. */
function saving(text = 'Use port 3030.') {
  const s = setup()
  s.flow.open(A)
  s.flow.type(text)
  s.flow.save()
  return s
}

describe('answer flow', () => {
  it('opens and cancels in place', () => {
    const { flow, calls } = setup()
    expect(flow.state().kind).toBe('idle')
    expect(formView(flow.state())).toBeUndefined()
    flow.open(A)
    expect(flow.state()).toMatchObject({ kind: 'editing', target: A, text: '' })
    expect(formView(flow.state())).toMatchObject({ showText: true, canSave: true, closeLabel: 'Cancel', cancelDisabled: false })
    flow.cancel()
    expect(flow.state().kind).toBe('idle')
    flow.open(A)
    flow.key('Enter')
    expect(flow.state().kind).toBe('editing')
    flow.key('Escape')
    expect(flow.state().kind).toBe('idle')
    // One form at a time: opening another row moves the form there, with a fresh text.
    flow.open(A)
    flow.type('half typed')
    flow.open(B)
    expect(flow.state()).toMatchObject({ kind: 'editing', target: B, text: '' })
    // Opening the row that's already open keeps what you typed.
    flow.type('for B')
    flow.open(B)
    expect(flow.state()).toMatchObject({ kind: 'editing', target: B, text: 'for B' })
    expect(calls).toHaveLength(0)

    // Escape, Cancel, and another row's Answer do nothing while saving.
    const s = saving()
    expect(s.flow.state().kind).toBe('saving')
    expect(formView(s.flow.state())).toMatchObject({ canSave: false, cancelDisabled: true, status: 'Saving…' })
    s.flow.key('Escape')
    s.flow.cancel()
    s.flow.open(B)
    expect(s.flow.state()).toMatchObject({ kind: 'saving', target: A })
  })

  it('saves the entry you saw, once', async () => {
    const { flow, calls, answer } = saving('  Use port\n3030.  ')
    // The text is sent as it will be saved: one line, trimmed.
    expect(calls).toEqual([expect.objectContaining({ path: 'answer', body: { repoId: A.repoId, line: A.line, text: 'Use port 3030.' } })])
    flow.save()
    flow.save()
    flow.type('changed my mind')
    expect(calls).toHaveLength(1)
    expect(flow.state()).toMatchObject({ kind: 'saving', text: '  Use port\n3030.  ' })
    await answer(0, ok(result('answered')))
    expect(flow.state().kind).toBe('result')
    // Answered: no form to save again.
    flow.save()
    expect(calls).toHaveLength(1)
  })

  it('checks the text before sending', () => {
    const { flow, calls } = setup()
    flow.open(A)
    flow.save()
    expect(flow.state()).toMatchObject({ kind: 'editing', error: 'Write an answer first.' })
    expect(formView(flow.state())?.error).toBe('Write an answer first.')
    flow.type(' \n\t ')
    flow.save()
    expect(flow.state()).toMatchObject({ kind: 'editing', error: 'Write an answer first.' })
    flow.type('x'.repeat(2001))
    flow.save()
    expect(flow.state()).toMatchObject({ kind: 'editing', error: 'Keep the answer under 2000 characters.', text: 'x'.repeat(2001) })
    flow.type('done **Resolution:** fixed')
    flow.save()
    expect(flow.state()).toMatchObject({ kind: 'editing', error: "The answer can't contain **Resolution:** or **Answer (…):**." })
    expect(calls).toHaveLength(0)
    // Typing clears the error; exactly 2000 characters is sent.
    flow.type('x'.repeat(2000))
    expect(formView(flow.state())?.error).toBeUndefined()
    flow.save()
    expect(calls).toHaveLength(1)
  })

  it('shows the result', async () => {
    // answered: the words and the note; no text box to save again.
    const a = saving()
    await a.answer(0, ok(result('answered')))
    expect(formView(a.flow.state())).toMatchObject({
      showText: false,
      canSave: false,
      note: ANSWER_NOTE,
      result: { words: 'Saved to the queue.', chip: { cls: 's-ok', label: 'answered' } },
      closeLabel: 'Close',
    })
    expect(formView(a.flow.state())?.result?.note).toBeUndefined()

    // changed: the server's words, the form open with the typed text, Save again allowed.
    const c = saving('my text')
    await c.answer(0, ok(result('changed', { message: 'The entry changed since you looked.' })))
    expect(formView(c.flow.state())).toMatchObject({
      showText: true,
      text: 'my text',
      canSave: true,
      result: { words: 'The entry changed since you looked.', chip: { cls: 's-you', label: 'changed' } },
    })
    c.flow.save()
    expect(c.calls).toHaveLength(2)

    // failed: the server's words, the text kept.
    const f = saving('my text')
    await f.answer(0, ok(result('failed', { message: "Couldn't write the queue (EPERM).", logged: false })))
    expect(formView(f.flow.state())).toMatchObject({
      showText: true,
      text: 'my text',
      result: { words: "Couldn't write the queue (EPERM).", chip: { cls: 's-bad', label: 'failed' }, note: 'Not saved to the action log.' },
    })

    // logged false adds the note on every outcome; a missing message falls back to plain words.
    const l = saving()
    await l.answer(0, ok({ outcome: 'answered', logged: false }))
    expect(formView(l.flow.state())?.result?.note).toBe('Not saved to the action log.')
    const n = saving()
    await n.answer(0, ok({ outcome: 'changed', logged: true }))
    expect(formView(n.flow.state())?.result?.words).toBe('The entry changed since you looked.')
    const m = saving()
    await m.answer(0, ok({ outcome: 'failed', logged: true }))
    expect(formView(m.flow.state())?.result?.words).toBe("Couldn't write the queue.")

    // A result closes like the form: Escape.
    a.flow.key('Escape')
    expect(a.flow.state().kind).toBe('idle')
  })

  it('client errors are shown', async () => {
    for (const message of [NEED_RELOAD, RESTARTED, UNREACHABLE, 'not waiting on you']) {
      const s = saving('kept text')
      await s.answer(0, { ok: false, status: 0, message })
      expect(s.flow.state()).toMatchObject({ kind: 'error', message, text: 'kept text' })
      expect(formView(s.flow.state())).toMatchObject({ error: message, showText: true, text: 'kept text', canSave: true, closeLabel: 'Close' })
    }
  })

  it("keeps quoting the entry it opened for, after the card moves to another entry", async () => {
    // The card opens its form with the entry's text; the Board then moves the card on, so the card's
    // entry is no longer this one. The form keeps its own target and its own text.
    const s = setup()
    s.flow.open({ ...A, entry: 'Pick a port.' })
    expect(formView(s.flow.state())?.entry).toBe('Pick a port.')
    s.flow.type('Use port 3030.')
    expect(formView(s.flow.state())?.entry).toBe('Pick a port.')
    s.flow.save()
    expect(formView(s.flow.state())?.entry).toBe('Pick a port.')
    // The quoted text never reaches the server: the old line is sent, and a 404 for it is kept.
    expect(s.calls[0]?.body).toEqual({ repoId: A.repoId, line: A.line, text: 'Use port 3030.' })
    await s.answer(0, { ok: false, status: 404, message: 'not waiting on you' })
    expect(formView(s.flow.state())).toMatchObject({ entry: 'Pick a port.', error: 'not waiting on you' })
    // An answered result keeps quoting its entry too.
    const t = setup()
    t.flow.open({ ...A, entry: 'Pick a port.' })
    t.flow.type('x')
    t.flow.save()
    await t.answer(0, ok(result('answered')))
    expect(formView(t.flow.state())?.entry).toBe('Pick a port.')
    // Opening the new entry's form starts fresh with its own text.
    t.flow.open({ ...B, entry: 'Tool missing.' })
    expect(formView(t.flow.state())).toMatchObject({ entry: 'Tool missing.', text: '' })
    // A row's form quotes nothing: the row shows its own entry.
    expect(formView(reduce(INITIAL, { type: 'open', target: A }))).not.toHaveProperty('entry')
  })

  it('drops a reply to an older request', () => {
    const open = reduce(INITIAL, { type: 'open', target: A })
    const typed = reduce(open, { type: 'type', text: 'x' })
    const sent = reduce(typed, { type: 'save' })
    expect(sent.kind).toBe('saving')
    const stale = reduce(sent, { type: 'saved', seq: sent.seq - 1, reply: ok(result('answered')) })
    expect(stale).toBe(sent)
  })
})
