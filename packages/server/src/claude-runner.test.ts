import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { childEnv, claudeBin, createClaudeRunner, MAX_RESUME_LOGS, pruneLogs, RESUME_WINDOW_MS } from './claude-runner.ts'
import { createToolFinder } from './tool-finder.ts'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, '..', 'test', 'fake-claude.mjs')
const WIN = process.platform === 'win32'
const SESSION = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'

type Record = { argv: string[]; env: { [k: string]: string }; cwd: string; pid: number }

let realTmp: string
let tmp: string
let binDir: string
let logDir: string
let repo: string
let recordFile: string
let pidsFile: string

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** An npm-style `.cmd` shim, as `npm install -g` writes it for a JS bin. */
const npmShim = (rel: string) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    '',
  ].join('\r\n')

/** A shim the runner can't read, so it goes through cmd.exe. */
const plainShim = () => `@ECHO off\r\n"${process.execPath}" "${FAKE}" %*\r\n`

/**
 * Installs the fake in `dir`: on Windows as `claude.cmd`, an npm-style shim (with the
 * extensionless sh twin npm also writes), on POSIX as an executable `claude`.
 */
function installFake(dir: string, shim: 'npm' | 'plain' = 'npm'): void {
  mkdirSync(dir, { recursive: true })
  if (WIN) {
    const pkg = join(dir, 'node_modules', 'fake-claude')
    mkdirSync(pkg, { recursive: true })
    copyFileSync(FAKE, join(pkg, 'cli.mjs'))
    writeFileSync(join(dir, 'claude.cmd'), shim === 'npm' ? npmShim('node_modules\\fake-claude\\cli.mjs') : plainShim())
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho not this one\n')
  } else {
    const file = join(dir, 'claude')
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
    chmodSync(file, 0o755)
  }
}

