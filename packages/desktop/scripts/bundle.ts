// `pnpm --filter @pod-board/desktop build`: the main process, in dist/main.cjs.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleDesktop } from '../src/bundle-desktop.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
await bundleDesktop({ entry: join(pkg, 'src', 'main.ts'), outfile: join(pkg, 'dist', 'main.cjs') })
console.log(`pod-board: bundled the desktop main process in ${join(pkg, 'dist')}`)
