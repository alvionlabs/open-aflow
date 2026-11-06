import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { nodeQueueFs, writeAnswer, writeResolution, type QueueFs } from './queue-writer.ts'

const ASK = '- `[2026-10-21 · PENDING · engineer → human · slice: A1]` Pick a name **Resolution:** pending'
const HALT = '- `[2026-10-21 · BLOCKED · orchestrator → human]` Gate 2 stopped **Resolution:** pending'
const NOTE = '- `[2026-10-20 · NOTE · engineer → orchestrator]` café ünïcode note **Resolution:** pending'
const ANSWERED = (line: string, text: string) => `${line} **Answer (human):** ${text}`

let root: string
let repo: string
let queue: string

beforeEach(async () => {
  // Resolved once, like the real realpath does: macOS temp is /var -> /private/var, Windows temp can be an 8.3 short name.
  // Fakes below build their targets from this, so the writer compares like with like.
  root = await realpath(await mkdtemp(join(tmpdir(), 'open-aflow-a1-writer-')))
  repo = join(root, 'repo')
  await mkdir(join(repo, 'pod-docs'), { recursive: true })
  queue = join(repo, 'pod-docs', 'handoff-queue.md')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const put = (bytes: string | Buffer) => writeFile(queue, bytes)
const bytes = () => readFile(queue)
const folder = () => readdir(join(repo, 'pod-docs'))

/** The node file calls, with hooks to run before a call goes through. */
function spyFs(hooks: Partial<Record<keyof QueueFs, (...args: string[]) => Promise<void> | void>> = {}): QueueFs & { calls: string[] } {
  const calls: string[] = []
  const wrap =
    <K extends keyof QueueFs>(name: K) =>
    async (...args: Parameters<QueueFs[K]>) => {
      calls.push(name)
      await hooks[name]?.(...(args as string[]))
      return (nodeQueueFs[name] as (...a: Parameters<QueueFs[K]>) => ReturnType<QueueFs[K]>)(...args)
    }
  return {
    calls,
    realpath: wrap('realpath'),
    readFile: wrap('readFile'),
    writeFile: wrap('writeFile'),
    rename: wrap('rename'),
    unlink: wrap('unlink'),
  } as unknown as QueueFs & { calls: string[] }
}

describe('queue writer', () => {
  test('writes one line and keeps the rest byte for byte', async () => {
    // LF, with a final newline.
    const lf = ['# Handoff Queue', '', NOTE, ASK, HALT, ''].join('\n')
    await put(lf)
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'call it Ladder' })).toEqual({ outcome: 'answered' })
    expect((await bytes()).toString('utf8')).toBe(lf.replace(ASK, ANSWERED(ASK, 'call it Ladder')))
    expect(await folder()).toEqual(['handoff-queue.md'])

    // CRLF, a BOM, an indented entry with trailing spaces, and no final newline.
    const crlf = '﻿' + ['# Handoff Queue', '', `  ${HALT}  `, NOTE, ASK].join('\r\n')
    await put(crlf)
    expect((await writeAnswer({ repoPath: repo, line: HALT, text: 'fixed the test, go on' })).outcome).toBe('answered')
    const want = '﻿' + ['# Handoff Queue', '', `  ${ANSWERED(HALT, 'fixed the test, go on')}  `, NOTE, ASK].join('\r\n')
    expect(Buffer.compare(await bytes(), Buffer.from(want, 'utf8'))).toBe(0)

    // The last line, with no newline after it, keeps having none.
    await writeAnswer({ repoPath: repo, line: ASK, text: 'ok' })
    expect((await bytes()).toString('utf8').endsWith(ANSWERED(ASK, 'ok'))).toBe(true)

    // Mixed line endings, and bytes that aren't UTF-8 on another line, stay as they were.
    const odd = Buffer.concat([
      Buffer.from(`${NOTE}\r\n`),
      Buffer.from([0xff, 0xfe, 0x41, 0x0a]),
      Buffer.from(`${ASK}\r\n`),
      Buffer.from(`${HALT}\n`),
    ])
    await put(odd)
    expect((await writeAnswer({ repoPath: repo, line: HALT, text: 'yes' })).outcome).toBe('answered')
    const after = await bytes()
    expect(Buffer.compare(after, Buffer.concat([odd.subarray(0, odd.length - Buffer.byteLength(`${HALT}\n`)), Buffer.from(`${ANSWERED(HALT, 'yes')}\n`)]))).toBe(0)

    // Unicode in the answer is written as UTF-8.
    await put(`${ASK}\n`)
    await writeAnswer({ repoPath: repo, line: ASK, text: 'naïve — 😀' })
    expect(await readFile(queue, 'utf8')).toBe(`${ANSWERED(ASK, 'naïve — 😀')}\n`)
  })

  test('refuses a changed entry', async () => {
    // No line reads the same any more.
    const text = [NOTE, ASK.replace('Pick', 'Choose'), ''].join('\n')
    await put(text)
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' })).toEqual({ outcome: 'changed', message: 'The entry changed since you looked.' })
    expect(await readFile(queue, 'utf8')).toBe(text)

    // Already answered: the line isn't the same line.
    await put(`${ANSWERED(ASK, 'first')}\n`)
    expect((await writeAnswer({ repoPath: repo, line: ASK, text: 'second' })).outcome).toBe('changed')
    expect(await readFile(queue, 'utf8')).toBe(`${ANSWERED(ASK, 'first')}\n`)

    // A line that only contains the entry is not the entry.
    await put(`  - note: ${ASK}\n`)
    expect((await writeAnswer({ repoPath: repo, line: ASK, text: 'x' })).outcome).toBe('changed')

    // Two lines read the same (one with other spacing around it).
    const twice = [ASK, `  ${ASK}\r`, ''].join('\n')
    await put(twice)
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' })).toEqual({ outcome: 'changed', message: 'Two entries read the same. Answer it in the chat.' })
    expect(await readFile(queue, 'utf8')).toBe(twice)
    expect(await folder()).toEqual(['handoff-queue.md'])

    // A missing queue file, or a missing repo, is changed, and the file is never created.
    await rm(queue)
    const fs = spyFs()
    expect((await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, fs)).outcome).toBe('changed')
    expect(await folder()).toEqual([])
    expect(fs.calls).not.toContain('writeFile')
    expect((await writeAnswer({ repoPath: join(root, 'nowhere'), line: ASK, text: 'x' })).outcome).toBe('changed')
    expect(await readdir(root)).toEqual(['repo'])
  })

  test('a write during the answer wins', async () => {
    await put(`${NOTE}\n${ASK}\n`)
    const theirs = `${NOTE}\n${ASK}\n- \`[2026-10-21 · NOTE · engineer → orchestrator]\` pod added this **Resolution:** pending\n`
    // pod writes the queue right after the board's temp file goes down.
    const fs = spyFs({ writeFile: async () => void (await writeFile(queue, theirs)) })
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, fs)).toEqual({ outcome: 'changed', message: 'The queue changed while saving. Look again.' })
    expect(await readFile(queue, 'utf8')).toBe(theirs)
    expect(fs.calls).not.toContain('rename')
    expect(await folder()).toEqual(['handoff-queue.md'])
  })

  test('a failed rename leaves nothing behind', async () => {
    const text = `${NOTE}\n${ASK}\n`
    await put(text)
    const held = (code: string) => {
      let renames = 0
      const fs = spyFs({
        rename: () => {
          renames++
          throw Object.assign(new Error(code), { code })
        },
      })
      return { fs, renames: () => renames }
    }

    // EPERM (a file held open on Windows) retries, then gives up with the code.
    const eperm = held('EPERM')
    const started = Date.now()
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, eperm.fs)).toEqual({ outcome: 'failed', message: "Couldn't write the queue (EPERM)." })
    expect(eperm.renames()).toBe(4)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(await readFile(queue, 'utf8')).toBe(text)
    expect(await folder()).toEqual(['handoff-queue.md'])

    // EBUSY retries too; another code fails at once.
    const ebusy = held('EBUSY')
    expect((await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, ebusy.fs)).message).toBe("Couldn't write the queue (EBUSY).")
    expect(ebusy.renames()).toBe(4)
    const eacces = held('EACCES')
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, eacces.fs)).toEqual({ outcome: 'failed', message: "Couldn't write the queue (EACCES)." })
    expect(eacces.renames()).toBe(1)
    expect(await folder()).toEqual(['handoff-queue.md'])

    // A rename that works on a retry answers.
    let tries = 0
    const flaky = spyFs({
      rename: () => {
        if (++tries < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    })
    expect((await writeAnswer({ repoPath: repo, line: ASK, text: 'third time' }, flaky)).outcome).toBe('answered')
    expect(await readFile(queue, 'utf8')).toBe(`${NOTE}\n${ANSWERED(ASK, 'third time')}\n`)
    expect(await folder()).toEqual(['handoff-queue.md'])

    // The temp file can't be written: failed, queue untouched.
    await put(text)
    const full = spyFs({
      writeFile: () => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      },
    })
    expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, full)).toEqual({ outcome: 'failed', message: "Couldn't write the queue (ENOSPC)." })
    expect(await readFile(queue, 'utf8')).toBe(text)
    expect(await folder()).toEqual(['handoff-queue.md'])
  })

  test('stays inside the repo', async () => {
    await put(`${ASK}\n`)
    const outside = join(root, 'elsewhere', 'handoff-queue.md')
    // The queue file (or its folder) is a link out of the repo.
    for (const target of [outside, join(root, 'repo-two', 'pod-docs', 'handoff-queue.md'), join(repo, '..', 'repo2.md')]) {
      const fs = spyFs()
      const linked: QueueFs = { ...fs, realpath: async (p) => (p === queue ? target : nodeQueueFs.realpath(p)) }
      expect(await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, linked), target).toEqual({ outcome: 'failed', message: 'queue file is outside the repo' })
      expect(fs.calls).not.toContain('readFile')
      expect(fs.calls).not.toContain('writeFile')
    }
    expect(await readFile(queue, 'utf8')).toBe(`${ASK}\n`)

    // A link to another file inside the repo is written at the real file, next to it.
    const real = join(repo, 'docs', 'queue.md')
    await mkdir(join(repo, 'docs'))
    await writeFile(real, `${ASK}\n`)
    const fs = spyFs()
    const inside: QueueFs = { ...fs, realpath: async (p) => (p === queue ? real : nodeQueueFs.realpath(p)) }
    expect((await writeAnswer({ repoPath: repo, line: ASK, text: 'x' }, inside)).outcome).toBe('answered')
    expect(await readFile(real, 'utf8')).toBe(`${ANSWERED(ASK, 'x')}\n`)
    expect(await readFile(queue, 'utf8')).toBe(`${ASK}\n`)
    expect(await readdir(join(repo, 'docs'))).toEqual(['queue.md'])
  })
})

