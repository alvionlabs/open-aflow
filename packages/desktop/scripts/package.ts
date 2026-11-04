// `pnpm package [--version=<x.y.z>] [--output=<dir>]`: builds, writes the licence notices, then makes the installer,
// its blockmap, and latest.yml. It always passes `publish: never`, and it signs nothing.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'
import { builderOptions, parsePackageArgs } from '../src/build-config.ts'
import { packageRootsFromMetafile, productionClosure, renderNotices, type BundleMeta } from '../src/licence-notices.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..')
const server = join(pkg, '..', 'server')
const web = join(pkg, '..', 'web')

/** For a package that ships no licence file. Each entry says where its text comes from. */
const LICENCE_OVERRIDES: Record<string, string> = {}

const readMeta = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as BundleMeta

function writeNotices(): string {
  const text = renderNotices({
    roots: [
      ...packageRootsFromMetafile(readMeta(join(server, 'dist', 'app.meta.json'))),
      ...packageRootsFromMetafile(readMeta(join(pkg, 'dist', 'main.cjs.meta.json'))),
      ...productionClosure(web),
    ],
    overrides: LICENCE_OVERRIDES,
    extras: [
      { title: 'Geist (font)', text: readFileSync(join(web, 'public', 'fonts', 'geist-OFL.txt'), 'utf8').trim() },
      { title: 'Geist Mono (font)', text: readFileSync(join(web, 'public', 'fonts', 'geist-mono-OFL.txt'), 'utf8').trim() },
    ],
  })
  const file = join(pkg, 'dist', 'THIRD-PARTY-NOTICES.txt')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

// A bad flag stops here, before anything builds.
const args = parsePackageArgs(process.argv.slice(2))

const built = spawnSync('pnpm -w run build', { cwd: root, shell: true, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

// No signing, also on a machine that has a certificate.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name]

const files = await build({
  ...builderOptions({ noticesFile: writeNotices(), ...args }),
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
})
console.log(`pod-board: packaged, and published nothing:\n${files.join('\n')}`)
