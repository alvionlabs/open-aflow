// SPIKE ONLY. `tsx spike/bundle.ts`: main, pty host, and page into dist-spike/.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'dist-spike')
mkdirSync(out, { recursive: true })
const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' } as const
await build({ ...node, entryPoints: [join(here, 'spike-main.ts')], outfile: join(out, 'spike-main.cjs'), external: ['electron'] })
await build({ ...node, entryPoints: [join(here, 'pty-host.ts')], outfile: join(out, 'pty-host.cjs'), external: ['@lydell/node-pty'] })
await build({ bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', logLevel: 'warning', entryPoints: [join(here, 'page.ts')], outfile: join(out, 'page.js') })
const require = createRequire(import.meta.url)
copyFileSync(join(dirname(require.resolve('@xterm/xterm/package.json')), 'css', 'xterm.css'), join(out, 'xterm.css'))
for (const f of ['page.html', 'preload.cjs']) copyFileSync(join(here, f), join(out, f))
console.log(`spike: bundled into ${out}`)
