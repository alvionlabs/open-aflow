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
  }, 60_000)
})
