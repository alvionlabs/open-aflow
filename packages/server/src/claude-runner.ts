import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ReplyWord } from '@pod-board/model'
import { envKey, isFile, resolveBin, safeChildEnv } from './bin-path.ts'
import { envValue, type Env } from './config.ts'

export { resolveBin }

export type ResumeWord = Exclude<ReplyWord, 'try'>
export type StartResult = { outcome: 'started' | 'failed'; message?: string }
export type ClaudeRunner = {
  /** Starts `claude -p --resume <session> <word>` in `cwd` and reports how its first `windowMs` went. */
  start(r: { session: string; word: ResumeWord; cwd: string }): Promise<StartResult>
  /** A child this runner started for `session` is still alive. */
  isRunning(session: string): boolean
}

/** How long `start` watches the child before it calls the run started. */
export const RESUME_WINDOW_MS = 10_000
/** How many resume logs stay in `logDir`, counting the one a new run opens. */
export const MAX_RESUME_LOGS = 20
const TAIL_CHARS = 500

/**
 * A session id claude accepts and nothing reads as a flag or a command: the contract's
 * `^[A-Za-z0-9-]{1,64}$`, minus a leading `-` (`--bare` would match it).
 */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const WORDS: readonly string[] = ['continue', 'go']
/** Env names passed on although they match a dropped prefix, compared upper-cased. */
const KEPT_ENV = new Set(['CLAUDE_CONFIG_DIR'])
/** Characters cmd.exe would act on even inside quotes, or that end the quoting. */
const CMD_UNSAFE = /["%!^&|<>\r\n]/
// CSI sequences, OSC sequences, and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/**
 * Deletes the oldest `.log` files in `dir` (by mtime, then name) until `keep` remain. Other files
 * and folders stay. Every failure is ignored, so a log a running child holds open is kept for a later start.
 */
export function pruneLogs(dir: string, keep: number): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const logs: { name: string; mtime: number }[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.log')) continue
    try {
      logs.push({ name: e.name, mtime: statSync(path.join(dir, e.name)).mtimeMs })
    } catch {
      // gone already
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  for (const old of logs.slice(Math.max(0, keep))) {
    try {
      rmSync(path.join(dir, old.name))
    } catch {
      // still open, or gone
    }
  }
}

/** The claude binary: `POD_BOARD_CLAUDE_BIN`, else `claude` (found on PATH). */
export function claudeBin(env: Env): string {
  return envValue(env, 'POD_BOARD_CLAUDE_BIN') ?? 'claude'
}

/**
 * Whether the resumed run gets the board's env variable `name` (any case). Every
 * `ANTHROPIC_*` variable (keys, tokens, base URL, model) and every `CLAUDE*` one (Claude
 * Code's own session state: `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
 * the Bedrock and Vertex switches) is dropped, so the run uses the human's own login and
 * settings, not those of a session that happened to launch the board. `CLAUDE_CONFIG_DIR`
 * is kept: it names where the human's login and sessions live, the same folder the board
 * reads transcripts from, and without it `--resume` couldn't find the session.
 */
const passesOn = (name: string): boolean => {
  const u = name.toUpperCase()
  if (KEPT_ENV.has(u)) return true
  return !u.startsWith('ANTHROPIC_') && !u.startsWith('CLAUDE')
}

/**
 * The board's env for a resumed run: see `passesOn`, then `safeChildEnv` (absolute PATH
 * entries only; on Windows no current-folder search, which a shim run through cmd.exe
 * needs). The board's own env is left alone.
 */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (passesOn(k)) out[k] = v
  return safeChildEnv(out, platform)
}

/**
 * The absolute path of cmd.exe: `COMSPEC` when it's an absolute path to a file, else
 * `%SystemRoot%\System32\cmd.exe`, else `cmd.exe` on PATH (absolute entries only). Never a
 * bare name, which the OS could look up in the repo folder the run starts in.
 */
export function cmdPath(env: NodeJS.ProcessEnv): string | undefined {
  const drive = /^[A-Za-z]:[\\/]/
  const comspec = envKey(env, 'COMSPEC')
  if (comspec !== undefined && drive.test(comspec) && isFile(comspec)) return comspec
  const root = envKey(env, 'SYSTEMROOT')
  const system = root !== undefined && drive.test(root) ? path.win32.join(root, 'System32', 'cmd.exe') : undefined
  if (system !== undefined && isFile(system)) return system
  return resolveBin('cmd', env, 'win32', { exts: ['.exe'] })
}

type ShimRun = { file: string; pre: string[] }

/** The node of last resort: the board's own, unless the board runs in Electron, whose exe would open an app. */
const defaultFallbackNode = (): string | undefined => (process.versions.electron ? undefined : process.execPath)

/**
 * What an npm `.cmd` shim runs, read from its text: the last quoted `%dp0%\…` path before `%*`.
 * A native `.exe` runs as is; a script runs with the shim's own `node.exe`, else `node` on
 * PATH, else `fallbackNode`. With none of these → `no node`. Anything else → `undefined`.
 */
function readShim(file: string, env: NodeJS.ProcessEnv, fallbackNode: string | undefined): ShimRun | 'no node' | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const hits = [...text.matchAll(/"%dp0%\\([^"%\r\n]+)"\s+%\*/gi)]
  const rel = hits.at(-1)?.[1]
  if (rel === undefined) return undefined
  const dir = path.win32.dirname(file)
  const target = path.win32.resolve(dir, rel)
  if (!isFile(target)) return undefined
  if (/\.exe$/i.test(target)) return { file: target, pre: [] }
  if (!/\.[cm]?js$/i.test(target)) return undefined
  const own = path.win32.join(dir, 'node.exe')
  const node = isFile(own) ? own : (resolveBin('node', env, 'win32') ?? fallbackNode)
  return node === undefined ? 'no node' : { file: node, pre: [target] }
}

