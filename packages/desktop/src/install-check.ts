// What every install proof uses: a temp place, the machine-wide lock, the machine's state before and after, and the
// install, launch, and uninstall steps. No `electron` import. The rules are in pod-docs/sprints/installer-and-updates.md.

import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { processAlive } from '@pod-board/server/parent-link'
import { EXE_NAME, UPDATER_CACHE_DIR } from './build-config.ts'
import { APP_ID, APP_NAME } from './shell-config.ts'

const OWNER_FILE = 'auto-continue-owner.json'
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
const SYS32 = join(SYSTEM_ROOT, 'System32')
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const UNINSTALLER = `Uninstall ${APP_NAME}.exe`
const LOCK_FILE = 'pod-board-install-proof.lock'
const LOCK_WAIT_MS = 30 * 60_000
/** A lock file with no process ID is one that a holder is writing, until it's this old. */
const UNREADABLE_LOCK_MS = 60_000
const HEALTH_MS = 90_000
const INSTALL_MS = 180_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type ProofPlace = { root: string; installDir: string; env: NodeJS.ProcessEnv; port: number }

/** Inherits only what isn't this project's or the caller's: a stripped env, so a run can't reach a real folder. */
function strippedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    const dropped = ['POD_BOARD_', 'CLAUDE', 'ELECTRON_', 'VITEST', 'FAKE_CLAUDE', 'NODE_', 'NPM_', 'PNPM_'].some((prefix) => upper.startsWith(prefix))
    if (!dropped && upper !== 'PATH') env[key] = value
  }
  return { ...env, SystemRoot: SYSTEM_ROOT, Path: SYS32 }
}

/** Temp root named pod-board-install-proof-*; install folder, config, shell data, ports, and claude folders inside it. */
export function proofPlace(port: number): ProofPlace {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-install-proof-')))
  const folder = (name: string) => {
    const path = join(root, name)
    mkdirSync(path)
    return path
  }
  return {
    root,
    port,
    installDir: join(root, 'install'),
    env: {
      ...strippedEnv(),
      POD_BOARD_API_PORT: String(port),
      POD_BOARD_CONFIG_DIR: folder('config'),
      POD_BOARD_DESKTOP_DATA_DIR: folder('shell'),
      POD_BOARD_PORTS_DIR: folder('ports'),
      POD_BOARD_CLAUDE_DIR: folder('claude'),
      // In production the server uses this path only, so no run can find a real claude.
      POD_BOARD_CLAUDE_BIN: join(root, 'no-claude', 'claude.cmd'),
    },
  }
}

type LockOptions = { path?: string; pollMs?: number; waitMs?: number }

/** Creates the file only when it doesn't exist. Answers false when another holder has it. */
function tryCreate(path: string, text: string): boolean {
  try {
    const fd = openSync(path, 'wx')
    writeSync(fd, text)
    closeSync(fd)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** The holder's process ID, `stale`, or `gone`. */
function readHolder(path: string): number | 'stale' | 'gone' {
  try {
    const text = readFileSync(path, 'utf8').trim()
    const pid = Number(text)
    if (text !== '' && Number.isInteger(pid) && pid > 0) return processAlive(pid) ? pid : 'stale'
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_LOCK_MS ? 'stale' : process.pid
  } catch {
    return 'gone'
  }
}

/** Only the one who makes the guard file may remove a stale lock, so a waiter never removes a newer holder's lock. */
function takeOver(path: string): void {
  const guard = `${path}.takeover`
  if (!tryCreate(guard, String(process.pid))) {
    if (readHolder(guard) === 'stale') rmSync(guard, { force: true })
    return
  }
  try {
    if (readHolder(path) === 'stale') rmSync(path, { force: true })
  } finally {
    rmSync(guard, { force: true })
  }
}

/** One holder per machine. Waits up to 30 min; a holder whose process ID is gone is stale and is taken over. */
export async function withInstallLock<T>(fn: () => Promise<T>, o: LockOptions = {}): Promise<T> {
  const path = o.path ?? join(tmpdir(), LOCK_FILE)
  const end = Date.now() + (o.waitMs ?? LOCK_WAIT_MS)
  let holder: number | 'stale' | 'gone' = 'gone'
  while (!tryCreate(path, String(process.pid))) {
    holder = readHolder(path)
    if (holder === 'stale') takeOver(path)
    else if (Date.now() > end) throw new Error(`the install lock ${path} is still held by process ${holder}`)
    await sleep(o.pollMs ?? 1000)
  }
  try {
    return await fn()
  } finally {
    rmSync(path, { force: true })
  }
}

/** realConfig: each file's name and modified time in the real config folder; null when there's no folder. */
export type MachineState = { uninstallKeys: string[]; runValue: string | null; startMenu: string[]; apps: number[]; updaterCache: boolean; realConfig: string[] | null }

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name)
      return `${relative(dir, path).replaceAll('\\', '/')} ${statSync(path).mtimeMs}`
    })
    .sort()
}

