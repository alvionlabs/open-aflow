import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// The app is Open AFlow, inside and out. The old name stays only in history: pod-docs reports, sprints, plans,
// research, design drafts, the handoff queue, decisions, and the History part of each feature-details file.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const OLD_NAME = /pod[-_ ]board/i

/** Files under `dir` with one of `exts`. Tests are left out: they may hold copied data. */
const filesUnder = (dir: string, exts: RegExp) =>
  readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && exts.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))

const CODE = /\.(ts|tsx|mjs|html|nsh|css|json)$/
const PACKAGES = ['desktop', 'model', 'server', 'web']

/** Shipped code, the scripts and workflows that build it, and the docs that say how it works today. */
const currentFiles = () => [
  ...PACKAGES.flatMap((p) => [...filesUnder(`packages/${p}/src`, CODE), join(ROOT, `packages/${p}/package.json`)]),
  ...filesUnder('packages/desktop/scripts', CODE),
  ...filesUnder('packages/desktop/build', CODE),
  ...filesUnder('packages/server/scripts', CODE),
  join(ROOT, 'packages/web/index.html'),
  join(ROOT, 'packages/web/vite.config.ts'),
  join(ROOT, 'package.json'),
  ...filesUnder('.github/workflows', /\.ya?ml$/),
  ...['README.md', 'CLAUDE.md', 'DESIGN.md', 'docs/install.md', 'docs/design/preview.html'].map((f) => join(ROOT, f)),
  ...['pod-docs/codebase-structure.md', 'pod-docs/features.md'].map((f) => join(ROOT, f)),
  ...filesUnder('pod-docs/known-issues', /\.md$/),
  ...filesUnder('pod-docs/ideas', /\.(md|html)$/),
  ...filesUnder('pod-docs/feature-details', /\.md$/),
]

/**
 * Files that name the old folder or keys on purpose, to copy them once: each one's old names, and why.
 * A new entry here needs the same reason.
 */
const MOVES: Record<string, RegExp> = {
  // The old config folder the first start copies from.
  'packages/server/src/config.ts': /'pod-board'/g,
  // The old browser keys the page moves once.
  'packages/web/src/old-storage-keys.ts': /'pod-board-(theme|tab|sidebar-width)'/g,
}

/** The text that counts: no History section, no old PR link, and no name of another repo that keeps its own. */
function currentText(file: string): string {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  let text = readFileSync(file, 'utf8')
  if (rel.startsWith('pod-docs/feature-details/')) text = text.replace(/^## History\n[\s\S]*?(?=^## |(?![\s\S]))/m, '')
  text = text.replace(/github\.com\/iamphduc\/pod-board\/pull\/\d+/g, '').replace(/(iamphduc\/)?pod-board-run-test/g, '')
  const allowed = MOVES[rel]
  return allowed ? text.replace(allowed, '') : text
}

describe('the brand', () => {
  test('no shipped file, build file, or current doc says the old name', () => {
    const files = currentFiles()
    expect(files.length).toBeGreaterThan(200)
    const offenders = files
      .filter((file) => OLD_NAME.test(currentText(file)))
      .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
    expect(offenders).toEqual([])
  })

  test('the guard sees every way of writing the old name', () => {
    for (const name of ['pod-board', 'pod_board', 'POD_BOARD', 'Pod Board', 'X-Pod-Board-Token']) expect(OLD_NAME.test(name), name).toBe(true)
    for (const name of ['pod-docs', 'pod-ports', 'pod docs: 2', '/pod:fix', 'iamphduc/claude-pod']) expect(OLD_NAME.test(name), name).toBe(false)
  })

  test('each allowed old name is still there, so the allow list never goes stale', () => {
    for (const [file, allowed] of Object.entries(MOVES)) expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(allowed)
  })

  test('the page title and the sidebar say Open AFlow', () => {
    expect(readFileSync(join(ROOT, 'packages/web/index.html'), 'utf8')).toContain('<title>Open AFlow</title>')
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toMatch(/^# Open AFlow\n/)
  })
})
