// The one file the board writes in a repo: one line of `pod-docs/handoff-queue.md`, either an answer
// appended to it or (Close and Keep) its `**Resolution:** pending` rewritten. Every other byte of the
// file stays as it was. The rules and why are in pod-docs/feature-details/actions.md.

import { randomBytes } from 'node:crypto'
import { readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { cleanAnswer, withAnswer, withResolution, type AnswerOutcome } from '@open-aflow/model'

/** The file calls the writer makes. Injectable so tests can fake a symlink or a held file on any OS. */
export type QueueFs = {
  realpath(p: string): Promise<string>
  readFile(p: string): Promise<Buffer>
  /** Creates `p`; fails if it exists. */
  writeFile(p: string, data: Buffer): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(p: string): Promise<void>
}

export const nodeQueueFs: QueueFs = {
  realpath: (p) => realpath(p),
  readFile: (p) => readFile(p),
  writeFile: (p, data) => writeFile(p, data, { flag: 'wx' }),
  rename: (from, to) => rename(from, to),
  unlink: (p) => unlink(p),
}

export type WriteAnswer = { outcome: AnswerOutcome; message?: string }
export type WriteResolution = { outcome: 'resolved' | 'changed' | 'failed'; message?: string }

export const QUEUE_FILE = 'pod-docs/handoff-queue.md'
const RENAME_RETRIES = 3
const RETRY_MS = 100

const CHANGED = { outcome: 'changed', message: 'The entry changed since you looked.' } as const
const MISSING = { outcome: 'changed', message: 'The queue file is missing.' } as const
const TWICE = { outcome: 'changed', message: 'Two entries read the same. Answer it in the chat.' } as const
const MOVED = { outcome: 'changed', message: 'The queue changed while saving. Look again.' } as const
const OUTSIDE = { outcome: 'failed', message: 'queue file is outside the repo' } as const
const failed = (err: unknown) => ({ outcome: 'failed', message: `Couldn't write the queue (${codeOf(err) ?? 'unknown'}).` }) as const

/**
 * Appends the answer to the queue line whose trim is `line`. A missing file is never created; a queue whose
 * real path leaves the repo is never touched. The new file goes down beside the real one and is renamed over it.
 */
export async function writeAnswer(req: { repoPath: string; line: string; text: string }, fs: QueueFs = nodeQueueFs): Promise<WriteAnswer> {
  const clean = cleanAnswer(req.text)
  if (!clean.ok) return { outcome: 'failed', message: clean.error }
  const r = await writeLine(req.repoPath, req.line, (raw) => answered(raw, clean.text), fs)
  return r.outcome === 'written' ? { outcome: 'answered' } : r
}

/**
 * Rewrites the `**Resolution:** pending` of the queue line whose trim is `line` to `**Resolution:** <text>`
 * (Close and Keep), with the answer's guards. A line that no longer reads as pending is `changed`.
 */
export async function writeResolution(req: { repoPath: string; line: string; text: string }, fs: QueueFs = nodeQueueFs): Promise<WriteResolution> {
  const clean = cleanAnswer(req.text)
  if (!clean.ok) return { outcome: 'failed', message: clean.error }
  const r = await writeLine(req.repoPath, req.line, (raw) => resolved(raw, clean.text), fs)
  return r.outcome === 'written' ? { outcome: 'resolved' } : r
}

type Written = { outcome: 'written' } | { outcome: 'changed' | 'failed'; message: string }

/** The shared write: one line through `edit` (undefined: the line doesn't read as expected), renamed over the file. */
async function writeLine(repoPath: string, line: string, edit: (raw: string) => string | undefined, fs: QueueFs): Promise<Written> {
  const req = { repoPath, line }

  let repo: string
  let file: string
  try {
    repo = await fs.realpath(req.repoPath)
    file = await fs.realpath(join(req.repoPath, QUEUE_FILE))
  } catch (err) {
    return codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR' ? MISSING : failed(err)
  }
  const rel = relative(repo, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return OUTSIDE

  let before: Buffer
  try {
    before = await fs.readFile(file)
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? MISSING : failed(err)
  }
  const found = linesOf(before).filter((l) => l.text.trim() === req.line)
  if (found.length === 0) return CHANGED
  if (found.length > 1) return TWICE
  const target = found[0]!
  const edited = edit(target.text)
  if (edited === undefined) return CHANGED
  const next = Buffer.concat([before.subarray(0, target.start), Buffer.from(edited, 'utf8'), before.subarray(target.end)])

  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temp, next)
  } catch (err) {
    await drop(fs, temp)
    return failed(err)
  }
  try {
    // A write by pod since the read wins: the board's copy would lose it.
    const now = await fs.readFile(file)
    if (!now.equals(before)) {
      await drop(fs, temp)
      return MOVED
    }
  } catch (err) {
    await drop(fs, temp)
    return codeOf(err) === 'ENOENT' ? MISSING : failed(err)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, file)
      return { outcome: 'written' }
    } catch (err) {
      const code = codeOf(err)
      if ((code === 'EPERM' || code === 'EBUSY') && attempt < RENAME_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_MS))
        continue
      }
      await drop(fs, temp)
      return failed(err)
    }
  }
}

type Line = { start: number; end: number; text: string }

/** Each line's byte range, without its `\n`. A `\r` before it stays in the text, which `trim` drops. */
function linesOf(buf: Buffer): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= buf.length) {
    const nl = buf.indexOf(0x0a, start)
    const end = nl < 0 ? buf.length : nl
    lines.push({ start, end, text: buf.subarray(start, end).toString('utf8') })
    if (nl < 0) break
    start = nl + 1
  }
  return lines
}

/** The line with the answer after its content; what came before (indent, a BOM) and after (spaces, `\r`) stays. */
function answered(raw: string, text: string): string {
  const lead = raw.slice(0, raw.length - raw.trimStart().length)
  const trail = raw.slice(raw.trimEnd().length)
  return lead + withAnswer(raw.trim(), text) + trail
}

/** The line with its pending Resolution rewritten; undefined when it no longer reads as pending. */
function resolved(raw: string, text: string): string | undefined {
  const lead = raw.slice(0, raw.length - raw.trimStart().length)
  const trail = raw.slice(raw.trimEnd().length)
  const out = withResolution(raw.trim(), text)
  return out === undefined ? undefined : lead + out + trail
}

async function drop(fs: QueueFs, temp: string): Promise<void> {
  try {
    await fs.unlink(temp)
  } catch {
    // Never written, or already gone.
  }
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
