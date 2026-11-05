import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bundleDesktop } from './bundle-desktop.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('bundleDesktop', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-desktop-bundle-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('bundles the main process', async () => {
    const outfile = join(dir, 'main.cjs')
    const { externalImports } = await bundleDesktop({ entry: join(here, 'main.ts'), outfile })

    expect(existsSync(outfile)).toBe(true)
    expect(externalImports).toContain('electron')
    expect(externalImports.filter((name) => name !== 'electron' && !isBuiltin(name))).toEqual([])

    const text = readFileSync(outfile, 'utf8')
    expect(text).toMatch(/require\("electron"\)/)
    // CommonJS, with the shell's code inside and nothing of Electron's npm package.
    expect(text).not.toMatch(/^\s*import\s.+from\s/m)
    expect(text).toContain('com.iamphduc.podboard')
    expect(text).not.toContain('Electron failed to install correctly')

    // pnpm package reads the bundle's packages from this file.
    const meta = JSON.parse(readFileSync(`${outfile}.meta.json`, 'utf8')) as { workingDir: string; metafile: { inputs: Record<string, unknown> } }
    expect(existsSync(meta.workingDir)).toBe(true)
    expect(Object.keys(meta.metafile.inputs).some((input) => input.endsWith('src/main.ts'))).toBe(true)
  }, 60_000)

  test('a default bundle has no test feed', async () => {
    const outfile = join(dir, 'main.cjs')
    const { externalImports } = await bundleDesktop({ entry: join(here, 'main.ts'), outfile })
    const text = readFileSync(outfile, 'utf8')
    expect(text).not.toContain('POD_BOARD_UPDATE_TEST')
    // The file a test build reads. Nothing of the test feed stays.
    expect(text).not.toContain('update-test-env')
    // The updater is inside, set for no install on quit, and it adds no external import.
    expect(text).toMatch(/autoInstallOnAppQuit = false/)
    expect(text).toContain('.atom')
    expect(externalImports.filter((name) => name !== 'electron' && !isBuiltin(name))).toEqual([])
  }, 60_000)

  test('a test bundle has the test feed', async () => {
    const outfile = join(dir, 'main.cjs')
    const { externalImports } = await bundleDesktop({ entry: join(here, 'main.ts'), outfile, testFeed: true })
    const text = readFileSync(outfile, 'utf8')
    expect(text).toContain('POD_BOARD_UPDATE_TEST_FEED')
    expect(text).toContain('POD_BOARD_UPDATE_TEST_ANSWER')
    expect(text).toContain('POD_BOARD_UPDATE_TEST_DELAY_MS')
    expect(text).toContain('update-test-env')
    expect(externalImports.filter((name) => name !== 'electron' && !isBuiltin(name))).toEqual([])
  }, 60_000)
})
