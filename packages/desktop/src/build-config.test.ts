import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { buildConfig, builderOptions, checkVersion, parsePackageArgs, UPDATER_CACHE_DIR } from './build-config.ts'
import { APP_ID, APP_NAME } from './shell-config.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
type Manifest = { version: string; dependencies?: Record<string, string>; devDependencies: Record<string, string> }
const manifest = () => JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as Manifest
const NOTICES = 'C:\\tmp\\THIRD-PARTY-NOTICES.txt'
const config = (o: { version?: string; output?: string } = {}) => buildConfig({ noticesFile: NOTICES, ...o })

describe('electron-builder config', () => {
  test("per-user NSIS with the shell's identity", () => {
    const c = config()
    expect(c.appId).toBe(APP_ID)
    expect(c.productName).toBe(APP_NAME)
    expect(c.electronVersion).toBe(manifest().devDependencies.electron)
    expect(c.electronVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(c.win?.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(c.win?.icon).toBe('assets/icon.ico')
    const n = c.nsis!
    expect(n.oneClick).toBe(true)
    expect(n.perMachine).toBe(false)
    expect(n.createDesktopShortcut).toBe(false)
    expect(n.createStartMenuShortcut).toBe(true)
    expect(n.shortcutName).toBe(APP_NAME)
    expect(n.runAfterFinish).toBe(false)
    expect(n.deleteAppDataOnUninstall).toBe(false)
    expect(n.include).toBe('build/installer.nsh')
  })

  test("the app's file name is never the server's config folder", () => {
    // NSIS's `--delete-app-data` removes %APPDATA%\<this name>. The server's config folder is `pod-board`.
    const name = config().extraMetadata?.name as string
    expect(name).not.toBe('pod-board')
    expect(name).not.toMatch(/[@/\s]/)
    expect(UPDATER_CACHE_DIR).toBe(`${name}-updater`)
  })

  test('the desktop package has no production dependency for the packager to collect', () => {
    expect(manifest().dependencies ?? {}).toEqual({})
    for (const name of ['electron-builder', 'electron-updater', '@electron/asar', 'yaml']) {
      expect(manifest().devDependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(manifest().version).toBe('0.1.0')
  })

  test('server in extraResources, no node_modules', () => {
    const c = config()
    expect(c.extraResources).toContainEqual({ from: '../server/dist/app', to: 'server' })
    expect(c.extraResources).toContainEqual({ from: NOTICES, to: 'THIRD-PARTY-NOTICES.txt' })
    expect(c.files).toEqual(['dist/main.cjs', 'assets/**/*', 'package.json', '!node_modules/**/*'])
    expect(c.npmRebuild).toBe(false)
    expect(c.nodeGypRebuild).toBe(false)
  })

  test('artifact names have no spaces', () => {
    const name = config().nsis!.artifactName!
    for (const version of ['0.1.0', '1.2.3', '10.20.30']) {
      for (const ext of ['exe', 'exe.blockmap']) {
        expect(name.replace('${version}', version).replace('${ext}', ext)).toBe(`pod-board-setup-${version}.${ext}`)
      }
    }
  })

  test('publish config', () => {
    const c = config()
    expect(c.publish).toEqual({ provider: 'github', owner: 'iamphduc', repo: 'pod-board', releaseType: 'release' })
    expect(c.win?.verifyUpdateCodeSignature).toBe(false)
  })

  test('a local build never publishes and never signs', () => {
    const o = builderOptions({ noticesFile: NOTICES, version: '1.2.3', output: 'C:\\tmp\\out' })
    expect(o.publish).toBe('never')
    expect(o.projectDir).toBe(pkg)
    expect(o.config.forceCodeSigning).toBe(false)
  })

  test('version override', () => {
    const before = readFileSync(join(pkg, 'package.json'), 'utf8')
    expect(config({ version: '9.8.7' }).extraMetadata?.version).toBe('9.8.7')
    expect(config().extraMetadata?.version).toBe(manifest().version)
    expect(readFileSync(join(pkg, 'package.json'), 'utf8')).toBe(before)

    for (const bad of ['1.2', '1.2.3-beta', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3 ', '', 'x']) {
      expect(() => checkVersion(bad), JSON.stringify(bad)).toThrow(/version/)
      expect(() => config({ version: bad }), JSON.stringify(bad)).toThrow(/version/)
    }
    expect(() => checkVersion('0.0.0')).not.toThrow()
  })

  test('the output folder goes in the config, and defaults to release', () => {
    expect(config({ output: 'C:\\tmp\\out' }).directories?.output).toBe('C:\\tmp\\out')
    expect(config().directories?.output).toBe('release')
  })

  test('the flags of pnpm package', () => {
    expect(parsePackageArgs([])).toEqual({})
    expect(parsePackageArgs(['--version=1.2.3', '--output=C:\\o'])).toEqual({ version: '1.2.3', output: 'C:\\o' })
    // pnpm passes a separator through from `pnpm package -- --version=...`.
    expect(parsePackageArgs(['--', '--version=1.2.3'])).toEqual({ version: '1.2.3' })
    expect(parsePackageArgs(['--test-feed'])).toEqual({ testFeed: true })
    expect(parsePackageArgs(['--version=1.2.3', '--test-feed', '--output=C:\o'])).toEqual({ version: '1.2.3', output: 'C:\o', testFeed: true })
    expect(() => parsePackageArgs(['--test-feed=1'])).toThrow(/--test-feed=1/)
    expect(() => parsePackageArgs(['--version=1.2'])).toThrow(/version/)
    expect(() => parsePackageArgs(['--output='])).toThrow(/output/)
    expect(() => parsePackageArgs(['--nope'])).toThrow(/--nope/)
  })

  test('the installed NSIS templates hold no tree kill', () => {
    // A tree kill from the installer would reach a detached `claude`. This fails when an electron-builder bump adds one.
    const builder = createRequire(join(pkg, 'package.json')).resolve('electron-builder')
    const lib = dirname(createRequire(builder).resolve('app-builder-lib/package.json'))
    const dir = join(lib, 'templates', 'nsis')
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.ns[hi]$/.test(e.name))
    expect(files.length).toBeGreaterThan(5)
    const offenders = files.map((e) => join(e.parentPath, e.name)).filter((file) => /taskkill[^\n`]*\s\/t\b/i.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
    // The ways it ends an app today: each process by its ID, or by image name.
    const check = readFileSync(join(dir, 'include', 'allowOnlyOneInstallerInstance.nsh'), 'utf8')
    expect(check).toContain('Stop-Process -Id')
    expect(check).toContain('taskkill')
  })
})
