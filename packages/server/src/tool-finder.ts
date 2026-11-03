// Finds `git`, `gh`, and `claude` when the app doesn't start from a terminal. It only checks that a
// file exists: a check starts no tool and shows no window. The find order and the path rules are in
// pod-docs/feature-details/server.md.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { envKey, isFile, resolveBin, safeChildEnv } from './bin-path.ts'
import { envValue } from './config.ts'

export type ToolName = 'git' | 'gh' | 'claude'
export type ToolState =
  | { tool: ToolName; state: 'found'; path: string; source: 'env' | 'settings' | 'path' | 'registry' | 'known' }
  | { tool: ToolName; state: 'missing' }
  | { tool: ToolName; state: 'bad-path'; path: string; source: 'env' | 'settings' }
export type Hive = 'HKLM' | 'HKCU'
export type PathRefusal = 'bad request' | 'not absolute' | 'not a local path' | 'not a file' | 'wrong tool'
export type SetPathResult = { tools: ToolState[] } | { error: PathRefusal | 'settings unwritable' }
export type ToolFinder = {
  /** Looks again, and never rejects. Calls during a running check share its result. */
  check(): Promise<ToolState[]>
  /** The last check's result: every tool `missing` before the first. */
  states(): ToolState[]
  /** The last check's file for a found tool. */
  path(tool: ToolName): string | undefined
  /** The env for `gh` and `claude`, with the merged Path. `safeChildEnv` and `childEnv` still go on top. */
  env(): NodeJS.ProcessEnv
  /** Saves a path, or clears it with `null`, then checks again. A refused path saves nothing. */
  setPath(tool: ToolName, path: string | null): Promise<SetPathResult>
}

export const TOOL_NAMES: readonly ToolName[] = ['git', 'gh', 'claude']
/** How long one registry hive may take. */
export const REGISTRY_LIMIT_MS = 5000

const HIVE_KEYS: Record<Hive, string> = {
  HKLM: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  HKCU: 'HKCU\\Environment',
}
const EXTENSIONS: Record<ToolName, readonly string[]> = {
  git: ['.com', '.exe'],
  gh: ['.com', '.exe'],
  claude: ['.com', '.exe', '.cmd', '.bat'],
}
const PATH_VALUE = /^\s+Path\s+REG(?:_EXPAND)?_SZ[ \t]+(.*?)\s*$/im
const DRIVE_PATH = /^[A-Za-z]:[\\/]/
/** A UNC share or a device path. Opening one can reach another machine, so it never reaches the file system. */
const NETWORK_PATH = /^[\\/]{2}/

/** Runs `reg.exe` by its absolute path, with no window. No `SystemRoot` rejects, which counts as an empty result. */
const regExeReader =
  (env: NodeJS.ProcessEnv) =>
  (hive: Hive): Promise<string> =>
    new Promise((resolve, reject) => {
      const root = envKey(env, 'SYSTEMROOT')
      if (root === undefined || !DRIVE_PATH.test(root)) return reject(new Error('no SystemRoot'))
      execFile(
        path.win32.join(root, 'System32', 'reg.exe'),
        ['query', HIVE_KEYS[hive], '/v', 'Path'],
        { windowsHide: true, timeout: REGISTRY_LIMIT_MS, shell: false },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      )
    })

/** The folders of a `reg.exe` answer: `%VAR%` expanded in any case, and only drive paths kept. */
function registryFolders(text: string, env: NodeJS.ProcessEnv): string[] {
  const value = PATH_VALUE.exec(text)?.[1] ?? ''
  const out: string[] = []
  for (const entry of value.split(';')) {
    let unknown = false
    const expanded = entry.replace(/%([^%]+)%/g, (_, name: string) => {
      const found = envKey(env, name.toUpperCase())
      if (found === undefined) unknown = true
      return found ?? ''
    })
    if (!unknown && DRIVE_PATH.test(expanded) && !expanded.includes(';')) out.push(expanded)
  }
  return out
}

