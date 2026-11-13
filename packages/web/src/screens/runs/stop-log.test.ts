import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MergeResult, ResumeResult } from '@openaflow/model'
import type { ActionReply } from '../../actions-client.ts'
import { createMergeFlow, type Post } from './merge-flow.ts'
import type { NextItem } from './next-step.ts'
import { NOT_LOGGED, createResumeFlow, startedText } from './resume-flow.ts'
import { StopList } from '../../components/StopList.tsx'
import { ReplyPanel } from './ReplyPanel.tsx'
import { EMPTY_LOG, FOCUS_PRIMARY, SEND_HOLD_MS, cardPanel, holdEndsIn, logCard, logHoldEnd, FOCUS_TITLE, focusAfterMerge, logMerged, logRunState, logSent, stopView, type StopLog } from './stop-log.ts'

// Local times, so HH:MM reads the same in any time zone.
const AT_1203 = new Date(2026, 10, 13, 12, 3, 41).getTime()
const AT_1205 = new Date(2026, 10, 13, 12, 5).getTime()
const AT_0907 = new Date(2026, 10, 13, 9, 7).getTime()
const RESUME = 'claude --resume 0f6c1e2a-5b7d'

const mergeCard = (number: number): NextItem => ({
  key: `pr:${number}`,
  tier: 'merge',
  status: 'needs-you',
  title: `Merge PR #${number}`,
  action: { kind: 'merge', repoId: 'r', number },
})
const replyCard = (send: 'continue' | 'go' | undefined, title = 'Send continue'): NextItem => ({
  key: 'reply:alpha',
  tier: 'reply',
  status: 'ready',
  title,
  action: {
    kind: 'reply',
    panel: {
      target: { repoId: 'r', run: 'alpha' },
      rows: [
        { key: 'try', word: 'try', why: 'Try the next slice.' },
        { key: 'x', word: send ?? 'continue', why: 'pod waits for it.', ...(send ? { send } : {}) },
      ],
    },
  },
})
const answerCard: NextItem = {
  key: 'entry:a',
  tier: 'blocked',
  status: 'blocked',
  title: 'Pick the step size.',
  action: { kind: 'answer', repoId: 'r', line: 'a' },
}

const started = (over: Partial<ResumeResult> = {}): ResumeResult => ({ outcome: 'started', logged: true, ...over })
const shown = (log: StopLog, card: NextItem) => stopView(log, card).items.map((i) => ({ label: i.label, time: i.time, state: i.state, ...(i.note ? { note: i.note } : {}) }))

type Call = { path: string; resolve: (r: ActionReply<unknown>) => void }
function fakePost() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string) => new Promise<ActionReply<T>>((resolve) => calls.push({ path, resolve: resolve as (r: ActionReply<unknown>) => void }))
  return { calls, post }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const ok = <T,>(data: T): ActionReply<T> => ({ ok: true, data })
const PREVIEW = { number: 12, url: 'u', title: 't', headSha: 'a'.repeat(40), state: 'open', checks: 'pass', mergeable: 'mergeable', mergeState: 'CLEAN' } as const

