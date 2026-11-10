import { describe, expect, it } from 'vitest'
import type { ActionEntry, AnswerOutcome, MergeOutcome, ResumeOutcome } from '@openaflow/model'
import { ACTION_LOG_CAP, NO_ACTIONS, actionLogRows, outcomeChip } from './action-log-view.ts'

const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime()
const NOW = at(2026, 10, 21, 14, 30)

type MergeOver = Partial<Omit<Extract<ActionEntry, { action: 'merge' }>, 'action'>>

const entry = (over: MergeOver): ActionEntry => ({
  at: NOW,
  action: 'merge',
  repoId: 'r1',
  repo: 'chess-web',
  target: 'PR #41',
  result: 'merged',
  ...over,
})

describe('action log view', () => {
  it('action log rows', () => {
    // Time: HH:MM today, else MMM D HH:MM. "Today" is the local calendar day, so a minute
    // before midnight is yesterday.
    const rows = actionLogRows(
      [
        entry({ at: at(2026, 10, 21, 9, 5), target: 'PR #43' }),
        entry({ at: at(2026, 10, 21, 0, 1), target: 'PR #42' }),
        entry({ at: at(2026, 10, 20, 23, 59), target: 'PR #41', repo: 'ytb-feed', repoId: 'r2' }),
        entry({ at: at(2026, 1, 3, 7, 0), target: 'PR #2' }),
      ],
      NOW,
    )
    expect(rows.map((r) => [r.time, r.repo, r.target])).toEqual([
      ['09:05', 'chess-web', 'PR #43'],
      ['00:01', 'chess-web', 'PR #42'],
      ['Oct 20 23:59', 'ytb-feed', 'PR #41'],
      ['Jan 3 07:00', 'chess-web', 'PR #2'],
    ])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)

    // A result chip per outcome: merged ok; queued and auto-merge run; stale and unconfirmed you; failed bad.
    const cls: Record<MergeOutcome, string> = { merged: 's-ok', queued: 's-run', 'auto-merge': 's-run', stale: 's-you', unconfirmed: 's-you', failed: 's-bad' }
    for (const [result, want] of Object.entries(cls) as [MergeOutcome, string][]) {
      expect(outcomeChip(result), result).toEqual({ cls: want, label: result })
      expect(actionLogRows([entry({ result })], NOW)[0]!.chip).toEqual({ cls: want, label: result })
    }

    // Answer rows: answered ok, changed you, failed bad; the target is the entry's header.
    const answerCls: Record<AnswerOutcome, string> = { answered: 's-ok', changed: 's-you', failed: 's-bad' }
    for (const [result, want] of Object.entries(answerCls) as [AnswerOutcome, string][]) {
      const row = actionLogRows([{ at: NOW, action: 'answer', repoId: 'r1', repo: 'chess-web', target: '2026-10-21 · PENDING · engineer → human', result }], NOW)[0]!
      expect(row.chip, result).toEqual({ cls: want, label: result })
      expect(row.target).toBe('2026-10-21 · PENDING · engineer → human')
      expect(outcomeChip(result)).toEqual({ cls: want, label: result })
    }

    // Newest 20, newest first, even if the list comes unsorted or longer than 50.
    expect(ACTION_LOG_CAP).toBe(20)
    const many = Array.from({ length: 30 }, (_, i) => entry({ at: NOW - i * 60_000, target: `PR #${i}` })).reverse()
    const capped = actionLogRows(many, NOW)
    expect(capped).toHaveLength(20)
    expect(capped[0]!.target).toBe('PR #0')
    expect(capped[19]!.target).toBe('PR #19')

    // Two entries at the same time keep distinct keys.
    const same = actionLogRows([entry({}), entry({})], NOW)
    expect(same[0]!.key).not.toBe(same[1]!.key)

    // The empty text, for no entries and for a Board with no log at all.
    expect(NO_ACTIONS).toBe('No actions yet.')
    expect(actionLogRows([], NOW)).toEqual([])
    expect(actionLogRows(undefined, NOW)).toEqual([])
  })

  it('resume rows', () => {
    const resume = (result: ResumeOutcome, auto: boolean, reply: 'continue' | 'go' = 'continue'): ActionEntry => ({
      at: NOW,
      action: 'resume',
      repoId: 'r1',
      repo: 'chess-web',
      target: `alpha · ${reply}`,
      result,
      reply,
      auto,
    })
    // started ok, failed bad.
    const cls: Record<ResumeOutcome, string> = { started: 's-ok', failed: 's-bad' }
    for (const [result, want] of Object.entries(cls) as [ResumeOutcome, string][]) {
      expect(outcomeChip(result), result).toEqual({ cls: want, label: result })
      expect(actionLogRows([resume(result, false)], NOW)[0]!.chip).toEqual({ cls: want, label: result })
    }
    // The target reads <run> · <word>; an automatic one is marked auto in the text the list shows.
    expect(actionLogRows([resume('started', false)], NOW)[0]).toMatchObject({ target: 'alpha · continue', auto: false })
    expect(actionLogRows([resume('failed', true)], NOW)[0]).toMatchObject({ target: 'alpha · continue · auto', auto: true })
    expect(actionLogRows([resume('started', false, 'go')], NOW)[0]).toMatchObject({ target: 'alpha · go', auto: false })

    // Merge and answer rows are unchanged, and never marked auto.
    expect(actionLogRows([entry({ result: 'merged' })], NOW)[0]).toMatchObject({ target: 'PR #41', auto: false, chip: { cls: 's-ok', label: 'merged' } })
    const answer: ActionEntry = { at: NOW, action: 'answer', repoId: 'r1', repo: 'chess-web', target: '2026-10-21 · PENDING · engineer → human', result: 'answered' }
    expect(actionLogRows([answer], NOW)[0]).toMatchObject({ target: '2026-10-21 · PENDING · engineer → human', auto: false, chip: { cls: 's-ok', label: 'answered' } })

    // A mixed log keeps its order and distinct keys.
    const rows = actionLogRows([entry({ at: NOW - 2 }), resume('started', true), entry({ at: NOW - 1, target: 'PR #42' })], NOW)
    expect(rows.map((r) => r.target)).toEqual(['alpha · continue · auto', 'PR #42', 'PR #41'])
    expect(new Set(rows.map((r) => r.key)).size).toBe(3)
  })

  it('remove-repo rows', () => {
    const remove = (result: 'removed' | 'failed'): ActionEntry => ({ at: NOW, action: 'remove-repo', repoId: 'r1', repo: 'chess-web', target: 'C:/code/chess-web', result })
    expect(actionLogRows([remove('removed')], NOW)[0]).toMatchObject({ repo: 'chess-web', target: 'C:/code/chess-web', auto: false, chip: { cls: 's-ok', label: 'removed' } })
    expect(actionLogRows([remove('failed')], NOW)[0]!.chip).toEqual({ cls: 's-bad', label: 'failed' })
  })
})
