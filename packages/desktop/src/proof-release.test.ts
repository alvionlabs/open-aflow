import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackage, extractAll } from '@electron/asar'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { builderOptions } from './build-config.ts'
import { machineState, proofLastLine, refuseRealInstall, stateDiff, withInstallLock, type MachineState } from './install-check.ts'

// The release check's own proof: a real `pnpm package` in a temp folder, then `pnpm release:check` on that build and
// on three builds that must fail. `pnpm test:install` runs it; `pnpm verify` skips it. Nothing here publishes.

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..', '..')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'release.yml')
const PORT = process.env.OPEN_AFLOW_PROOF_PORT ?? '3130'
const RUN_MS = 600_000
const LOCK_MS = 40 * 60_000
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

const ACTIONLINT_VERSION = '1.7.12'
const ACTIONLINT_SHA256 = '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'
const ACTIONLINT_ZIP = `actionlint_${ACTIONLINT_VERSION}_windows_amd64.zip`
const ACTIONLINT_URL = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${ACTIONLINT_ZIP}`

type Run = { status: number | null; output: string }

/** Async, so a long run doesn't block the test worker. */
const shell = (command: string, env: NodeJS.ProcessEnv) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn(command, { cwd: ROOT, env, shell: true, windowsHide: true })
    let output = ''
    child.stdout.on('data', (d) => (output += String(d)))
    child.stderr.on('data', (d) => (output += String(d)))
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, output }))
  })

/** This proof holds the lock, so the check must not wait for it. */
const releaseCheck = (dir: string) => shell(`pnpm release:check "${dir}"`, { ...process.env, OPEN_AFLOW_PROOF_PORT: PORT, OPEN_AFLOW_INSTALL_LOCK_HELD: '1' })

describe.runIf(process.env.OPEN_AFLOW_REAL_INSTALL === '1' && process.platform === 'win32')('the release check proof', () => {
  let freeLock: () => void = () => {}
  let lockDone: Promise<void> = Promise.resolve()
  let before: MachineState | undefined
  let work = ''
  let good = ''

  /** A real installer from a changed copy of the good app, so the check meets a fault as a release would. */
  const buildFrom = async (name: string, change: (resources: string) => void | Promise<void>): Promise<string> => {
    const app = join(work, `${name}-app`)
    cpSync(join(good, 'win-unpacked'), app, { recursive: true })
    await change(join(app, 'resources'))
    const output = join(work, name)
    const { build, Platform, Arch } = await import('electron-builder')
    await build({
      ...builderOptions({ noticesFile: join(app, 'resources', 'THIRD-PARTY-NOTICES.txt'), output }),
      prepackaged: app,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    })
    return output
  }

  const expectLeftNothing = async () => {
    expect(stateDiff(before!, await machineState())).toEqual([])
  }

  beforeAll(async () => {
    await new Promise<void>((held) => {
      lockDone = withInstallLock(
        () =>
          new Promise<void>((free) => {
            freeLock = free
            held()
          }),
      )
      // A lock that can't be had reaches the first test as its failure.
      lockDone.catch(() => held())
    })
    before = await machineState()
    refuseRealInstall(before)
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'open-aflow-release-proof-')))
    good = join(work, 'good')
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD']) delete env[name]
    const run = await shell(`pnpm package "--output=${good}"`, env)
    if (run.status !== 0) throw new Error(`pnpm package failed:\n${run.output}`)
  }, LOCK_MS)

  afterAll(async () => {
    try {
      if (work) rmSync(work, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
    } finally {
      freeLock()
      await lockDone.catch(() => {})
    }
  }, RUN_MS)

  test(
    'the check passes on a good build',
    async () => {
      const run = await releaseCheck(good)
      expect(run.status, run.output).toBe(0)
      expect(run.output).toMatch(/state diff: \[\]/)
      await expectLeftNothing()
    },
    RUN_MS,
  )

  test(
    "fails when the app doesn't start",
    async () => {
      const broken = await buildFrom('broken', (resources) => {
        writeFileSync(join(resources, 'server', 'server.mjs'), "console.log('broken-server-marker'); throw new Error('broken-server-marker')\n")
      })
      const run = await releaseCheck(broken)
      expect(run.status, run.output).not.toBe(0)
      expect(run.output).toMatch(/release check failed at health/)
      expect(run.output).toContain('broken-server-marker')
      await expectLeftNothing()
    },
    RUN_MS,
  )

  test(
    'fails on size and on a test feed',
    async () => {
      const small = join(work, 'small')
      mkdirSync(small)
      for (const name of readdirSync(good).filter((n) => /^open-aflow-setup-.*\.exe(\.blockmap)?$/.test(n) || n === 'latest.yml')) copyFileSync(join(good, name), join(small, name))
      const installer = join(small, readdirSync(small).find((name) => name.endsWith('.exe'))!)
      writeFileSync(installer, readFileSync(installer).subarray(0, 1024 * 1024))
      const shrunk = await releaseCheck(small)
      expect(shrunk.status, shrunk.output).not.toBe(0)
      expect(shrunk.output).toMatch(/release check failed at size/)

      const fed = await buildFrom('fed', async (resources) => {
        const asar = join(resources, 'app.asar')
        const open = join(work, 'fed-asar')
        extractAll(asar, open)
        const main = join(open, 'dist', 'main.cjs')
        writeFileSync(main, `${readFileSync(main, 'utf8')}\n// OPEN_AFLOW_UPDATE_TEST_FEED\n`)
        await createPackage(open, asar)
      })
      const run = await releaseCheck(fed)
      expect(run.status, run.output).not.toBe(0)
      expect(run.output).toMatch(/release check failed at test feed/)
      await expectLeftNothing()
    },
    RUN_MS,
  )

  test(
    'actionlint passes',
    async () => {
      const dir = join(work, 'actionlint')
      mkdirSync(dir)
      const zip = join(dir, ACTIONLINT_ZIP)
      const res = await fetch(ACTIONLINT_URL)
      expect(res.ok, ACTIONLINT_URL).toBe(true)
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
      expect(createHash('sha256').update(readFileSync(zip)).digest('hex')).toBe(ACTIONLINT_SHA256)
      const unpacked = join(dir, 'unpacked')
      mkdirSync(unpacked)
      const expanded = spawnSync(join(SYS32, 'tar.exe'), ['-xf', zip, '-C', unpacked], { encoding: 'utf8', windowsHide: true })
      expect(expanded.status, expanded.stderr).toBe(0)
      const lint = spawnSync(join(unpacked, 'actionlint.exe'), [WORKFLOW], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
      expect(`${lint.stdout}${lint.stderr}`).toBe('')
      expect(lint.status).toBe(0)
    },
    RUN_MS,
  )

  test(
    'leaves nothing behind',
    async () => {
      const diff = stateDiff(before!, await machineState())
      console.log(proofLastLine(diff))
      expect(diff).toEqual([])
    },
    RUN_MS,
  )
})