function ownerLives(dir: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as { pid?: unknown }
    return typeof pid === 'number' && processAlive(pid)
  } catch {
    return false
  }
}

/** A live server at the first read leaves the folder out for the whole proof: its files change on their own. */
export function createRealConfigReader(dir: string): () => { files: string[] | null; held: boolean } {
  let held: boolean | undefined
  return () => {
    held ??= ownerLives(dir)
    if (held) return { files: null, held: true }
    return { files: existsSync(dir) ? listFiles(dir) : null, held: false }
  }
}

const realConfigDir = () => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'pod-board')
const updaterCacheDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), UPDATER_CACHE_DIR)
const startMenuDir = () => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
let readRealConfig: ReturnType<typeof createRealConfigReader> | undefined
const realConfig = () => (readRealConfig ??= createRealConfigReader(realConfigDir()))()

/** Answers the tool's standard output. A non-zero exit means "not found" for the read-only tools used here. */
const stdoutOf = (file: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout))
  })

async function uninstallKeys(): Promise<string[]> {
  const queries = [
    `HKCU\\${UNINSTALL_KEY}`,
    `HKLM\\${UNINSTALL_KEY}`,
    `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
  ].map((key) => stdoutOf(join(SYS32, 'reg.exe'), ['query', key, '/s', '/d', '/f', APP_NAME]))
  const lines = (await Promise.all(queries)).flatMap((text) => text.split(/\r?\n/))
  return [...new Set(lines.filter((line) => line.startsWith('HKEY_')).map((line) => line.trim()))].sort()
}

async function runValue(): Promise<string | null> {
  const text = await stdoutOf(join(SYS32, 'reg.exe'), ['query', RUN_KEY, '/v', APP_ID])
  return new RegExp(`^\\s*${APP_ID.replaceAll('.', '\\.')}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null
}

function startMenuEntries(): string[] {
  const dir = startMenuDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.name.toLowerCase().includes(APP_NAME.toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

async function appProcesses(): Promise<number[]> {
  const text = await stdoutOf(join(SYS32, 'tasklist.exe'), ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'])
  return text
    .split(/\r?\n/)
    .map((line) => /^"[^"]+","(\d+)"/.exec(line)?.[1])
    .filter((pid) => pid !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
}

export async function machineState(): Promise<MachineState> {
  const [keys, run, apps] = await Promise.all([uninstallKeys(), runValue(), appProcesses()])
  return { uninstallKeys: keys, runValue: run, startMenu: startMenuEntries(), apps, updaterCache: existsSync(updaterCacheDir()), realConfig: realConfig().files }
}

/** Empty when nothing differs. Each line names one leftover. */
export function stateDiff(before: MachineState, after: MachineState): string[] {
  const added = <T>(was: T[], now: T[]) => now.filter((item) => !was.includes(item))
  const lines = [
    ...added(before.uninstallKeys, after.uninstallKeys).map((key) => `uninstall key: ${key}`),
    ...(after.runValue === before.runValue ? [] : [`Run value: ${after.runValue ?? 'removed'}, was ${before.runValue ?? 'unset'}`]),
    ...added(before.startMenu, after.startMenu).map((entry) => `Start-menu entry: ${entry}`),
    ...added(before.apps, after.apps).map((pid) => `app process: ${pid}`),
    ...(after.updaterCache === before.updaterCache ? [] : [`updater cache: ${after.updaterCache ? 'left behind' : 'removed'} (${UPDATER_CACHE_DIR})`]),
  ]
  const was = before.realConfig ?? []
  const now = after.realConfig ?? []
  const nameOf = (entry: string) => entry.slice(0, entry.lastIndexOf(' '))
  const wasNames = was.map(nameOf)
  const nowNames = now.map(nameOf)
  for (const entry of added(was, now)) lines.push(`real config: ${wasNames.includes(nameOf(entry)) ? 'changed' : 'new'} file ${nameOf(entry)}`)
  for (const name of added(nowNames, wasNames)) lines.push(`real config: removed file ${name}`)
  return lines
}

/** Throws, naming what it found, when Pod Board is already installed for this user. */
export function refuseRealInstall(state: MachineState): void {
  const found = [
    ...state.uninstallKeys.map((key) => `uninstall key ${key}`),
    ...state.startMenu.map((entry) => `Start-menu entry ${entry}`),
    ...(state.runValue === null ? [] : [`Run value ${state.runValue}`]),
    ...state.apps.map((pid) => `app process ${pid}`),
  ]
  if (found.length > 0) throw new Error(`${APP_NAME} is already on this machine, so the proof won't install over it: ${found.join('; ')}`)
}

const exitOf = (file: string, args: string[], ms: number, verbatim = false) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim })
    const timer = setTimeout(() => reject(new Error(`${file} took over ${ms} ms`)), ms)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })

/** `/S /D=<installDir>`. NSIS reads `/D=` raw, with no quotes, as the last argument. */
export async function silentInstall(installer: string, place: ProofPlace): Promise<void> {
  if (!existsSync(installer)) throw new Error(`no installer at ${installer}: run pnpm package first`)
  const code = await exitOf(installer, ['/S', `/D=${place.installDir}`], INSTALL_MS, true)
  if (code !== 0) throw new Error(`the installer exited with ${code}`)
  if (!existsSync(join(place.installDir, EXE_NAME))) throw new Error(`the installer put no ${EXE_NAME} in ${place.installDir}`)
}

/** Each main process a proof starts, so that its end stops only those. */
const launched = new Set<number>()
let lastOutput: () => string = () => ''

export async function launch(place: ProofPlace, args: string[] = []): Promise<{ pid: number; output(): string }> {
  const child = spawn(join(place.installDir, EXE_NAME), args, { cwd: place.root, env: place.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let text = ''
  child.stdout.on('data', (d) => (text += String(d)))
  child.stderr.on('data', (d) => (text += String(d)))
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  launched.add(child.pid!)
  lastOutput = () => text
  return { pid: child.pid!, output: () => text }
}

/** /api/health answers {"ok":true}; a timeout throws, with the output tail. */
export async function waitForHealth(place: ProofPlace, ms = HEALTH_MS): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${place.port}/api/health`)
      if (((await res.json()) as { ok?: unknown }).ok === true) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > end) throw new Error(`no health answer on port ${place.port} in ${ms} ms. Output tail:\n${lastOutput().slice(-2000)}`)
    await sleep(250)
  }
}

/**
 * Waits until the install folder and the registry keys are gone: NSIS re-launches itself, so the first process exits
 * at once, and the copy removes the folder first and the keys last.
 */
export async function silentUninstall(place: ProofPlace): Promise<void> {
  const uninstaller = join(place.installDir, UNINSTALLER)
  if (!existsSync(uninstaller)) throw new Error(`no uninstaller at ${uninstaller}`)
  const keys = await uninstallKeys()
  const code = await exitOf(uninstaller, ['/currentuser', '/S'], INSTALL_MS)
  if (code !== 0) throw new Error(`the uninstaller exited with ${code}`)
  // electron-builder names the app's own key after its uninstall key.
  const appKeys = keys.map((key) => `HKCU\\Software\\${key.split('\\').pop()!}`)
  const left = async () => [
    ...(existsSync(place.installDir) ? [place.installDir] : []),
    ...(await uninstallKeys()).filter((key) => keys.includes(key)),
    ...(await Promise.all(appKeys.map(async (key) => ((await stdoutOf(join(SYS32, 'reg.exe'), ['query', key])) === '' ? '' : key)))).filter((key) => key !== ''),
  ]
  const end = Date.now() + INSTALL_MS
  for (;;) {
    const remaining = await left()
    if (remaining.length === 0) return
    if (Date.now() > end) throw new Error(`the uninstaller left ${remaining.join(', ')}`)
    await sleep(250)
  }
}

/** A killed process's handles close a moment after it's gone, so try the removal again. */
async function removeWithRetry(path: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 200 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await sleep(100)
    }
  }
}

/**
 * The `finally` of every proof, on a pass or a failure: uninstalls, removes the temp root and the updater cache the
 * install made, and answers the diff against the state from before the install. It ends only processes a proof
 * started, by their recorded process IDs. The uninstaller ends the rest, the server included.
 */
export async function finishProof(place: ProofPlace, before: MachineState): Promise<string[]> {
  for (const pid of launched) {
    if (processAlive(pid)) {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
  }
  launched.clear()
  if (existsSync(join(place.installDir, UNINSTALLER))) await silentUninstall(place)
  // A failed uninstall can't take a Run value with it. This one names the temp folder, so it's the proof's own.
  if ((await runValue())?.includes(place.root)) await stdoutOf(join(SYS32, 'reg.exe'), ['delete', RUN_KEY, '/v', APP_ID, '/f'])
  if (!before.updaterCache) await removeWithRetry(updaterCacheDir())
  await removeWithRetry(place.root)
  return stateDiff(before, await machineState())
}

/** Every proof's final line. */
export function proofLastLine(diff: string[]): string {
  const held = realConfig().held ? ' (a live server holds the real config folder, so realConfig reads null in both states)' : ''
  return `state diff: ${JSON.stringify(diff)}${held}`
}
