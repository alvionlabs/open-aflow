// `pnpm --filter @open-aflow/server bundle`: the web build and the server, in dist/app.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleApp } from '../src/bundle-app.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(pkg, 'dist', 'app')
await bundleApp({ webDist: join(pkg, '..', 'web', 'dist'), outDir })
console.log(`open-aflow: bundled in ${outDir}`)
