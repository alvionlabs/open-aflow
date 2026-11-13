// `pnpm --filter @openaflow/desktop build`: the main process in dist/main.cjs, and the window's preload in
// dist/preload.cjs. The preload sits beside main.cjs, where window-main.ts looks for it.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleDesktop } from '../src/bundle-desktop.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
await bundleDesktop({ entry: join(pkg, 'src', 'main.ts'), outfile: join(pkg, 'dist', 'main.cjs') })
await bundleDesktop({ entry: join(pkg, 'src', 'preload-main.ts'), outfile: join(pkg, 'dist', 'preload.cjs') })
console.log(`openaflow: bundled the desktop main process and preload in ${join(pkg, 'dist')}`)
