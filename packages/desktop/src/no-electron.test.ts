import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// CI has no Electron binary, and importing `electron` under Node downloads one. So only the glue may import it.

const THIS_FILE = fileURLToPath(import.meta.url)
const pkg = join(dirname(THIS_FILE), '..')
const FOLDERS = ['src', 'scripts', 'test']
const ELECTRON_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']electron(?:-updater)?["']/
const mayImport = (file: string) => /^main\.ts$|-main\.ts$/.test(basename(file))

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.[cm]?[jt]s$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))

describe('electron imports', () => {
  test('the check sees every import form', () => {
    for (const line of [
      `import { app } from 'electron'`,
      `import type { App } from "electron"`,
      `import 'electron'`,
      `await import('electron')`,
      `const e = require("electron")`,
      `import { autoUpdater } from 'electron-updater'`,
      `import type { UpdateInfo } from "electron-updater"`,
      `import 'electron-updater'`,
      `await import('electron-updater')`,
      `const u = require("electron-updater")`,
    ]) {
      expect(ELECTRON_IMPORT.test(line), line).toBe(true)
    }
    for (const line of [`external: ['electron']`, `import x from 'electron-log'`, `import x from 'electron-builder'`, `// electron`, `// electron-updater`]) {
      expect(ELECTRON_IMPORT.test(line), line).toBe(false)
    }
    expect(mayImport('src/main.ts')).toBe(true)
    expect(mayImport('src/host-main.ts')).toBe(true)
    expect(mayImport('src/domain.ts')).toBe(false)
    expect(mayImport('src/server-host.ts')).toBe(false)
  })

  test('plain modules stay free of Electron', () => {
    const files = FOLDERS.flatMap((f) => sources(join(pkg, f)))
    expect(files.map((f) => basename(f))).toContain('server-host.ts')
    const offenders = files.filter((f) => f !== THIS_FILE && !mayImport(f) && ELECTRON_IMPORT.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
