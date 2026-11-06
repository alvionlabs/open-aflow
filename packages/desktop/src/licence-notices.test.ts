import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { packageRootsFromMetafile, productionClosure, renderNotices } from './licence-notices.ts'

let dir: string

type Plant = { licence?: string; licenceFile?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }

const plant = (at: string, name: string, version: string, o: Plant = {}) => {
  const root = join(at, 'node_modules', ...name.split('/'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version, dependencies: o.dependencies, optionalDependencies: o.optionalDependencies }))
  if (o.licence !== undefined) writeFileSync(join(root, o.licenceFile ?? 'LICENSE'), o.licence)
  return root
}

const meta = (inputs: string[], outputs: Record<string, unknown> = {}) => ({
  workingDir: dir,
  metafile: { inputs: Object.fromEntries(inputs.map((i) => [i, {}])), outputs },
})

const countOf = (text: string, part: string) => text.split(part).length - 1

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-notices-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('licence notices', () => {
  test('one entry per package', () => {
    const root = plant(dir, 'shared-pkg', '1.2.3', { licence: 'shared licence text' })
    const first = packageRootsFromMetafile(meta(['node_modules/shared-pkg/a.js']))
    const second = packageRootsFromMetafile(meta(['node_modules/shared-pkg/deep/b.js']))
    expect(first).toEqual([root])
    expect(second).toEqual([root])

    const text = renderNotices({ roots: [...first, ...second], overrides: {}, extras: [] })
    expect(countOf(text, 'shared-pkg 1.2.3')).toBe(1)
    expect(countOf(text, 'shared licence text')).toBe(1)
  })

  test('missing licence fails by name', () => {
    const good = plant(dir, 'good-pkg', '1.0.0', { licence: 'good' })
    const bad = plant(dir, '@scope/no-licence', '2.0.0')
    const worse = plant(dir, 'no-licence-either', '3.0.0')
    expect(() => renderNotices({ roots: [good, bad, worse], overrides: {}, extras: [] })).toThrow(/@scope\/no-licence 2\.0\.0.*no-licence-either 3\.0\.0/s)
  })

  test('override', () => {
    const root = plant(dir, 'bare-pkg', '1.0.0')
    const text = renderNotices({ roots: [root], overrides: { 'bare-pkg': 'text from the override' }, extras: [] })
    expect(text).toContain('bare-pkg 1.0.0')
    expect(text).toContain('text from the override')
  })

  test('a licence file wins over an override, in any common spelling', () => {
    for (const [name, file] of [['a-pkg', 'LICENSE.md'], ['b-pkg', 'licence'], ['c-pkg', 'License.txt'], ['d-pkg', 'COPYING']] as const) {
      const root = plant(dir, name, '1.0.0', { licence: `${name} file text`, licenceFile: file })
      expect(renderNotices({ roots: [root], overrides: { [name]: 'override' }, extras: [] })).toContain(`${name} file text`)
    }
  })

  test('an empty licence file counts as none', () => {
    const root = plant(dir, 'empty-pkg', '1.0.0', { licence: '  \n' })
    expect(() => renderNotices({ roots: [root], overrides: {}, extras: [] })).toThrow(/empty-pkg/)
  })

  test('reads the metafile inputs', () => {
    const kept = plant(dir, 'in-inputs', '1.0.0', { licence: 'x' })
    plant(dir, 'in-output-imports', '1.0.0', { licence: 'x' })
    const roots = packageRootsFromMetafile(
      meta(['node_modules/in-inputs/index.js'], { 'out.js': { imports: [{ path: 'node_modules/in-output-imports/index.js', external: true }] } }),
    )
    expect(roots).toEqual([kept])
  })

  test('a first-party file, a disabled file, and a virtual input name no package', () => {
    const scoped = plant(dir, '@scope/pkg', '1.0.0', { licence: 'x' })
    plant(dir, 'off-pkg', '1.0.0', { licence: 'x' })
    const roots = packageRootsFromMetafile(meta(['src/main.ts', '../model/src/index.ts', '<define:process.env>', '(disabled):node_modules/off-pkg/x.js', 'node_modules/@scope/pkg/x.js']))
    expect(roots).toEqual([scoped])
  })

  test('the deepest node_modules names the package', () => {
    const inner = plant(join(dir, 'node_modules', '.pnpm', 'hono@4.0.0'), 'hono', '4.0.0', { licence: 'x' })
    expect(packageRootsFromMetafile(meta(['node_modules/.pnpm/hono@4.0.0/node_modules/hono/dist/index.js']))).toEqual([inner])
  })

  test('the production closure walks dependencies and skips the workspace', () => {
    const web = join(dir, 'packages', 'web')
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, 'package.json'), JSON.stringify({ name: '@pod-board/web', dependencies: { react: '1', 'first-party': 'workspace:*' }, devDependencies: { vite: '1' } }))
    const react = plant(dir, 'react', '19.0.0', { licence: 'x', dependencies: { scheduler: '1' }, optionalDependencies: { 'not-installed': '1' } })
    // Both sit two levels up, as Node resolves them, and scheduler points back at react: a cycle.
    const scheduler = plant(dir, 'scheduler', '1.0.0', { licence: 'x', dependencies: { react: '19' } })
    plant(web, 'vite', '1.0.0', { licence: 'x' })
    // A pnpm workspace link: the real path holds no node_modules folder, so it lists nothing itself.
    const firstParty = join(dir, 'packages', 'first-party')
    mkdirSync(firstParty, { recursive: true })
    writeFileSync(join(firstParty, 'package.json'), JSON.stringify({ name: 'first-party', dependencies: { 'only-through-workspace': '1' } }))
    symlinkSync(firstParty, join(web, 'node_modules', 'first-party'), 'junction')
    const through = plant(firstParty, 'only-through-workspace', '1.0.0', { licence: 'x' })

    expect(productionClosure(web).sort()).toEqual([react, scheduler, through].sort())
  })

  test('a dependency that is not installed fails by name', () => {
    const web = join(dir, 'web')
    mkdirSync(web)
    writeFileSync(join(web, 'package.json'), JSON.stringify({ dependencies: { 'gone-pkg': '1' } }))
    expect(() => productionClosure(web)).toThrow(/gone-pkg/)
  })

  test('extras keep their title and text', () => {
    const text = renderNotices({ roots: [], overrides: {}, extras: [{ title: 'Geist font', text: 'SIL Open Font License' }] })
    expect(text).toContain('Geist font')
    expect(text).toContain('SIL Open Font License')
  })

  test("the notice names the app", () => {
    expect(renderNotices({ roots: [], overrides: {}, extras: [] })).toMatch(/^Open AFlow includes the third-party software named below\./)
  })

  test('the same input gives the same text', () => {
    const a = plant(dir, 'a-pkg', '1.0.0', { licence: 'a' })
    const b = plant(dir, 'b-pkg', '1.0.0', { licence: 'b' })
    const text = renderNotices({ roots: [b, a], overrides: {}, extras: [] })
    expect(text).toContain('a-pkg 1.0.0')
    expect(text).toBe(renderNotices({ roots: [a, b], overrides: {}, extras: [] }))
  })
})
