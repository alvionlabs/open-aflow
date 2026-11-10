import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NewActionEntry } from '@openaflow/model'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ACTION_LOG_MAX, createActionLog } from './action-log.ts'

let root: string
let file: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openaflow-m1-log-'))
  file = join(root, 'actions.jsonl')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const entry = (n: number, over: { result?: 'merged' | 'failed' | 'stale'; message?: string } = {}): NewActionEntry => ({
  action: 'merge',
  repoId: 'id-r',
  repo: 'r',
  target: `PR #${n}`,
  result: 'merged',
  ...over,
})

const answer = (result: 'answered' | 'changed' | 'failed', message?: string): NewActionEntry => ({
  action: 'answer',
  repoId: 'id-r',
  repo: 'r',
  target: '2026-10-21 · PENDING · engineer → human',
  result,
  ...(message === undefined ? {} : { message }),
})

describe('action log', () => {
  test('reads and appends the log', async () => {
    // A missing file is an empty list, and nothing is created until the first append.
    let t = 1000
    const log = createActionLog({ file, now: () => t })
    expect(log.recent()).toEqual([])
    await expect(stat(file)).rejects.toThrow()

    expect(await log.append(entry(7, { result: 'failed', message: 'not mergeable' }))).toBe(true)
    t = 2000
    expect(await log.append(entry(8))).toBe(true)
    const lines = (await readFile(file, 'utf8')).split('\n')
    expect(lines).toEqual([
      JSON.stringify({ at: 1000, action: 'merge', repoId: 'id-r', repo: 'r', target: 'PR #7', result: 'failed', message: 'not mergeable' }),
      JSON.stringify({ at: 2000, action: 'merge', repoId: 'id-r', repo: 'r', target: 'PR #8', result: 'merged' }),
      '',
    ])
    expect(log.recent().map((e) => [e.at, e.target])).toEqual([
      [2000, 'PR #8'],
      [1000, 'PR #7'],
    ])

    // The newest 50, newest first, skipping bad lines.
    const good = Array.from({ length: 60 }, (_, i) => JSON.stringify({ at: i, ...entry(i) }))
    const bad = ['', 'not json', '[]', 'null', '{"at":"x","action":"merge"}', JSON.stringify({ at: 99, ...entry(99), result: 'exploded' }), JSON.stringify({ at: 98, ...entry(98), action: 'delete' })]
    await writeFile(file, [...good.slice(0, 30), ...bad, ...good.slice(30), '{"at":12'].join('\n'))
    const read = createActionLog({ file, now: () => t }).recent()
    expect(ACTION_LOG_MAX).toBe(50)
    expect(read).toHaveLength(50)
    expect(read[0]?.at).toBe(59)
    expect(read[49]?.at).toBe(10)
    expect(read.every((e) => e.result === 'merged' && e.action === 'merge')).toBe(true)

    // Answer entries append and read back, beside old merge lines; a mixed-up or unknown action or result is skipped.
    const mixed = createActionLog({ file: join(root, 'mixed.jsonl'), now: () => 7 })
    expect(await mixed.append(answer('answered'))).toBe(true)
    expect(await mixed.append(answer('changed', 'The entry changed since you looked.'))).toBe(true)
    const oldMerge = JSON.stringify({ at: 1, action: 'merge', repoId: 'id-r', repo: 'r', target: 'PR #3', result: 'stale', message: 'head now bbbbbbb' })
    const skipped = [
      JSON.stringify({ at: 2, ...answer('answered'), result: 'merged' }),
      JSON.stringify({ at: 3, ...entry(4), result: 'answered' }),
      JSON.stringify({ at: 4, ...answer('answered'), action: 'reply' }),
      JSON.stringify({ at: 5, ...answer('answered'), result: 'saved' }),
      JSON.stringify({ at: 6, ...answer('answered'), message: 9 }),
    ]
    const mixedText = await readFile(join(root, 'mixed.jsonl'), 'utf8')
    await writeFile(join(root, 'mixed.jsonl'), [oldMerge, ...skipped, mixedText].join('\n'))
    expect(createActionLog({ file: join(root, 'mixed.jsonl'), now: () => 8 }).recent()).toEqual([
      { at: 7, ...answer('changed', 'The entry changed since you looked.') },
      { at: 7, ...answer('answered') },
      { at: 1, action: 'merge', repoId: 'id-r', repo: 'r', target: 'PR #3', result: 'stale', message: 'head now bbbbbbb' },
    ])

    // The list stays at 50 after more appends.
    const capped = createActionLog({ file, now: () => 100 })
    await capped.append(entry(100))
    expect(capped.recent()).toHaveLength(50)
    expect(capped.recent()[0]?.target).toBe('PR #100')
    // The cut-short last line didn't swallow the new entry.
    expect(createActionLog({ file, now: () => 100 }).recent()[0]?.target).toBe('PR #100')
  })

  test('reads resolve entries (Close and Keep)', async () => {
    const resolve = (result: string): Record<string, unknown> => ({ action: 'resolve', repoId: 'id-r', repo: 'r', target: '2026-10-20 · BLOCKED · orchestrator → human', result })
    const file = join(root, 'resolve.jsonl')
    await writeFile(file, [{ at: 1, ...resolve('closed') }, { at: 2, ...resolve('kept') }, { at: 3, ...resolve('answered') }, { at: 4, ...resolve('changed') }].map((e) => JSON.stringify(e)).join('\n'))
    expect(createActionLog({ file, now: () => 5 }).recent().map((e) => [e.at, e.action, e.result])).toEqual([
      [4, 'resolve', 'changed'],
      [2, 'resolve', 'kept'],
      [1, 'resolve', 'closed'],
    ])
  })

  test('reads remove-repo entries', async () => {
    const remove = (result: string): Record<string, unknown> => ({ action: 'remove-repo', repoId: 'id-r', repo: 'r', target: '/x/r', result })
    const file = join(root, 'remove.jsonl')
    await writeFile(file, [{ at: 1, ...remove('removed') }, { at: 2, ...remove('merged') }, { at: 3, ...remove('failed'), message: 'config unwritable' }].map((e) => JSON.stringify(e)).join('\n'))
    expect(createActionLog({ file, now: () => 5 }).recent()).toEqual([
      { at: 3, action: 'remove-repo', repoId: 'id-r', repo: 'r', target: '/x/r', result: 'failed', message: 'config unwritable' },
      { at: 1, action: 'remove-repo', repoId: 'id-r', repo: 'r', target: '/x/r', result: 'removed' },
    ])
  })

  test('reads resume entries', async () => {
    const resume = (result: 'started' | 'failed', auto: boolean, message?: string): NewActionEntry => ({
      action: 'resume',
      repoId: 'id-r',
      repo: 'r',
      target: 'alpha · continue',
      result,
      reply: 'continue',
      auto,
      ...(message === undefined ? {} : { message }),
    })
    const first = createActionLog({ file, now: () => 3 })
    expect(await first.append(resume('started', false))).toBe(true)
    expect(await first.append(resume('failed', true, 'claude not found'))).toBe(true)
    const ok = { at: 4, ...resume('started', true), reply: 'go', target: 'alpha · go' }

    const oldMerge = JSON.stringify({ at: 1, ...entry(3, { result: 'stale' }) })
    const oldAnswer = JSON.stringify({ at: 2, ...answer('answered') })
    const skipped = [
      JSON.stringify({ at: 5, ...resume('started', false), result: 'merged' }),
      JSON.stringify({ at: 6, ...resume('started', false), result: 'answered' }),
      JSON.stringify({ at: 7, ...resume('started', false), reply: 'try' }),
      JSON.stringify({ at: 8, ...resume('started', false), reply: undefined }),
      JSON.stringify({ at: 9, ...resume('started', false), auto: 'yes' }),
      JSON.stringify({ at: 10, ...resume('started', false), auto: undefined }),
      JSON.stringify({ at: 11, ...entry(4), result: 'started' }),
    ]
    const text = await readFile(file, 'utf8')
    await writeFile(file, [oldMerge, oldAnswer, text.trimEnd(), JSON.stringify(ok), ...skipped, ''].join('\n'))

    // After a restart: resume lines read back, beside old merge and answer lines.
    expect(createActionLog({ file, now: () => 20 }).recent()).toEqual([
      ok,
      { at: 3, ...resume('failed', true, 'claude not found') },
      { at: 3, ...resume('started', false) },
      { at: 2, ...answer('answered') },
      { at: 1, ...entry(3, { result: 'stale' }) },
    ])
  })

  test('an append that fails reports false and keeps the list', async () => {
    // The log's folder is a file, so the append can't write.
    await writeFile(join(root, 'blocker'), '')
    const log = createActionLog({ file: join(root, 'blocker', 'actions.jsonl'), now: () => 1 })
    expect(await log.append(entry(7))).toBe(false)
    expect(log.recent()).toEqual([])
  })

  test('log survives restart', async () => {
    await mkdir(root, { recursive: true })
    const first = createActionLog({ file, now: () => 5 })
    await first.append(entry(7, { result: 'stale', message: 'head now bbbbbbb' }))
    const second = createActionLog({ file, now: () => 6 })
    expect(second.recent()).toEqual([{ at: 5, ...entry(7, { result: 'stale', message: 'head now bbbbbbb' }) }])
    await second.append(entry(8))
    expect(createActionLog({ file, now: () => 7 }).recent().map((e) => e.target)).toEqual(['PR #8', 'PR #7'])
  })
})
