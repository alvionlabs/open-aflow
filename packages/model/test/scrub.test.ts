import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { findLeaks } from './scrub.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? allFiles(full) : [full]
  })
}

/** The rule names a text trips; each finding starts with its rule. */
const rules = (path: string, text: string) => findLeaks(path, text).map((leak) => leak.split(':')[0])

// Planted secrets are built at run time so this source holds no token-shaped
// string for the secrets scan to flag.
const pad = (n: number) => 'x'.repeat(n)

describe('scrub', () => {
  test('every fixture file is clean', () => {
    const files = existsSync(FIXTURES) ? allFiles(FIXTURES) : []
    expect(files.length).toBeGreaterThan(20)
    const leaks = files.flatMap((file) =>
      findLeaks(relative(FIXTURES, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')),
    )
    expect(leaks).toEqual([])
  })

  test('catches each planted leak', () => {
    const md = 'notes.md'
    expect(rules(md, `mail ${'someone'}@${'example.com'} today`)).toContain('email')
    expect(rules(md, 'see C:\\Users\\someone\\repo')).toContain('home path')
    expect(rules(md, 'see C:/Users/someone/repo')).toContain('home path')
    expect(rules(md, 'see c:/users/someone/repo')).toContain('home path')
    expect(rules(md, 'see /Users/someone/repo')).toContain('home path')
    expect(rules(md, 'see `/home/someone/repo`')).toContain('home path')
    expect(rules(md, 'see E:\\Projects\\repo')).toContain('drive path')
    expect(rules(md, 'see E:/Projects/repo')).toContain('drive path')
    expect(rules(md, '(e:/projects/repo)')).toContain('drive path')
    for (const prefix of ['ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_']) {
      expect(rules(md, `token ${prefix}${pad(20)} end`)).toContain('token')
    }
    expect(rules(md, `key sk-${pad(20)}`)).toContain('token')
    expect(rules(md, `key AKIA${'X'.repeat(16)}`)).toContain('token')
    expect(rules(md, `${'-'.repeat(5)}BEGIN OPENSSH PRIVATE KEY`)).toContain('token')
    expect(rules('pod-docs/run.jsonl', '{}')).toEqual(['not markdown'])
    expect(rules('notes.txt', 'plain')).toEqual(['not markdown'])
    expect(rules('notes.MD', 'plain')).toEqual(['not markdown'])
  })

  test('each finding names its rule, file and match', () => {
    expect(findLeaks('a/b.md', 'path E:/x')).toEqual(['drive path: a/b.md: E:/'])
  })

  test('token shapes below the length limit pass', () => {
    expect(findLeaks('a.md', `ghp_${pad(19)} sk-${pad(19)} AKIA${'X'.repeat(15)}`)).toEqual([])
  })

  test('allows GitHub URLs', () => {
    const text = [
      '# Sprint: Ladder',
      '',
      '_From plan: pod-docs/plans/sparring-ladder.md · Slug: ladder · Status: active_',
      '| 1 | L1 | Look | ladder-L1 | [#76](https://github.com/iamphduc/chess-web/pull/76) merged | merged | medium | — |',
      'Final PR https://github.com/iamphduc/chess-web/pull/76, see http://127.0.0.1:3000/api/health.',
      'A page at https://example.com/home/docs and https://example.com/Users/list is not a home path.',
      'Install `react@18.3.1` and `@open-aflow/model`; run `npm run calibrate -- --measure`.',
      'Paths stay repo-relative: `src/game/review/grade.ts`, `pod-docs/sprints/archive/ladder.md`.',
      'Times like 10:31:18Z and ratios like 3:2 are fine; so is `task-skipped-because-of-a-long-reason`.',
      '- `[2026-06-04 · PENDING · reviewer → orchestrator · sprint: x]` body **Resolution:** pending',
    ].join('\n')
    expect(findLeaks('pod-docs/sprints/ladder.md', text)).toEqual([])
  })
})
