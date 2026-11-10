import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createIdleCheck, SESSION_IDLE_MS, type StatFs } from './session-activity.ts'
import { projectDirName } from './transcript-files.ts'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const SESSION = 'sess-1'

let root: string
let claudeDir: string
let repo: { path: string }
let project: string

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'openaflow-s1-idle-')))
  claudeDir = join(root, 'claude')
  repo = { path: join(root, 'repos', 'r') }
  project = join(claudeDir, 'projects', projectDirName(repo.path))
  mkdirSync(project, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes `file` and sets its modified time to `NOW - ageMs`. */
function touch(file: string, ageMs: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '{"type":"user"}\n')
  const t = (NOW - ageMs) / 1000
  utimesSync(file, t, t)
}

const main = () => join(project, `${SESSION}.jsonl`)
const subagent = (name: string) => join(project, SESSION, 'subagents', name)
const idle = (fs?: StatFs) => createIdleCheck({ claudeDir, now: () => NOW, ...(fs ? { fs } : {}) })(repo, SESSION)

describe('session activity', () => {
  test('idle after 60 s of quiet', () => {
    expect(SESSION_IDLE_MS).toBe(60_000)

    // A missing transcript is not idle.
    expect(idle()).toBe(false)

    touch(main(), 60_000)
    expect(idle()).toBe(true)
    touch(main(), 120_000)
    expect(idle()).toBe(true)
    touch(main(), 59_000)
    expect(idle()).toBe(false)
    touch(main(), 0)
    expect(idle()).toBe(false)
    // A modified time ahead of the clock is busy, not idle.
    touch(main(), -5_000)
    expect(idle()).toBe(false)

    // Another session's quiet file says nothing about this one.
    touch(join(project, 'other.jsonl'), 120_000)
    rmSync(main())
    expect(idle()).toBe(false)
  })

  test('a fresh subagent file keeps the session busy', () => {
    touch(main(), 120_000)
    touch(subagent('agent-a.jsonl'), 120_000)
    touch(subagent('agent-a.meta.json'), 120_000)
    // Stamp the folder old too: a write to a file inside doesn't change its folder's time.
    const old = (NOW - 120_000) / 1000
    utimesSync(join(project, SESSION, 'subagents'), old, old)
    utimesSync(join(project, SESSION), old, old)
    expect(idle()).toBe(true)

    // A foreground subagent writes only under subagents/, so the main file stays quiet.
    touch(subagent('agent-a.jsonl'), 10_000)
    expect(idle()).toBe(false)
    touch(subagent('agent-a.jsonl'), 59_000)
    expect(idle()).toBe(false)
    touch(subagent('agent-a.jsonl'), 60_000)
    expect(idle()).toBe(true)

    // The main file fresh with the subagents old is busy as well.
    touch(main(), 5_000)
    expect(idle()).toBe(false)
  })

  test('only stat, never read', () => {
    touch(main(), 120_000)
    touch(subagent('agent-a.jsonl'), 120_000)
    const calls: string[] = []
    const fs: StatFs = {
      statSync: (p) => {
        calls.push('stat')
        return statSync(p)
      },
      readdirSync: (p) => {
        calls.push('readdir')
        return readdirSync(p)
      },
    }
    expect(idle(fs)).toBe(true)
    expect(calls).toContain('stat')
    expect(new Set(calls)).toEqual(new Set(['stat', 'readdir']))

    // The module itself never opens a file: it imports no read or open call.
    const source = readFileSync(new URL('./session-activity.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/readFile|openSync|\bopen\(|createReadStream/)
  })

  test('a stat that throws is busy', () => {
    touch(main(), 120_000)
    const fs: StatFs = {
      statSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
      readdirSync: () => [],
    }
    expect(idle(fs)).toBe(false)
  })
})
