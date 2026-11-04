// What `pnpm package` asks electron-builder for. The rules are in pod-docs/sprints/installer-and-updates.md and
// pod-docs/feature-details/desktop.md. No `electron` import: this runs under Node.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Configuration } from 'electron-builder'
import manifest from '../package.json' with { type: 'json' }
import { APP_ID, APP_NAME } from './shell-config.ts'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The packaged app's `name`. It sets the install folder and the updater's cache folder, and NSIS's
 * `--delete-app-data` removes `%APPDATA%\<name>`, so it must never be the server's config folder, `pod-board`.
 */
const PACKAGED_NAME = 'pod-board-desktop'

/** electron-builder derives the cache folder's name from the packaged name. */
export const UPDATER_CACHE_DIR = `${PACKAGED_NAME}-updater`
export const EXE_NAME = `${APP_NAME}.exe`

export type BuildOptions = {
  /** The generated THIRD-PARTY-NOTICES.txt. */
  noticesFile: string
  /** Default: `version` in the desktop package.json. Edits no file. */
  version?: string
  /** Default: `release` in the desktop package, which git ignores. */
  output?: string
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function checkVersion(version: string): void {
  if (!VERSION.test(version)) throw new Error(`bad version ${JSON.stringify(version)}: use <major>.<minor>.<patch>, digits only, with no leading zero`)
}

export function parsePackageArgs(argv: string[]): { version?: string; output?: string } {
  const out: { version?: string; output?: string } = {}
  for (const arg of argv) {
    if (arg === '--') continue
    if (arg.startsWith('--version=')) {
      out.version = arg.slice('--version='.length)
      checkVersion(out.version)
    } else if (arg.startsWith('--output=')) {
      out.output = arg.slice('--output='.length)
      if (out.output === '') throw new Error('--output needs a folder')
    } else {
      throw new Error(`unknown flag ${arg}: pnpm package takes --version=<x.y.z> and --output=<dir>`)
    }
  }
  return out
}

export function buildConfig(o: BuildOptions): Configuration {
  const version = o.version ?? manifest.version
  checkVersion(version)
  return {
    appId: APP_ID,
    productName: APP_NAME,
    electronVersion: manifest.devDependencies.electron,
    directories: { output: o.output ?? 'release', buildResources: 'build' },
    extraMetadata: { name: PACKAGED_NAME, version, main: 'dist/main.cjs' },
    // The app holds no node_modules: every dependency is inside a bundle.
    files: ['dist/main.cjs', 'assets/**/*', 'package.json', '!node_modules/**/*'],
    extraResources: [
      { from: '../server/dist/app', to: 'server' },
      { from: o.noticesFile, to: 'THIRD-PARTY-NOTICES.txt' },
    ],
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: false,
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'assets/icon.ico',
      // Unsigned on purpose: the GitHub account is the trust boundary.
      verifyUpdateCodeSignature: false,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: APP_NAME,
      // A run after a silent install would start with no temp env and open the real config folder.
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
      installerIcon: 'assets/icon.ico',
      uninstallerIcon: 'assets/icon.ico',
      // No spaces: GitHub rewrites them in asset names, which would break latest.yml.
      artifactName: 'pod-board-setup-${version}.${ext}',
      include: 'build/installer.nsh',
    },
    publish: { provider: 'github', owner: 'iamphduc', repo: 'pod-board', releaseType: 'release' },
  }
}

export function builderOptions(o: BuildOptions): { projectDir: string; publish: 'never'; config: Configuration } {
  return { projectDir: PACKAGE_DIR, publish: 'never', config: buildConfig(o) }
}