/** `readShim` with the default fallback, for callers that can't report a missing node. */
export function shimTarget(file: string, env: NodeJS.ProcessEnv): ShimRun | undefined {
  const run = readShim(file, env, defaultFallbackNode())
  return run === 'no node' ? undefined : run
}

/** The tail of the child's stderr log: escape codes removed, at most 500 chars. */
export function stderrTail(text: string): string {
  return text.replace(ANSI, '').trim().slice(-TAIL_CHARS).trim()
}

const failed = (message: string): StartResult => ({ outcome: 'failed', message })

/**
 * `bin` and `env` may be functions, read at each start. A function's `bin` is the tool finder's
 * absolute path, with no lookup: `undefined` or a file since gone is `claude not found`.
 */
export function createClaudeRunner(o: {
  bin: string | (() => string | undefined)
  logDir: string
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv)
  windowMs?: number
  /** Runs a shim's script when no node is found. Left out: `defaultFallbackNode`. Given as `undefined`: none. */
  fallbackNode?: string | undefined
}): ClaudeRunner {
  const windowMs = o.windowMs ?? RESUME_WINDOW_MS
  const fallbackNode = 'fallbackNode' in o ? o.fallbackNode : defaultFallbackNode()
  const live = new Map<string, number>()
  const track = (session: string, by: number) => {
    const n = (live.get(session) ?? 0) + by
    if (n > 0) live.set(session, n)
    else live.delete(session)
  }

  async function start(r: { session: string; word: ResumeWord; cwd: string }): Promise<StartResult> {
    if (!SESSION.test(r.session)) return failed('bad session id')
    if (!WORDS.includes(r.word)) return failed('bad reply word')
    const env = childEnv((typeof o.env === 'function' ? o.env() : o.env) ?? process.env)
    let file: string | undefined
    if (typeof o.bin === 'function') {
      const found = o.bin()
      file = found !== undefined && isFile(found) ? found : undefined
    } else {
      file = resolveBin(o.bin, env)
    }
    if (!file) return failed('claude not found')
    let isDir = false
    try {
      isDir = statSync(r.cwd).isDirectory()
    } catch {}
    if (!isDir) return failed('repo folder not found')

    const args = ['-p', '--resume', r.session, r.word]
    const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
    // npm's shim names what it runs, so that runs directly; only an unknown shim needs cmd.exe.
    const target = isShim ? readShim(file, env, fallbackNode) : { file, pre: [] }
    if (target === 'no node') return failed('node not found')
    const shim = target === undefined
    // Absolute, so cmd.exe's redirect can't land in the repo folder the run starts in.
    const logPath = path.resolve(o.logDir, `${r.session}-${Date.now()}.log`)
    if (shim && (CMD_UNSAFE.test(file) || CMD_UNSAFE.test(logPath))) return failed('unsafe claude path')
    const cmd = shim ? cmdPath(env) : undefined
    if (shim && cmd === undefined) return failed('cmd.exe not found')

    let fd: number
    try {
      mkdirSync(o.logDir, { recursive: true })
      pruneLogs(o.logDir, MAX_RESUME_LOGS - 1)
      fd = openSync(logPath, 'a')
    } catch (err) {
      return failed(`couldn't open the resume log: ${(err as Error).message}`)
    }

    let child: ChildProcess
    try {
      const opts = { cwd: r.cwd, env, detached: true, windowsHide: true }
      if (shim) {
        // A .cmd shim pod can't read only runs through cmd.exe. Every value in the line is fixed or checked
        // above (session id pattern, the two words, paths with no cmd specials). A detached
        // cmd.exe doesn't hand its std handles on, so the line redirects them itself, and
        // the board must not hold the log open.
        closeSync(fd)
        const line = `""${file}" ${args.join(' ')} <NUL >NUL 2>>"${logPath}""`
        child = spawn(cmd!, ['/d', '/s', '/c', line], {
          ...opts,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
        })
      } else {
        try {
          child = spawn(target.file, [...target.pre, ...args], { ...opts, stdio: ['ignore', 'ignore', fd] })
        } finally {
          closeSync(fd)
        }
      }
    } catch (err) {
      return failed((err as Error).message)
    }
    track(r.session, 1)
    child.unref()

    return new Promise<StartResult>((resolve) => {
      let settled = false
      let counted = true
      const settle = (res: StartResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res)
      }
      const untrack = () => {
        if (counted) track(r.session, -1)
        counted = false
      }
      const timer = setTimeout(() => settle({ outcome: 'started' }), windowMs)
      child.once('error', (err) => {
        untrack()
        const code = (err as NodeJS.ErrnoException).code
        settle(failed(code === 'ENOENT' ? 'claude not found' : err.message))
      })
      child.once('exit', (code, signal) => {
        untrack()
        if (settled) return
        if (code === 0) return settle({ outcome: 'started' })
        let tail = ''
        try {
          tail = stderrTail(readFileSync(logPath, 'utf8'))
        } catch {}
        settle(failed(tail || `claude exited with code ${code ?? signal}`))
      })
    })
  }

  return { start, isRunning: (session) => live.has(session) }
}