/** Known install folders, each skipped when its variable is unset or isn't a drive path. */
function knownFolders(env: NodeJS.ProcessEnv): string[] {
  const under = (name: string, ...subs: string[][]): string[] => {
    const base = envKey(env, name.toUpperCase())
    return base !== undefined && DRIVE_PATH.test(base) ? subs.map((sub) => path.win32.join(base, ...sub)) : []
  }
  const installs = [['Git', 'cmd'], ['GitHub CLI']]
  return [
    ...under('PROGRAMFILES', ...installs),
    ...under('PROGRAMFILES(X86)', ...installs),
    ...under('LOCALAPPDATA', ...installs.map((sub) => ['Programs', ...sub]), ['Microsoft', 'WinGet', 'Links']),
    ...under('USERPROFILE', ['scoop', 'shims'], ['.local', 'bin'], ['.claude', 'local']),
    ...under('APPDATA', ['npm']),
  ]
}

/** The first check that fails, or undefined. The string checks come first, so a network path is refused unread. */
function refusal(tool: ToolName, file: string, platform: NodeJS.Platform): PathRefusal | undefined {
  const win = platform === 'win32'
  if (file.includes('\0')) return 'bad request'
  if (NETWORK_PATH.test(file)) return 'not a local path'
  if (!(win ? DRIVE_PATH.test(file) : path.posix.isAbsolute(file))) return 'not absolute'
  if (!isFile(file)) return 'not a file'
  if (win) {
    const base = path.win32.basename(file).toLowerCase()
    if (!EXTENSIONS[tool].some((ext) => base === tool + ext)) return 'wrong tool'
  } else if (path.posix.basename(file) !== tool) return 'wrong tool'
  return undefined
}

/** Missing, unreadable, or bad JSON reads as nothing set, and a value that isn't a string is ignored. */
function settingsFrom(text: string): Partial<Record<ToolName, string>> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof data !== 'object' || data === null) return {}
  const out: Partial<Record<ToolName, string>> = {}
  for (const tool of TOOL_NAMES) {
    const value = (data as Record<string, unknown>)[tool]
    if (typeof value === 'string') out[tool] = value
  }
  return out
}

/** On Windows a rename over a file another process has open (a watcher, a virus scan) fails for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
    }
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, text, { flag: 'wx' })
    await renameWithRetry(temp, file)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/** The answer of one hive, within the limit. Any failure is an empty result. */
async function readHive(read: (hive: Hive) => Promise<string>, hive: Hive, limitMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(hive),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(''), limitMs)
      }),
    ])
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

