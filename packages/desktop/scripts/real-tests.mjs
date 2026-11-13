// `pnpm test:electron`: the tests that start the real Electron binary. `pnpm verify` skips them.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..')

const needed = [join(root, 'packages', 'server', 'dist', 'app', 'server.mjs'), join(pkg, 'dist', 'main.cjs'), join(pkg, 'dist', 'preload.cjs')]
const missing = needed.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`openaflow: no bundle at ${missing.join(', ')}. Run pnpm build first.`)
  process.exit(1)
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const run = spawnSync(process.execPath, [vitest, 'run', 'packages/desktop/src/real-'], {
  cwd: root,
  env: { ...process.env, OPENAFLOW_REAL_ELECTRON: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
process.exit(run.status ?? 1)
