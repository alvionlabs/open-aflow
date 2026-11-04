// `pnpm package [--version=<x.y.z>] [--output=<dir>] [--test-feed]`: builds, writes the licence notices, then makes the
// installer, its blockmap, and latest.yml. It always passes `publish: never`, and it signs nothing.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'
import { builderOptions, parsePackageArgs } from '../src/build-config.ts'
import { bundleDesktop } from '../src/bundle-desktop.ts'
import { packageRootsFromMetafile, productionClosure, renderNotices, type BundleMeta } from '../src/licence-notices.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..')
const server = join(pkg, '..', 'server')
const web = join(pkg, '..', 'web')

/** For a package that ships no licence file. Each entry says where its text comes from. */
const LICENCE_OVERRIDES: Record<string, string> = {
  // Its package.json says `"license": "MIT"` and names the author. It ships no licence file, so this is the MIT text.
  'lazy-val': `MIT License

Copyright (c) Vladimir Krivosheev

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
}

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
const { testFeed = false, ...args } = parsePackageArgs(process.argv.slice(2))

const built = spawnSync('pnpm -w run build', { cwd: root, shell: true, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

// No signing, also on a machine that has a certificate.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name]

const mainBundle = { entry: join(pkg, 'src', 'main.ts'), outfile: join(pkg, 'dist', 'main.cjs') }
if (testFeed) await bundleDesktop({ ...mainBundle, testFeed: true })
try {
  const files = await build({
    ...builderOptions({ noticesFile: writeNotices(), ...args }),
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  })
  console.log(`pod-board: packaged, and published nothing:\n${files.join('\n')}`)
} finally {
  // dist/main.cjs never stays a test build.
  if (testFeed) await bundleDesktop(mainBundle)
}