export function createToolFinder(o: {
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  settingsFile: string
  readRegistryPath?: (hive: Hive) => Promise<string>
  registryLimitMs?: number
}): ToolFinder {
  const platform = o.platform ?? process.platform
  const win = platform === 'win32'
  const sep = win ? ';' : ':'
  const p = win ? path.win32 : path.posix
  const readRegistry = o.readRegistryPath ?? regExeReader(o.env)

  const inherited = (): string[] => {
    const safe = safeChildEnv({ PATH: envKey(o.env, 'PATH') ?? '' }, platform)
    return (safe.PATH ?? '').split(sep).filter(Boolean)
  }

  const onFolders = (tool: ToolName, dirs: string[]): string | undefined =>
    resolveBin(tool, { PATH: dirs.join(sep) }, platform, { exts: EXTENSIONS[tool] })

  const find = (tool: ToolName, settings: Partial<Record<ToolName, string>>, registry: string[], known: string[]): ToolState => {
    const fromEnv = tool === 'claude' ? envValue(o.env, 'POD_BOARD_CLAUDE_BIN') : undefined
    if (fromEnv !== undefined) {
      // That value only: a bare name or a relative path has nothing to search, and a name with no extension finds its shim.
      const local = !NETWORK_PATH.test(fromEnv) && (win ? DRIVE_PATH.test(fromEnv) : path.posix.isAbsolute(fromEnv))
      const file = local ? resolveBin(fromEnv, {}, platform, { exts: EXTENSIONS.claude }) : undefined
      return file ? { tool, state: 'found', path: file, source: 'env' } : { tool, state: 'bad-path', path: fromEnv, source: 'env' }
    }
    const chosen = settings[tool]
    if (chosen !== undefined) {
      return refusal(tool, chosen, platform) === undefined
        ? { tool, state: 'found', path: p.normalize(chosen), source: 'settings' }
        : { tool, state: 'bad-path', path: chosen, source: 'settings' }
    }
    const onPath = onFolders(tool, inherited())
    if (onPath) return { tool, state: 'found', path: onPath, source: 'path' }
    if (!win) return { tool, state: 'missing' }
    const inRegistry = onFolders(tool, registry)
    if (inRegistry) return { tool, state: 'found', path: inRegistry, source: 'registry' }
    const inKnown = onFolders(tool, known)
    if (inKnown) return { tool, state: 'found', path: inKnown, source: 'known' }
    return { tool, state: 'missing' }
  }

  let current: ToolState[] = TOOL_NAMES.map((tool) => ({ tool, state: 'missing' }))
  let registryFound: string[] = []
  let running: Promise<ToolState[]> | undefined

  const look = async (): Promise<ToolState[]> => {
    let registry: string[] = []
    if (win) {
      const texts = await Promise.all((['HKLM', 'HKCU'] as const).map((hive) => readHive(async (h) => readRegistry(h), hive, o.registryLimitMs ?? REGISTRY_LIMIT_MS)))
      registry = texts.flatMap((text) => registryFolders(text, o.env))
    }
    // From here on nothing waits, so a save that ended before this line is always seen.
    let text = ''
    try {
      text = readFileSync(o.settingsFile, 'utf8')
    } catch {
      // Nothing set.
    }
    const settings = settingsFrom(text)
    const known = win ? knownFolders(o.env) : []
    registryFound = registry
    current = TOOL_NAMES.map((tool) => {
      try {
        return find(tool, settings, registry, known)
      } catch {
        return { tool, state: 'missing' }
      }
    })
    return current
  }

  const check = (): Promise<ToolState[]> => {
    running ??= look()
      .catch(() => current)
      .finally(() => {
        running = undefined
      })
    return running
  }

  // Saves run one at a time, each from the file as it is now, so none is lost.
  let saves: Promise<unknown> = Promise.resolve()
  const write = (tool: ToolName, file: string | null): Promise<void> => {
    const run = saves.then(async () => {
      let text = ''
      try {
        text = await readFile(o.settingsFile, 'utf8')
      } catch {
        // Nothing set.
      }
      const next = settingsFrom(text)
      if (file === null) delete next[tool]
      else next[tool] = file
      await writeAtomic(o.settingsFile, JSON.stringify(next, null, 2) + '\n')
    })
    saves = run.catch(() => {})
    return run
  }

  return {
    check,
    states: () => current,
    path(tool) {
      const state = current.find((s) => s.tool === tool)
      return state?.state === 'found' ? state.path : undefined
    },
    env() {
      const key = Object.keys(o.env).find((k) => k.toUpperCase() === 'PATH') ?? (win ? 'Path' : 'PATH')
      const toolFolders = current.flatMap((s) => (s.state === 'found' ? [p.dirname(s.path)] : []))
      const seen = new Set<string>()
      const merged = [...inherited(), ...registryFound, ...toolFolders].filter((dir) => {
        const trimmed = dir.replace(win ? /[\\/]+$/ : /\/+$/, '')
        const id = win ? trimmed.toLowerCase() : trimmed
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      return { ...o.env, [key]: merged.join(sep) }
    },
    async setPath(tool, file) {
      if (file !== null) {
        const refused = refusal(tool, file, platform)
        if (refused) return { error: refused }
      }
      try {
        await write(tool, file)
      } catch {
        return { error: 'settings unwritable' }
      }
      return { tools: await check() }
    },
  }
}