/** The board's env with PATH set to only the fake's folder, plus the fake's settings. */
function envWith(extra: { [k: string]: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v
  return { ...env, PATH: binDir, FAKE_CLAUDE_RECORD: recordFile, FAKE_CLAUDE_PIDS: pidsFile, ...extra }
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const readRecord = async (): Promise<Record> => {
  await waitFor(() => existsSync(recordFile))
  return JSON.parse(readFileSync(recordFile, 'utf8')) as Record
}

/** Every fake the test started, from the pid file each one appends to. */
const startedPids = (): number[] =>
  existsSync(pidsFile)
    ? readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number)
    : []

/**
 * Removes `path`, trying again on EPERM, EBUSY, and ENOTEMPTY. On Windows a killed child's
 * handles (its working folder, its log) close a moment after `kill(pid, 0)` already says it's
 * gone, and Node's own `maxRetries` doesn't retry that EPERM.
 */
const removeWithRetry = async (path: string, opts: { recursive?: boolean } = {}) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { ...opts, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 40 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

beforeEach(() => {
  // The temp root sits behind a link, like macOS /var -> /private/var.
  realTmp = mkdtempSync(join(tmpdir(), 'claude-runner-'))
  tmp = `${realTmp}-link`
  symlinkSync(realTmp, tmp, 'junction')
  binDir = join(tmp, 'bin')
  logDir = join(tmp, 'logs')
  repo = join(tmp, 'repo')
  recordFile = join(tmp, 'record.json')
  pidsFile = join(tmp, 'pids.txt')
  mkdirSync(repo)
  installFake(binDir)
})

afterEach(async () => {
  // Stop every fake this test started, wait for each to exit, then remove the folders they ran in.
  const pids = startedPids()
  for (const pid of pids) if (alive(pid)) process.kill(pid)
  await waitFor(() => pids.every((p) => !alive(p)))
  await removeWithRetry(tmp)
  await removeWithRetry(realTmp, { recursive: true })
})

describe('createClaudeRunner', () => {
  test('passes only the resume arguments', async () => {
    const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 3000 })
    const res = await runner.start({ session: SESSION, word: 'continue', cwd: repo })
    expect(res).toEqual({ outcome: 'started' })
    expect((await readRecord()).argv).toEqual(['-p', '--resume', SESSION, 'continue'])

    rmSync(recordFile)
    await runner.start({ session: SESSION, word: 'go', cwd: repo })
    const argv = (await readRecord()).argv
    expect(argv).toEqual(['-p', '--resume', SESSION, 'go'])
    expect(argv).not.toContain('--bare')
  })

  test('a resumed run gets the two machine settings and none of the dropped names', async () => {
    const kept = { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\fake\\bash.exe', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1234' }
    const dropped = ['CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_FOO']
    const env = envWith({ ...kept, ...Object.fromEntries(dropped.map((n) => [n, 'fake'])) })
    const runner = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    const seen = (await readRecord()).env
    expect(seen.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(kept.CLAUDE_CODE_MAX_OUTPUT_TOKENS)
    const names = Object.keys(seen).map((k) => k.toUpperCase())
    for (const n of dropped) expect(names).not.toContain(n)
    if (WIN) expect(seen.CLAUDE_CODE_GIT_BASH_PATH).toBe(kept.CLAUDE_CODE_GIT_BASH_PATH)
  })

  test('strips api keys from the env', async () => {
    const env = envWith({
      ANTHROPIC_API_KEY: 'sk-1',
      anthropic_auth_token: 'tok-2',
      Anthropic_Api_Key: 'sk-3',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      POD_BOARD_SMOKE: 'kept',
    })
    const runner = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    const names = Object.keys((await readRecord()).env).map((k) => k.toUpperCase())
    expect(names).not.toContain('ANTHROPIC_API_KEY')
    expect(names).not.toContain('ANTHROPIC_AUTH_TOKEN')
    const seen = (await readRecord()).env
    expect(names).not.toContain('ANTHROPIC_BASE_URL')
    expect(seen.POD_BOARD_SMOKE).toBe('kept')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-1') // the board's own env is left alone
  })

  test('a claude in the repo folder never runs, even with a relative entry on PATH', async () => {
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    installFake(repo) // a cloned repo with its own claude at its root
    const sep = WIN ? ';' : ':'
    // `rel` names the repo folder from the board's own folder; `.` names it from the child's.
    const home = process.cwd()
    process.chdir(tmp)
    try {
      const rel = path.relative(process.cwd(), repo)
      expect(path.isAbsolute(rel)).toBe(false)
      const env = { ...envWith(), PATH: ['.', '', rel, empty].join(sep) }
      const runner = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 3000 })
      expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({
        outcome: 'failed',
        message: 'claude not found',
      })
    } finally {
      process.chdir(home)
    }
    expect(existsSync(recordFile)).toBe(false)
  })

  test.runIf(WIN)('a cmd shim runs through an absolute cmd.exe, even when COMSPEC is a bare name', async () => {
    const plain = join(tmp, 'plain')
    installFake(plain, 'plain')
    // A cmd.exe planted in the repo folder: a harmless system tool that never starts the fake.
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(repo, 'cmd.exe'))
    const env = envWith({ COMSPEC: 'cmd.exe' })
    for (const k of Object.keys(env)) if (k !== 'COMSPEC' && k.toUpperCase() === 'COMSPEC') delete env[k]
    const runner = createClaudeRunner({ bin: join(plain, 'claude.cmd'), logDir, env, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'go', cwd: repo })).toEqual({ outcome: 'started' })
    expect((await readRecord()).argv).toEqual(['-p', '--resume', SESSION, 'go'])
  })

  test.runIf(WIN)('a shim run through cmd.exe never runs a same-named .bat from the repo folder', async () => {
    // A pnpm/yarn-style shim the runner can't read: it calls a bare `node`.
    const shimDir = join(tmp, 'unreadable')
    mkdirSync(shimDir)
    copyFileSync(FAKE, join(shimDir, 'cli.mjs'))
    writeFileSync(join(shimDir, 'claude.cmd'), '@node "%~dp0cli.mjs" %*\r\n')
    const planted = join(repo, 'PLANTED.txt')
    writeFileSync(join(repo, 'node.bat'), `@echo planted> "${planted}"\r\n`)
    const env = envWith()
    // Claude Code sets this in its own shells; the board's env may not have it.
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete env[k]
    env.PATH = [binDir, dirname(process.execPath)].join(';')
    const runner = createClaudeRunner({ bin: join(shimDir, 'claude.cmd'), logDir, env, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect(existsSync(planted)).toBe(false)
    expect((await readRecord()).argv).toEqual(['-p', '--resume', SESSION, 'continue'])
  }, 15_000)

  test('refuses an unsafe session id', async () => {
    const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 3000 })
    const bad = ['', 'a'.repeat(65), 'abc def', 'abc;calc', '../x', 'abc"&calc', '--bare', '-p', 'é']
    for (const session of bad) {
      expect(await runner.start({ session, word: 'continue', cwd: repo })).toEqual({
        outcome: 'failed',
        message: 'bad session id',
      })
      expect(runner.isRunning(session)).toBe(false)
    }
    // a word outside continue/go never reaches claude either
    const word = 'try' as 'continue'
    expect((await runner.start({ session: SESSION, word, cwd: repo })).outcome).toBe('failed')
    expect(existsSync(recordFile)).toBe(false)
    expect(existsSync(logDir) && readdirSync(logDir).length > 0).toBe(false)
  })

  test('reports claude not found', async () => {
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    const env = { ...envWith(), PATH: empty }
    const byName = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 3000 })
    expect(await byName.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({
      outcome: 'failed',
      message: 'claude not found',
    })
    const byPath = createClaudeRunner({ bin: join(empty, 'nope', 'claude'), logDir, env, windowMs: 3000 })
    expect(await byPath.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({
      outcome: 'failed',
      message: 'claude not found',
    })
    expect(byName.isRunning(SESSION)).toBe(false)
  })

  test('started when still running', async () => {
    const done = join(tmp, 'done')
    const env = envWith({ FAKE_CLAUDE_MODE: 'wait:2500', FAKE_CLAUDE_DONE: done })
    const runner = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 600 })
    const t0 = Date.now()
    const res = await runner.start({ session: SESSION, word: 'continue', cwd: repo })
    expect(res).toEqual({ outcome: 'started' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550)
    await readRecord()
    expect(runner.isRunning(SESSION)).toBe(true)
    expect(runner.isRunning('another-session')).toBe(false)
    await waitFor(() => existsSync(done))
    await waitFor(() => !runner.isRunning(SESSION))
  })

  test('isRunning stays true while any child for the session lives', async () => {
    const runner = createClaudeRunner({ bin: 'claude', logDir, windowMs: 300, env: envWith({ FAKE_CLAUDE_MODE: 'wait:2500' }) })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    await readRecord()
    const quick = createClaudeRunner({ bin: 'claude', logDir, windowMs: 3000, env: envWith() })
    await quick.start({ session: SESSION, word: 'continue', cwd: repo })
    expect(quick.isRunning(SESSION)).toBe(false)
    expect(runner.isRunning(SESSION)).toBe(true)
  })

  test('started on a quick clean exit', async () => {
    const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 5000 })
    const t0 = Date.now()
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect(Date.now() - t0).toBeLessThan(4500) // decided at exit, not at the window's end
    expect(runner.isRunning(SESSION)).toBe(false)
  })

  test('failed with the stderr tail', async () => {
    const long = 'x'.repeat(600) + 'END'
    const cases: [string, string, string][] = [
      ['exit:2', '\u001b[31mError:\u001b[0m session not found\n', 'Error: session not found'],
      ['exit:1', long, long.slice(-500)],
      ['exit:3', '', 'claude exited with code 3'],
      ['exit:4', ' \n\u001b[0m\n', 'claude exited with code 4'],
    ]
    for (const [mode, stderr, message] of cases) {
      const env = envWith({ FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STDERR: stderr })
      const runner = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 5000 })
      expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'failed', message })
      expect(runner.isRunning(SESSION)).toBe(false)
    }
    // stderr went to files under logDir
    expect(readdirSync(logDir).length).toBeGreaterThan(0)
  })

  test('runs detached in the repo folder', async () => {
    // A separate board process starts the run and then exits; the run lives on.
    const done = join(tmp, 'done')
    const host = join(tmp, 'host.mts')
    const runnerUrl = pathToFileURL(join(here, 'claude-runner.ts')).href
    writeFileSync(
      host,
      [
        `import { createClaudeRunner } from ${JSON.stringify(runnerUrl)}`,
        `const env = JSON.parse(process.env.HOST_ENV ?? '{}')`,
        `const runner = createClaudeRunner({ bin: 'claude', logDir: ${JSON.stringify(logDir)}, env, windowMs: 400 })`,
        `const res = await runner.start({ session: ${JSON.stringify(SESSION)}, word: 'continue', cwd: ${JSON.stringify(repo)} })`,
        `console.log(JSON.stringify(res))`,
        `process.exit(0)`,
      ].join('\n'),
    )
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const env = envWith({ FAKE_CLAUDE_MODE: 'wait:2000', FAKE_CLAUDE_DONE: done })
    const out = spawnSync(process.execPath, ['--import', tsx, host], {
      env: { ...process.env, HOST_ENV: JSON.stringify(env) },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(out.stderr).toBe('')
    expect(JSON.parse(out.stdout.trim())).toEqual({ outcome: 'started' })
    const record = await readRecord()
    // The OS may report the folder resolved (macOS /private/var) and in its own case, so compare resolved paths.
    expect(realpathSync.native(record.cwd)).toBe(realpathSync.native(repo))
    expect(alive(record.pid)).toBe(true) // the host is gone, the run isn't
    await waitFor(() => existsSync(done))
  })

  test.skipIf(!WIN)('runs a cmd shim on windows', async () => {
    // npm installs claude as a .cmd shim next to an extensionless sh script Windows can't run.
    const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect((await readRecord()).argv).toEqual(['-p', '--resume', SESSION, 'continue'])

    // a shim the runner can't read goes through cmd.exe, with the same arguments
    const plain = join(tmp, 'plain')
    installFake(plain, 'plain')
    rmSync(recordFile)
    const byPath = createClaudeRunner({ bin: join(plain, 'claude.cmd'), logDir, env: envWith(), windowMs: 3000 })
    expect(await byPath.start({ session: SESSION, word: 'go', cwd: repo })).toEqual({ outcome: 'started' })
    expect((await readRecord()).argv).toEqual(['-p', '--resume', SESSION, 'go'])

    // and one whose path cmd.exe would read as commands is refused, not run
    const odd = join(tmp, 'a&calc')
    installFake(odd, 'plain')
    rmSync(recordFile)
    const unsafe = createClaudeRunner({ bin: join(odd, 'claude.cmd'), logDir, env: envWith(), windowMs: 3000 })
    expect(await unsafe.start({ session: SESSION, word: 'go', cwd: repo })).toEqual({ outcome: 'failed', message: 'unsafe claude path' })
    expect(existsSync(recordFile)).toBe(false)
  })
  test('keeps only the newest resume logs', async () => {
    expect(MAX_RESUME_LOGS).toBe(20)
    mkdirSync(logDir, { recursive: true })
    const seeded = Array.from({ length: 25 }, (_, i) => `old-${i}.log`)
    seeded.forEach((name, i) => {
      const file = join(logDir, name)
      writeFileSync(file, 'x')
      utimesSync(file, 1_000 + i, 1_000 + i)
    })
    const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    const logs = readdirSync(logDir).filter((n) => n.endsWith('.log'))
    expect(logs).toHaveLength(MAX_RESUME_LOGS)
    const fresh = logs.filter((n) => n.startsWith(SESSION))
    expect(fresh).toHaveLength(1)
    expect(logs.filter((n) => n.startsWith('old-')).sort()).toEqual(seeded.slice(seeded.length - (MAX_RESUME_LOGS - 1)).sort())
    expect(statSync(join(logDir, fresh[0]!)).mtimeMs).toBeGreaterThan(1_000_000)
  })
})

