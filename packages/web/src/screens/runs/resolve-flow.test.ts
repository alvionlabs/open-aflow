import { describe, expect, it } from 'vitest'
import type { ResolveResult } from '@pod-board/model'
import { UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import type { Post } from './answer-flow.ts'
import { INITIAL_RESOLVE, busyLabel, createResolveFlow, reduceResolve, resolveAnchor, triageTarget, type ResolveState, type ResolveTarget } from './resolve-flow.ts'
import type { WaitingRow } from './queue-view.ts'

const CLOSE: ResolveTarget = { repoId: 'r1', line: '- [2026-10-20 · BLOCKED · orchestrator → human · plan: old] gate 1 (x): y **Resolution:** pending', kind: 'close' }
const KEEP: ResolveTarget = { repoId: 'r1', line: '- [2026-10-21 · PENDING · engineer → human] decision: z. Value in use: w. **Resolution:** pending', kind: 'keep' }

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

function setup() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string, body: object) =>
    new Promise<ActionReply<T>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  const seen: ResolveState[] = []
  const flow = createResolveFlow((s) => seen.push(s), post)
  const answer = async (i: number, reply: ActionReply<unknown>) => {
    calls[i]!.resolve(reply)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { flow, calls, seen, answer }
}

const ok = (outcome: ResolveResult['outcome'], over: Partial<ResolveResult> = {}): ActionReply<ResolveResult> => ({ ok: true, data: { outcome, logged: true, ...over } })

describe('Close and Keep', () => {
  it('sends only the repo, the line and the kind, and goes idle once written', async () => {
    const s = setup()
    s.flow.start(CLOSE)
    expect(s.flow.state()).toMatchObject({ kind: 'saving', target: CLOSE })
    expect(s.calls).toEqual([{ path: 'resolve', body: { repoId: 'r1', line: CLOSE.line, kind: 'close' }, resolve: expect.any(Function) }])
    await s.answer(0, ok('closed'))
    expect(s.flow.state().kind).toBe('idle')
  })

  it('busy: no second write while one saves, Keep or Close alike', () => {
    const s = setup()
    s.flow.start(CLOSE)
    s.flow.start(KEEP)
    s.flow.start(CLOSE)
    expect(s.calls).toHaveLength(1)
    expect(busyLabel(s.flow.state(), CLOSE)).toBe('Closing…')
    expect(busyLabel(s.flow.state(), KEEP)).toBeUndefined()
    expect(busyLabel({ kind: 'saving', seq: 1, target: KEEP }, KEEP)).toBe('Keeping…')
  })

  it('a stale line or a write failure shows its message inline, until dismissed or tried again', async () => {
    const s = setup()
    s.flow.start(KEEP)
    await s.answer(0, ok('changed', { message: 'The entry changed since you looked.' }))
    expect(s.flow.state()).toMatchObject({ kind: 'error', target: KEEP, message: 'The entry changed since you looked.' })
    s.flow.dismiss()
    expect(s.flow.state().kind).toBe('idle')

    s.flow.start(KEEP)
    await s.answer(1, ok('failed', { message: "Couldn't write the queue (EACCES)." }))
    expect(s.flow.state()).toMatchObject({ kind: 'error', message: "Couldn't write the queue (EACCES)." })
    // No message from the server: plain words.
    s.flow.start(CLOSE)
    await s.answer(2, ok('failed'))
    expect(s.flow.state()).toMatchObject({ kind: 'error', target: CLOSE, message: "Couldn't write the queue." })
    // The request itself failed (a 409 refusal, no API).
    s.flow.start(CLOSE)
    await s.answer(3, { ok: false, status: 409, message: 'The board no longer reads this entry as done.' })
    expect(s.flow.state()).toMatchObject({ kind: 'error', message: 'The board no longer reads this entry as done.' })
    s.flow.start(CLOSE)
    await s.answer(4, { ok: false, status: 0, message: UNREACHABLE })
    expect(s.flow.state()).toMatchObject({ kind: 'error', message: UNREACHABLE })
  })

  it('drops a reply for an older request', () => {
    const saving: ResolveState = { kind: 'saving', seq: 2, target: CLOSE }
    expect(reduceResolve(saving, { type: 'saved', seq: 1, reply: ok('failed') })).toBe(saving)
    expect(reduceResolve(INITIAL_RESOLVE, { type: 'saved', seq: 0, reply: ok('failed') })).toBe(INITIAL_RESOLVE)
    // Dismiss never stops a save.
    expect(reduceResolve(saving, { type: 'dismiss' })).toBe(saving)
  })

  it('the error sits under its row, or after the list once the row left', () => {
    const rows = [{ key: 'k1', line: CLOSE.line }, { key: 'k2', line: KEEP.line }] as WaitingRow[]
    const error: ResolveState = { kind: 'error', seq: 1, target: KEEP, message: 'x' }
    expect(resolveAnchor(error, rows, 'r1')).toBe('k2')
    expect(resolveAnchor(error, rows.slice(0, 1), 'r1')).toBe('end')
    expect(resolveAnchor(error, rows, 'other')).toBeUndefined()
    expect(resolveAnchor(INITIAL_RESOLVE, rows, 'r1')).toBeUndefined()
    // While saving there is nothing to show under the row: the button says what's happening.
    expect(resolveAnchor({ kind: 'saving', seq: 1, target: KEEP }, rows, 'r1')).toBeUndefined()
  })

  it('a row offers Close when done, else Keep with a value in use, else neither', () => {
    const row = (over: Partial<WaitingRow>) => ({ key: 'k', line: 'L', ...over }) as WaitingRow
    expect(triageTarget(row({ done: 'plan old is archived', keep: 'x' }), 'r1')).toEqual({ repoId: 'r1', line: 'L', kind: 'close' })
    expect(triageTarget(row({ keep: 'white' }), 'r1')).toEqual({ repoId: 'r1', line: 'L', kind: 'keep' })
    expect(triageTarget(row({}), 'r1')).toBeUndefined()
    expect(triageTarget(undefined, 'r1')).toBeUndefined()
  })
})