describe('queue writer: a resolution', () => {
  const KEPT = '2026-10-31 — kept: Ladder'

  test('rewrites pending on one line and keeps the rest byte for byte', async () => {
    const crlf = ['# Handoff Queue', '', NOTE, `  ${ASK}  `, HALT, ''].join('\r\n')
    await put(crlf)
    expect(await writeResolution({ repoPath: repo, line: ASK, text: KEPT })).toEqual({ outcome: 'resolved' })
    expect((await bytes()).toString('utf8')).toBe(crlf.replace(ASK, ASK.replace('**Resolution:** pending', `**Resolution:** ${KEPT}`)))
    expect(await folder()).toEqual(['handoff-queue.md'])
  })

  test('a line that no longer reads as pending, or is gone, is changed', async () => {
    const resolved = ASK.replace('pending', '2026-10-30 — done')
    await put(['# Handoff Queue', resolved, ''].join('\n'))
    // The Board's line is gone: pod rewrote it.
    expect(await writeResolution({ repoPath: repo, line: ASK, text: KEPT })).toEqual({ outcome: 'changed', message: 'The entry changed since you looked.' })
    // The line is there but not pending.
    expect(await writeResolution({ repoPath: repo, line: resolved, text: KEPT })).toEqual({ outcome: 'changed', message: 'The entry changed since you looked.' })
    expect((await bytes()).toString('utf8')).toBe(['# Handoff Queue', resolved, ''].join('\n'))
  })

  test('refuses a text that would break the line', async () => {
    await put(`${ASK}\n`)
    expect(await writeResolution({ repoPath: repo, line: ASK, text: 'x **Resolution:** y' })).toMatchObject({ outcome: 'failed' })
    expect((await bytes()).toString('utf8')).toBe(`${ASK}\n`)
  })
})