describe('stop log', () => {
  it('merged item', () => {
    const log = logMerged(EMPTY_LOG, 12, AT_1203)
    // Once the Board moved the card on to the reply: the merge, then the reply's button.
    expect(shown(log, replyCard('continue'))).toEqual([
      { label: 'Merged PR #12', time: '12:03', state: 'done' },
      { label: 'Continue', time: '', state: 'current' },
    ])
    expect(stopView(log, replyCard('continue')).hideMerge).toBe(false)
    expect(shown(log, replyCard('go')).at(-1)?.label).toBe('Go')
    // A reply with no send button, or another card: the card's title.
    expect(shown(log, replyCard(undefined, 'Reply continue in the chat')).at(-1)?.label).toBe('Reply continue in the chat')
    expect(shown(log, answerCard).at(-1)?.label).toBe('Pick the step size.')
    // Another PR to merge next: its own Merge stays.
    expect(shown(log, mergeCard(13)).at(-1)?.label).toBe('Merge PR #13')
    expect(stopView(log, mergeCard(13)).hideMerge).toBe(false)
    // HH:MM is local and zero-padded; each item keeps its own key.
    const two = logMerged(log, 13, AT_0907)
    expect(shown(two, replyCard('continue')).map((i) => `${i.label} ${i.time}`)).toEqual(['Merged PR #12 12:03', 'Merged PR #13 09:07', 'Continue '])
    const keys = stopView(two, replyCard('continue')).items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    // The log isn't changed in place.
    expect(EMPTY_LOG.done).toEqual([])
  })

  it('before the Board catches up', () => {
    const log = logMerged(EMPTY_LOG, 12, AT_1203)
    // The card still names the merged PR: the current item waits for the Board, and that Merge is hidden.
    expect(stopView(log, mergeCard(12))).toMatchObject({ hideMerge: true })
    expect(shown(log, mergeCard(12))).toEqual([
      { label: 'Merged PR #12', time: '12:03', state: 'done' },
      { label: 'Updating…', time: '', state: 'current' },
    ])
    // Merge on a card with no merged PR in the list shows as usual.
    expect(stopView(EMPTY_LOG, mergeCard(12)).hideMerge).toBe(false)
  })

  it('sent item', () => {
    const log = logSent(EMPTY_LOG, 'continue', AT_1205, started(), RESUME)
    // The run hasn't read running yet, so the card may still show the reply: the current item is pod's turn.
    expect(shown(log, replyCard('continue'))).toEqual([
      { label: 'Sent continue', time: '12:05', state: 'done', note: startedText(RESUME) },
      { label: 'pod runs', time: '', state: 'current' },
    ])
    expect(shown(logSent(EMPTY_LOG, 'go', AT_1205, started(), undefined), answerCard)[0]).toEqual({
      label: 'Sent go',
      time: '12:05',
      state: 'done',
      note: startedText(undefined),
    })
    // Not logged adds the note to the same item.
    expect(shown(logSent(EMPTY_LOG, 'continue', AT_1205, started({ logged: false }), RESUME), replyCard('continue'))[0]?.note).toBe(
      `${startedText(RESUME)} ${NOT_LOGGED}`,
    )
    // After a merge: both, in order, and pod runs is the current item.
    const both = logSent(logMerged(EMPTY_LOG, 12, AT_1203), 'continue', AT_1205, started(), RESUME)
    expect(shown(both, replyCard('continue')).map((i) => i.label)).toEqual(['Merged PR #12', 'Sent continue', 'pod runs'])
  })

  it('only results that happened', async () => {
    // A failed start adds nothing, logged or not.
    expect(logSent(EMPTY_LOG, 'continue', AT_1205, { outcome: 'failed', message: 'x', logged: true })).toEqual(EMPTY_LOG)
    expect(logSent(EMPTY_LOG, 'go', AT_1205, { outcome: 'failed', logged: false })).toEqual(EMPTY_LOG)

    // Through the card's flows: only a merged merge and a started send reach the log.
    let log = EMPTY_LOG
    const mergeWith = async (reply: ActionReply<MergeResult>) => {
      const p = fakePost()
      const flow = createMergeFlow(() => {}, p.post, { onMerged: (n, at) => (log = logMerged(log, n, at)), now: () => AT_1203 })
      flow.open({ repoId: 'r', number: 12 })
      p.calls[0]!.resolve(ok(PREVIEW))
      await tick()
      flow.merge()
      p.calls[1]!.resolve(reply)
      await tick()
    }
    for (const outcome of ['queued', 'auto-merge', 'stale', 'failed', 'unconfirmed'] as const) await mergeWith(ok({ outcome, number: 12, logged: true }))
    await mergeWith({ ok: false, status: 0, message: "Can't reach the board." })
    const sendWith = async (reply: ActionReply<ResumeResult>) => {
      const p = fakePost()
      const flow = createResumeFlow({ repoId: 'r', run: 'alpha' }, () => {}, p.post, { onSent: (w, at, r) => (log = logSent(log, w, at, r, RESUME)), now: () => AT_1205 })
      flow.press('continue')
      p.calls[0]!.resolve(reply)
      await tick()
    }
    await sendWith(ok({ outcome: 'failed', logged: true }))
    await sendWith({ ok: false, status: 409, message: 'session is busy' })
    expect(stopView(log, replyCard('continue')).items).toEqual([])

    // The same paths with a result that happened do add: the checks above aren't empty by accident.
    await mergeWith(ok({ outcome: 'merged', number: 12, logged: true }))
    await sendWith(ok(started()))
    expect(shown(log, replyCard('continue')).map((i) => i.label)).toEqual(['Merged PR #12', 'Sent continue', 'pod runs'])
  })

  it('resets at a new stop', () => {
    let log = logRunState(EMPTY_LOG, 'needs-you')
    log = logMerged(log, 12, AT_1203)
    log = logSent(log, 'continue', AT_1205, started(), RESUME)
    // Still needs-you (the Board hasn't caught up), then running: the list stays.
    log = logRunState(log, 'needs-you')
    expect(log.done).toHaveLength(2)
    log = logRunState(log, 'running')
    log = logRunState(log, 'running')
    expect(log.done).toHaveLength(2)
    // The first Board where the run leaves running starts a new stop: the list is empty.
    log = logRunState(log, 'needs-you')
    expect(log.done).toEqual([])
    expect(stopView(log, replyCard('continue')).items).toEqual([])
    // A merge at that new stop shows, and later Boards that stay needs-you keep it.
    log = logRunState(logMerged(log, 13, AT_0907), 'needs-you')
    expect(log.done.map((d) => d.label)).toEqual(['Merged PR #13'])
    // Any state out of running counts: blocked, idle, error.
    for (const state of ['blocked', 'idle', 'error'] as const) {
      const l = logRunState(logRunState(logMerged(EMPTY_LOG, 1, AT_0907), 'running'), state)
      expect(l.done, state).toEqual([])
    }
    // A Board with no change gives the same log back, so the card doesn't draw again.
    expect(logRunState(log, 'needs-you')).toBe(log)
  })

  it('hidden when empty', () => {
    // No done item: no list at all, also no current item.
    for (const card of [replyCard('continue'), mergeCard(12), answerCard]) expect(stopView(EMPTY_LOG, card)).toEqual({ items: [], hideMerge: false })
    expect(stopView(logRunState(EMPTY_LOG, 'running'), replyCard('continue')).items).toEqual([])
    // One done item is enough for a list.
    expect(stopView(logMerged(EMPTY_LOG, 12, AT_1203), answerCard).items).toHaveLength(2)
  })

  it('the reply row names no PR the list shows merged', () => {
    const card = (why: string): NextItem => ({ ...replyCard('continue'), action: { kind: 'reply', panel: { target: { repoId: 'r', run: 'alpha' }, rows: [{ key: 'continue', word: 'continue', why, send: 'continue' }] } } })
    const whyOf = (log: StopLog, why: string) => cardPanel(log, card(why))!.rows[0]!.why
    const merged78 = logMerged(EMPTY_LOG, 78, AT_1203)
    // The model's wave-merged and fix-merged text, and its final-merged text with a tail.
    expect(whyOf(merged78, 'PR #78 merged.')).toBe('Continue so pod goes on.')
    expect(whyOf(merged78, 'PR #78 merged: pod cleans up.')).toBe('Continue so pod cleans up.')
    // Another PR, a PR whose number only starts the same, or no merge in the list: the model's text.
    expect(whyOf(logMerged(EMPTY_LOG, 7, AT_1203), 'PR #78 merged.')).toBe('PR #78 merged.')
    expect(whyOf(merged78, 'PR #7 merged.')).toBe('PR #7 merged.')
    expect(whyOf(EMPTY_LOG, 'PR #78 merged.')).toBe('PR #78 merged.')
    expect(whyOf(merged78, 'Sprint alpha is done.')).toBe('Sprint alpha is done.')
    // Only for the card: the panel the Waiting tab draws keeps the model's text.
    const c = card('PR #78 merged.')
    cardPanel(merged78, c)
    expect(c.action.kind === 'reply' && c.action.panel.rows[0]!.why).toBe('PR #78 merged.')
    expect(cardPanel(merged78, answerCard)).toBeUndefined()

    // Drawn as on the card: the list names the PR once, and the reply row doesn't.
    const html =
      renderToStaticMarkup(createElement(StopList, { items: stopView(merged78, c).items })) +
      renderToStaticMarkup(createElement(ReplyPanel, { view: cardPanel(merged78, c), target: { repoId: 'r', run: 'alpha' }, framed: false, onSent: () => {} }))
    expect(html.match(/#78/g)).toHaveLength(1)
    expect(html).toContain('Continue so pod goes on.')
    // The Waiting tab's panel, with no card in between: the model's text.
    const waiting = renderToStaticMarkup(createElement(ReplyPanel, { view: c.action.kind === 'reply' ? c.action.panel : undefined, target: { repoId: 'r', run: 'alpha' } }))
    expect(waiting).toContain('PR #78 merged.')
  })

  it('a started send hides its button until the run moves on', () => {
    const card = replyCard('continue')
    const from = { state: 'needs-you', card } as const
    const sendOf = (log: StopLog, c: NextItem = card) => cardPanel(log, c)!.rows.find((r) => r.word === 'continue')!.send
    const sent = logSent(EMPTY_LOG, 'continue', AT_1205, started(), RESUME, from)
    // The sent line replaces the button (pick 2 b): no send on the row, Copy stays.
    expect(sendOf(sent)).toBeUndefined()
    const html = renderToStaticMarkup(createElement(ReplyPanel, { view: cardPanel(sent, card), target: { repoId: 'r', run: 'alpha' }, framed: false, onSent: () => {} }))
    expect(html).not.toMatch(/>Continue<\/button>/)
    expect(html).toContain('aria-label="Copy continue"')
    expect(shown(sent, card).at(-1)?.label).toBe('pod runs')
    // Before the send, and after a failed one or one sent with no card to hold: the button.
    expect(sendOf(EMPTY_LOG)).toBe('continue')
    expect(sendOf(logSent(EMPTY_LOG, 'continue', AT_1205, { outcome: 'failed', logged: true }, RESUME, from))).toBe('continue')
    expect(sendOf(logSent(EMPTY_LOG, 'continue', AT_1205, started(), RESUME))).toBe('continue')
    // A Board with the same state keeps it hidden; the card isn't changed in place.
    expect(sendOf(logRunState(sent, 'needs-you'))).toBeUndefined()
    expect(card.action.kind === 'reply' && card.action.panel.rows[1]!.send).toBe('continue')

    // The run's state changes: the button is back, and stays back if the state goes back.
    const idle = logRunState(sent, 'idle')
    expect(sendOf(idle)).toBe('continue')
    expect(shown(idle, card).at(-1)?.label).toBe('Continue')
    expect(sendOf(logRunState(idle, 'needs-you'))).toBe('continue')
    // To running: pod runs stays the current item, and the next stop empties the list as before.
    const running = logRunState(sent, 'running')
    expect(shown(running, card).at(-1)?.label).toBe('pod runs')
    expect(logRunState(running, 'needs-you').hold).toBeUndefined()

    // A new stop with no state change: another card, or the row asks for another reason.
    const other = replyCard('continue')
    if (other.action.kind === 'reply') other.action.panel.rows[1]!.why = 'PR #79 merged.'
    expect(sendOf(sent, other)).toBe('continue')
    expect(sendOf(logCard(sent, other), card)).toBe('continue')
    expect(logCard(sent, card)).toBe(sent)
    expect(sendOf(logCard(sent, { ...card, key: 'reply:beta' }))).toBe('continue')
    // The Board drops the reply with no state change: no button came back, so it is still pod's turn.
    expect(shown(logCard(sent, answerCard), answerCard).at(-1)?.label).toBe('pod runs')
    expect(shown(logRunState(sent, 'blocked'), answerCard).at(-1)?.label).toBe('pod runs')
    expect(shown(logHoldEnd(sent, AT_1205), answerCard).at(-1)?.label).toBe('pod runs')
  })

  it('a send that never reads running gets its button back after 60 s', () => {
    const card = replyCard('continue')
    const sent = logSent(EMPTY_LOG, 'continue', AT_1205, started(), RESUME, { state: 'needs-you', card })
    // The card's timer waits out the rest of the 60 s from the send.
    expect(SEND_HOLD_MS).toBe(60_000)
    expect(holdEndsIn(sent, AT_1205)).toBe(60_000)
    expect(holdEndsIn(sent, AT_1205 + 59_000)).toBe(1_000)
    expect(holdEndsIn(sent, AT_1205 + 90_000)).toBe(0)
    expect(holdEndsIn(EMPTY_LOG, AT_1205)).toBeUndefined()
    // Then the button is back, and the list's current item names it again.
    const ended = logHoldEnd(sent, AT_1205)
    expect(cardPanel(ended, card)!.rows[1]!.send).toBe('continue')
    expect(shown(ended, card).map((i) => i.label)).toEqual(['Sent continue', 'Continue'])
    // An older timer leaves a newer send's hold alone.
    const again = logSent(ended, 'continue', AT_1205 + 120_000, started(), RESUME, { state: 'needs-you', card })
    expect(logHoldEnd(again, AT_1205)).toBe(again)
    expect(cardPanel(again, card)!.rows[1]!.send).toBeUndefined()
  })

  it('focusAfterMerge', () => {
    const button = { focus: vi.fn() }
    const title = { focus: vi.fn() }
    const root = (primary: typeof button | null, heading: typeof title | null = title) => ({
      querySelector: (sel: string) => (sel === FOCUS_PRIMARY ? primary : sel === FOCUS_TITLE ? heading : null),
    })
    const body = {}
    // Focus fell to the body with the closed panel (null when nothing holds it).
    const fell = { activeElement: body, body }
    // The card's primary button (Continue, once the Board moved on) when there is one.
    focusAfterMerge(root(button), fell)
    expect(button.focus).toHaveBeenCalledTimes(1)
    expect(title.focus).not.toHaveBeenCalled()
    // None (Merge hidden while the Board catches up, or a disabled one): the title.
    focusAfterMerge(root(null), { activeElement: null, body })
    expect(title.focus).toHaveBeenCalledTimes(1)
    // You moved on while it merged (an answer box, say): focus stays there, so a key press never lands on Continue.
    focusAfterMerge(root(button), { activeElement: {}, body })
    expect(button.focus).toHaveBeenCalledTimes(1)
    expect(title.focus).toHaveBeenCalledTimes(1)
    // The card left the page: nothing throws.
    expect(() => focusAfterMerge(null, fell)).not.toThrow()
    expect(() => focusAfterMerge(root(null, null), fell)).not.toThrow()
    // A disabled button never counts.
    expect(FOCUS_PRIMARY).toMatch(/:not\(:disabled\)/)
  })
})