describe.runIf(WIN)('the runner with the tool finder', () => {
  test('a stripped Path still starts the found claude', async () => {
    const env: NodeJS.ProcessEnv = { ...envWith(), Path: '', CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'), CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDECODE: '1', claude_pid: '7' }
    delete env.PATH
    const finder = createToolFinder({
      env,
      platform: 'win32',
      settingsFile: join(tmp, 'tool-paths.json'),
      readRegistryPath: async (hive) => (hive === 'HKCU' ? `\r\nHKEY\r\n    Path    REG_EXPAND_SZ    ${binDir}\r\n` : ''),
    })
    await finder.check()
    expect(finder.path('claude')).toBe(join(binDir, 'claude.cmd'))

    const runner = createClaudeRunner({ bin: () => finder.path('claude'), env: () => finder.env(), logDir, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })

    const record = await readRecord()
    const pathKey = Object.keys(record.env).find((k) => k.toUpperCase() === 'PATH')
    expect(record.env[pathKey!]!.split(';')).toContain(binDir)
    expect(Object.keys(record.env).filter((k) => k.toUpperCase().startsWith('CLAUDE'))).toEqual(['CLAUDE_CONFIG_DIR'])
  })

  test('the runner reads the finder at each start', async () => {
    let bin: string | undefined
    const env = envWith({ PATH: '' })
    const runner = createClaudeRunner({ bin: () => bin, env: () => env, logDir, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'failed', message: 'claude not found' })
    bin = join(binDir, 'claude.cmd')
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
  })

  test('a found claude that has since gone is a failed start', async () => {
    const runner = createClaudeRunner({ bin: () => join(tmp, 'gone', 'claude.cmd'), env: () => envWith(), logDir, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'failed', message: 'claude not found' })
  })

  test('no found claude fails the start', async () => {
    const runner = createClaudeRunner({ bin: () => undefined, env: () => envWith(), logDir, windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'failed', message: 'claude not found' })
    expect(startedPids()).toEqual([])
    expect(existsSync(recordFile)).toBe(false)
    expect(existsSync(logDir)).toBe(false)
    expect(runner.isRunning(SESSION)).toBe(false)
  })
})

describe.runIf(WIN)('the node a shim runs under', () => {
  /** A shim whose script records the exe that runs it, so a test can tell one node from another. */
  const nodeShim = (dir: string): { bin: string; ranUnder: () => Promise<string> } => {
    const out = join(tmp, 'ran-under.txt')
    const pkg = join(dir, 'node_modules', 'who')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'cli.mjs'),
      [
        "import { appendFileSync, writeFileSync } from 'node:fs'",
        `appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n')`,
        `writeFileSync(${JSON.stringify(out)}, process.execPath)`,
      ].join('\n'),
    )
    const bin = join(dir, 'claude.cmd')
    writeFileSync(bin, npmShim('node_modules\\who\\cli.mjs'))
    return {
      bin,
      ranUnder: async () => {
        await waitFor(() => existsSync(out) && readFileSync(out, 'utf8') !== '')
        return realpathSync.native(readFileSync(out, 'utf8'))
      },
    }
  }
  const copyNode = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    const node = join(dir, 'node.exe')
    copyFileSync(process.execPath, node)
    return realpathSync.native(node)
  }
  /** A system tool that exits 0 on these arguments, standing in for a native `claude.exe`. */
  const copyNative = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    const exe = join(dir, 'claude.exe')
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), exe)
    return exe
  }
  const noNodeFailure = { outcome: 'failed', message: 'node not found' }

  test("Electron's exe is never the fallback", async () => {
    const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 3000, fallbackNode: undefined })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual(noNodeFailure)
    expect(startedPids()).toEqual([])
    expect(existsSync(recordFile)).toBe(false)
    expect(existsSync(logDir)).toBe(false)
    expect(runner.isRunning(SESSION)).toBe(false)
  })

  test('under Electron the default has no fallback', async () => {
    // The app's own call passes no fallbackNode, so this default is what a shell gets.
    Object.defineProperty(process.versions, 'electron', { value: '99.0.0', configurable: true })
    try {
      const runner = createClaudeRunner({ bin: 'claude', logDir, env: envWith(), windowMs: 3000 })
      expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual(noNodeFailure)
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
    expect(startedPids()).toEqual([])
    expect(existsSync(recordFile)).toBe(false)
  })

  test('a found node still runs the shim under Electron', async () => {
    const onPath = copyNode(join(tmp, 'tools'))
    const { bin, ranUnder } = nodeShim(binDir)
    const env = envWith({ Path: `${binDir};${dirname(onPath)}` })
    delete env.PATH
    const runner = createClaudeRunner({ bin, logDir, env: () => env, windowMs: 3000, fallbackNode: undefined })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect(await ranUnder()).toBe(onPath)
  })

  test('a node in the repo folder never counts under Electron', async () => {
    copyNode(repo)
    const home = process.cwd()
    process.chdir(repo)
    try {
      const env = envWith({ PATH: `.;${binDir}` })
      const runner = createClaudeRunner({ bin: 'claude', logDir, env, windowMs: 3000, fallbackNode: undefined })
      expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual(noNodeFailure)
    } finally {
      process.chdir(home)
    }
    expect(startedPids()).toEqual([])
  })

  test("the shim's own node wins under Electron", async () => {
    const own = copyNode(binDir)
    const other = copyNode(join(tmp, 'tools'))
    const { bin, ranUnder } = nodeShim(binDir)
    const env = envWith({ PATH: `${dirname(other)};${binDir}` })
    const runner = createClaudeRunner({ bin, logDir, env, windowMs: 3000, fallbackNode: undefined })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect(await ranUnder()).toBe(own)
  })

  test('a native claude ignores the fallback', async () => {
    // Started as is, with no node on PATH.
    const native = copyNative(join(tmp, 'native'))
    const direct = createClaudeRunner({ bin: native, logDir, env: envWith(), windowMs: 3000, fallbackNode: undefined })
    expect(await direct.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })

    // Named by a shim, the way npm's native installer writes one.
    const shim = join(tmp, 'native', 'claude.cmd')
    writeFileSync(shim, npmShim('claude.exe'))
    const named = createClaudeRunner({ bin: shim, logDir, env: envWith(), windowMs: 3000, fallbackNode: undefined })
    expect(await named.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
  })

  test('an unknown shim keeps its cmd.exe path under Electron', async () => {
    const plain = join(tmp, 'plain')
    installFake(plain, 'plain')
    const runner = createClaudeRunner({ bin: join(plain, 'claude.cmd'), logDir, env: envWith(), windowMs: 3000, fallbackNode: undefined })
    expect(await runner.start({ session: SESSION, word: 'go', cwd: repo })).toEqual({ outcome: 'started' })
    expect((await readRecord()).argv).toEqual(['-p', '--resume', SESSION, 'go'])
  })

  test('plain Node keeps its fallback', async () => {
    const { bin, ranUnder } = nodeShim(binDir)
    const runner = createClaudeRunner({ bin, logDir, env: envWith(), windowMs: 3000 })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect(await ranUnder()).toBe(realpathSync.native(process.execPath))
  })

  test('a given fallback runs the shim when no node is found', async () => {
    const given = copyNode(join(tmp, 'given'))
    const { bin, ranUnder } = nodeShim(binDir)
    const runner = createClaudeRunner({ bin, logDir, env: envWith(), windowMs: 3000, fallbackNode: given })
    expect(await runner.start({ session: SESSION, word: 'continue', cwd: repo })).toEqual({ outcome: 'started' })
    expect(await ranUnder()).toBe(given)
  })
})

