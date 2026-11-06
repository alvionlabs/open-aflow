// `pnpm test:install`: the tests that install the real app on this machine. `pnpm verify` skips them.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..')
const release = join(pkg, 'release')

const installers = existsSync(release) ? readdirSync(release).filter((name) => /^open-aflow-setup-.*\.exe$/.test(name)) : []
if (installers.length === 0) {
  console.error(`pod-board: no installer in ${release}. Run pnpm package first.`)
  process.exit(1)
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const filters = process.argv.slice(2)
const run = spawnSync(process.execPath, [vitest, 'run', '--reporter=verbose', '--silent=false', ...(filters.length > 0 ? filters : ['packages/desktop/src/proof-'])], {
  cwd: root,
  env: { ...process.env, POD_BOARD_REAL_INSTALL: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
process.exit(run.status ?? 1)
