// `pnpm release:check <output dir>`: checks a packaged build, then installs it, starts it, and uninstalls it. It
// publishes nothing. `pnpm release:check --tag=<tag>` checks only the tag against the package version.
// Each failure exits non-zero and names its step.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'
import { finishProof, launch, machineState, proofLastLine, proofPlace, refuseRealInstall, silentInstall, waitForHealth, withInstallLock } from '../src/install-check.ts'
import { checkNoTestFeed, checkSize, checkUpdateFile, pickInstaller, tagVersion } from '../src/release-rules.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Above the shared default: a runner's first start of an unsigned exe can be slow. */
const HEALTH_MS = 120_000

class StepError extends Error {}

/** Runs one step, and names the step in its failure. */
async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof StepError) throw err
    throw new StepError(`release check failed at ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `POD_BOARD_API_PORT` has no fallback, so a busy port would fail the start, or let another app answer the health check. */
const freePort = (wanted: number) =>
  new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(wanted, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address !== null && typeof address === 'object' ? done(address.port) : fail(new Error('no port'))))
    })
  })


/** Installs, reads the installed asar, starts the exe, and uninstalls in every case. */
async function installAndStart(installer: string): Promise<void> {
  const before = await machineState()
  await step('machine state', () => refuseRealInstall(before))
  const place = proofPlace(await step('port', () => freePort(Number(process.env.POD_BOARD_PROOF_PORT ?? 0))))
  let failure: unknown
  let diff: string[] | undefined
  try {
    await step('install', () => silentInstall(installer, place))
    await step('test feed', () => checkNoTestFeed(extractFile(join(place.installDir, 'resources', 'app.asar'), join('dist', 'main.cjs')).toString('utf8')))
    await step('launch', () => launch(place))
    await step('health', () => waitForHealth(place, HEALTH_MS))
  } catch (err) {
    failure = err
  } finally {
    try {
      diff = await finishProof(place, before)
    } catch (err) {
      console.error(`release check failed at uninstall: ${err instanceof Error ? err.message : String(err)}`)
      failure ??= new StepError('release check failed at uninstall')
    }
  }
  if (failure !== undefined) throw failure
  if (diff !== undefined && diff.length > 0) throw new StepError(`release check failed at state diff: ${diff.join('; ')}`)
  console.log(proofLastLine(diff ?? []))
}

async function checkBuild(dir: string): Promise<void> {
  await step('output folder', () => {
    if (!existsSync(dir)) throw new Error(`no folder ${dir}: run pnpm package first`)
  })
  const name = await step('installer', () => pickInstaller(readdirSync(dir)))
  const installer = join(dir, name)
  const bytes = readFileSync(installer)
  await step('size', () => checkSize(statSync(installer).size))
  await step('update file', () => {
    const yml = join(dir, 'latest.yml')
    if (!existsSync(yml)) throw new Error('latest.yml is missing')
    checkUpdateFile(readFileSync(yml, 'utf8'), bytes, name)
  })
  await step('blockmap', () => {
    if (!existsSync(`${installer}.blockmap`)) throw new Error(`${name}.blockmap is missing`)
  })
  // A proof that holds the lock around this script says so. A second take in one chain would wait for itself.
  if (process.env.POD_BOARD_INSTALL_LOCK_HELD === '1') await installAndStart(installer)
  else await withInstallLock(() => installAndStart(installer))
  console.log(`pod-board: the release check passed for ${name}`)
}

async function main(argv: string[]): Promise<void> {
  const args = argv.filter((arg) => arg !== '--')
  const tag = args.find((arg) => arg.startsWith('--tag='))
  if (args.length !== 1) throw new StepError('usage: pnpm release:check <output dir>, or pnpm release:check --tag=<tag>')
  if (tag !== undefined) {
    const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string }
    await step('tag', () => tagVersion(tag.slice('--tag='.length), version))
    console.log(`pod-board: the tag matches version ${version}`)
    return
  }
  // `pnpm --filter … exec` moves into the package folder. INIT_CWD is where the human typed the command.
  await checkBuild(resolve(process.env.INIT_CWD ?? process.cwd(), args[0]!))
}

try {
  await main(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
