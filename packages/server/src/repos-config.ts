import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ignoresCase, normalizeRepoPath, sameRepoPath } from './guard.ts'

/**
 * The board's own config file: `{ "version": 1, "repos": [{ "path": "…" }] }`.
 * It is the only file the board ever writes.
 */
type ConfigFile = { version: 1; repos: { path: string }[] }

export type AddRepoError = 'not absolute' | 'not a local path' | 'not a directory' | 'already registered' | 'config unreadable'

type Loaded = { config: ConfigFile } | { error: 'config unreadable' }

/** What `addRepo` asks the file system; tests swap it. */
export type AddRepoDeps = { ignoresCase: (dir: string) => Promise<boolean>; isDirectory?: (dir: string) => Promise<boolean> }

/** The registered repo paths. A missing file is an empty list; anything else unreadable is an error. */
export async function loadRepos(file: string): Promise<{ repos: string[] } | { error: 'config unreadable' }> {
  const loaded = await readConfig(file)
  return 'error' in loaded ? loaded : { repos: loaded.config.repos.map((r) => r.path) }
}

/**
 * Registers a repo folder and returns its normalized path. Refuses a network
 * or device path (win32) and a relative path before touching the file system, a path that isn't a folder, a repo already listed (by Repo identity,
 * with case following the new folder's file system), and a config file it can't read, which it never overwrites. Writes through a
 * temp file and a rename, so a crash leaves the old file or the new one. Adds
 * to the same file run one at a time, so none is lost.
 */
export function addRepo(
  file: string,
  repoPath: string,
  platform: NodeJS.Platform,
  deps: AddRepoDeps = { ignoresCase },
): Promise<{ path: string } | { error: AddRepoError }> {
  return queued(file, () => addRepoNow(file, repoPath, platform, deps))
}

export type RemoveRepoError = 'not registered' | 'config unreadable'

/**
 * Takes a repo out of the config and returns its normalized path. It matches
 * entries by Repo identity, the same way `addRepo` finds a duplicate, and takes
 * out every spelling of the repo. The folder doesn't need to exist. It reads the
 * file as it is now, inside the same queue as `addRepo`, so it never writes back
 * a list read earlier. A config it can't read is never overwritten, and a repo
 * that isn't listed writes nothing. It never touches the repo's own files.
 */
export function removeRepo(
  file: string,
  repoPath: string,
  platform: NodeJS.Platform,
  deps: Pick<AddRepoDeps, 'ignoresCase'> = { ignoresCase },
): Promise<{ path: string } | { error: RemoveRepoError }> {
  return queued(file, () => removeRepoNow(file, repoPath, platform, deps))
}

async function removeRepoNow(
  file: string,
  repoPath: string,
  platform: NodeJS.Platform,
  deps: Pick<AddRepoDeps, 'ignoresCase'>,
): Promise<{ path: string } | { error: RemoveRepoError }> {
  const normalized = normalizeRepoPath(repoPath, platform)
  const loaded = await readConfig(file)
  if ('error' in loaded) return loaded
  const caseless = await deps.ignoresCase(normalized)
  const kept = loaded.config.repos.filter((r) => !sameRepoPath(r.path, normalized, platform, caseless))
  if (kept.length === loaded.config.repos.length) return { error: 'not registered' }
  await writeAtomic(file, JSON.stringify({ version: 1, repos: kept } satisfies ConfigFile, null, 2) + '\n')
  return { path: normalized }
}

/** Runs writes to the same config file one at a time, adds and removes alike, so none is lost. */
function queued<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file)
  const run = (queues.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.then(
    () => {},
    () => {},
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

const queues = new Map<string, Promise<void>>()

async function addRepoNow(
  file: string,
  repoPath: string,
  platform: NodeJS.Platform,
  deps: AddRepoDeps,
): Promise<{ path: string } | { error: AddRepoError }> {
  // Both checks read only the string: a network path never reaches the file system.
  if (isNetworkPath(repoPath, platform)) return { error: 'not a local path' }
  if (!isAbsolute(repoPath, platform)) return { error: 'not absolute' }
  const normalized = normalizeRepoPath(repoPath, platform)
  if (!(await (deps.isDirectory ?? isDirectory)(normalized))) return { error: 'not a directory' }

  const loaded = await readConfig(file)
  if ('error' in loaded) return loaded
  const caseless = await deps.ignoresCase(normalized)
  if (loaded.config.repos.some((r) => sameRepoPath(r.path, normalized, platform, caseless))) {
    return { error: 'already registered' }
  }

  const next: ConfigFile = { version: 1, repos: [...loaded.config.repos, { path: normalized }] }
  await writeAtomic(file, JSON.stringify(next, null, 2) + '\n')
  return { path: normalized }
}

/**
 * On win32 a path that starts with two separators: a UNC share (`\\host\share`,
 * `//host/share`) or a device path (`\\?\…`, `\\.\…`). Opening one can reach
 * another machine (and hand it the user's Windows login), so it's refused unread.
 */
function isNetworkPath(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(p)
}

/** On win32 only a drive path (`C:\x`) counts; `\x` and `C:x` depend on the current drive. */
function isAbsolute(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p)
  return path.posix.isAbsolute(p)
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function readConfig(file: string): Promise<Loaded> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: { version: 1, repos: [] } }
    return { error: 'config unreadable' }
  }
  try {
    const config = parseConfig(JSON.parse(text))
    return config ? { config } : { error: 'config unreadable' }
  } catch {
    return { error: 'config unreadable' }
  }
}

/** The config, or `undefined` for any other shape: a newer version included, so it is never overwritten. */
function parseConfig(data: unknown): ConfigFile | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const { version, repos } = data as { version?: unknown; repos?: unknown }
  if (version !== 1 || !Array.isArray(repos)) return undefined
  const paths: { path: string }[] = []
  for (const r of repos) {
    if (typeof r !== 'object' || r === null || typeof (r as { path?: unknown }).path !== 'string') return undefined
    paths.push({ path: (r as { path: string }).path })
  }
  return { version: 1, repos: paths }
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

/** On Windows a rename over a file another process has open (a watcher, a virus scan) fails for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
    }
  }
}