describe('pruneLogs', () => {
  test('deletes the oldest .log files and leaves everything else', () => {
    mkdirSync(logDir, { recursive: true })
    for (let i = 0; i < 25; i++) {
      const file = join(logDir, `r-${i}.log`)
      writeFileSync(file, 'x')
      utimesSync(file, 1_000 + i, 1_000 + i)
    }
    writeFileSync(join(logDir, 'notes.txt'), 'keep me')
    mkdirSync(join(logDir, 'sub.log'))
    pruneLogs(logDir, 19)
    const left = readdirSync(logDir)
    const logs = left.filter((n) => n.startsWith('r-')).sort()
    expect(logs).toEqual(Array.from({ length: 19 }, (_, i) => `r-${i + 6}.log`).sort())
    expect(left).toContain('notes.txt')
    expect(left).toContain('sub.log')
  })

  test('does not throw for a missing folder', () => {
    expect(() => pruneLogs(join(logDir, 'nope'), 19)).not.toThrow()
  })

  test('deletes nothing when there are fewer files than keep', () => {
    mkdirSync(logDir, { recursive: true })
    for (let i = 0; i < 3; i++) writeFileSync(join(logDir, `r-${i}.log`), 'x')
    pruneLogs(logDir, 19)
    expect(readdirSync(logDir)).toHaveLength(3)
  })
})

