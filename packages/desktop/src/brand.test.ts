import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// The app is Open AFlow for users. Package names, env vars, and the server's config folder keep `pod-board`.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const sources = (dir: string) =>
  readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|html|nsh)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))

describe('the brand users see', () => {
  test('no shipped file or user doc says the old name', () => {
    const files = [
      ...sources('packages/desktop/src'),
      ...sources('packages/desktop/build'),
      ...sources('packages/web/src'),
      join(ROOT, 'packages/web/index.html'),
      join(ROOT, 'README.md'),
      join(ROOT, 'docs/install.md'),
    ]
    expect(files.length).toBeGreaterThan(20)
    const offenders = files.filter((file) => /Pod Board|iamphduc\/pod-board/i.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('the page title and the sidebar say Open AFlow', () => {
    expect(readFileSync(join(ROOT, 'packages/web/index.html'), 'utf8')).toContain('<title>Open AFlow</title>')
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toMatch(/^# Open AFlow\n/)
  })
})