describe('claudeBin', () => {
  test('picks the claude binary', () => {
    expect(claudeBin({})).toBe('claude')
    expect(claudeBin({ POD_BOARD_CLAUDE_BIN: '' })).toBe('claude')
    expect(claudeBin({ POD_BOARD_CLAUDE_BIN: 'C:\\tools\\claude.exe' })).toBe('C:\\tools\\claude.exe')
    expect(RESUME_WINDOW_MS).toBe(10_000)
  })
})

describe('childEnv', () => {
  test('drops every ANTHROPIC_* and CLAUDE* variable in any case, and keeps the rest', () => {
    const board = {
      ANTHROPIC_API_KEY: 'sk',
      anthropic_auth_token: 't',
      ANTHROPIC_BASE_URL: 'http://x',
      Anthropic_Model: 'm',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      claude_code_use_bedrock: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_PID: '42',
      CLAUDE_EFFORT: 'high',
      ClaudeSomething: 'x',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work',
      POD_BOARD_CLAUDE_BIN: 'C:\\tools\\claude.exe',
      POD_BOARD_CLAUDE_DIR: 'C:\\x',
      PATH: 'C:\\bin',
      Path: 'C:\\bin2',
      HOME: '/home/me',
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      ANTHROPICX: 'kept: not the ANTHROPIC_ prefix',
      MY_CLAUDE_NOTE: 'kept: CLAUDE is not the start',
    }
    const out = childEnv(board, 'win32')
    expect(Object.keys(out).sort()).toEqual(
      [
        'ANTHROPICX',
        'APPDATA',
        'CLAUDE_CONFIG_DIR',
        'HOME',
        'MY_CLAUDE_NOTE',
        'NoDefaultCurrentDirectoryInExePath',
        'PATH',
        'Path',
        'POD_BOARD_CLAUDE_BIN',
        'POD_BOARD_CLAUDE_DIR',
        'USERPROFILE',
      ].sort(),
    )
    expect(out.CLAUDE_CONFIG_DIR).toBe(board.CLAUDE_CONFIG_DIR)
    expect(board.CLAUDECODE).toBe('1') // the board's own env is left alone
  })

  describe('the machine settings kept by exact name', () => {
    test('CLAUDE_CODE_GIT_BASH_PATH and CLAUDE_CODE_MAX_OUTPUT_TOKENS pass on, in any case', () => {
      const out = childEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\fake\\bash.exe', claude_code_max_output_tokens: '1234' }, 'win32')
      expect(out.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\fake\\bash.exe')
      expect(out.claude_code_max_output_tokens).toBe('1234')
    })

    test('credentials, session state, and any other CLAUDE_CODE_ name stay out', () => {
      const board = {
        CLAUDECODE: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'fake',
        CLAUDE_PID: '42',
        CLAUDE_EFFORT: 'high',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        ANTHROPIC_API_KEY: 'fake',
        CLAUDE_CODE_FOO: 'x',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS_X: 'x',
        CLAUDE_CODE_GIT_BASH_PATH_X: 'x',
        KEPT_NOTE: 'kept: no dropped prefix',
      }
      expect(Object.keys(childEnv(board, 'linux'))).toEqual(['KEPT_NOTE'])
    })

    test('a relative bash path stays out: it would resolve in the repo folder the run starts in', () => {
      for (const rel of ['bash.exe', '.\\bash.exe', 'tools\\bash.exe', 'D:bash.exe', '\\bash.exe', '']) {
        expect(childEnv({ CLAUDE_CODE_GIT_BASH_PATH: rel }, 'win32').CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined()
      }
      expect(childEnv({ claude_code_git_bash_path: 'bash' }, 'linux').claude_code_git_bash_path).toBeUndefined()
      expect(childEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'D:/Git/bin/bash.exe' }, 'win32').CLAUDE_CODE_GIT_BASH_PATH).toBe('D:/Git/bin/bash.exe')
      expect(childEnv({ CLAUDE_CODE_GIT_BASH_PATH: '/usr/bin/bash' }, 'linux').CLAUDE_CODE_GIT_BASH_PATH).toBe('/usr/bin/bash')
    })
  })

  test('drops empty and relative PATH entries, keeping order and the key as spelled', () => {
    const win = childEnv({ Path: ';C:\\a;.;bin;C:\\b;;\\\\host\\tools;\\rel;D:x', HOME: 'h' }, 'win32')
    expect(win.Path).toBe('C:\\a;C:\\b;\\\\host\\tools')
    expect(Object.keys(win)).not.toContain('PATH')
    const posix = childEnv({ PATH: ':/usr/bin:.:bin:/opt/x/bin:' }, 'linux')
    expect(posix.PATH).toBe('/usr/bin:/opt/x/bin')
  })

  test('on Windows tells cmd.exe and the child never to search the current folder', () => {
    expect(childEnv({ PATH: 'C:\\a' }, 'win32').NoDefaultCurrentDirectoryInExePath).toBe('1')
    // An existing entry in another case is set, not doubled.
    const out = childEnv({ nodefaultcurrentdirectoryinexepath: '', PATH: 'C:\\a' }, 'win32')
    expect(Object.keys(out).filter((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual(['nodefaultcurrentdirectoryinexepath'])
    expect(out.nodefaultcurrentdirectoryinexepath).toBe('1')
    expect(Object.keys(childEnv({ PATH: '/usr/bin' }, 'linux'))).toEqual(['PATH'])
  })
})
