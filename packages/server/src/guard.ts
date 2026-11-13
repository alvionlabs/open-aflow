import { createHash, timingSafeEqual } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * Refuses requests that don't come from the board's own pages. The server
 * binds 127.0.0.1, but a web page on any site can still make the browser send
 * requests there; a foreign `Host` (DNS rebinding) or a foreign `Origin` (a
 * cross-site POST) gets a 403. GET and HEAD skip the Origin check because
 * browsers leave Origin off same-origin GETs. Nothing here sets CORS headers,
 * so no other origin can read a response.
 */
export function requestGuard({ ports }: { ports: readonly number[] }): MiddlewareHandler {
  const check = hostAndOrigin(ports)
  return async (c, next) => {
    const refused = check(c)
    if (refused) return refused
    await next()
  }
}

/** The Host and Origin checks: a 403 response, or undefined when both pass. */
function hostAndOrigin(ports: readonly number[]): (c: Context) => Response | undefined {
  const hosts = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]))
  const origins = new Set([...hosts].map((h) => `http://${h}`))
  return (c) => {
    const host = c.req.header('host')
    if (host === undefined || !hosts.has(host)) return c.json({ error: 'forbidden host' }, 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (origin === undefined || !origins.has(origin)) return c.json({ error: 'forbidden origin' }, 403)
    }
    return undefined
  }
}

/**
 * Guards every route under /api/actions/. On top of the request guard's Host
 * and Origin checks, an action must be a POST of a JSON object carrying the
 * per-launch session token. Checks run in this order, and the first failure
 * answers, so a refused request never reaches an action:
 * Host 403, Origin 403, method 405, content type 415, token 403, body 400.
 * The handler can still read the body (`c.req.json()`): Hono caches it.
 */
export function actionGuard({ ports, token }: { ports: readonly number[]; token: string }): MiddlewareHandler {
  const check = hostAndOrigin(ports)
  const tokenOk = tokenCheck(token)
  return async (c, next) => {
    const refused = check(c)
    if (refused) return refused
    if (c.req.method !== 'POST') return c.json({ error: 'method not allowed' }, 405)
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') return c.json({ error: 'unsupported media type' }, 415)
    if (!tokenOk(c)) return c.json({ error: 'bad token' }, 403)
    let body: unknown
    try {
      body = JSON.parse(await c.req.text())
    } catch {
      return c.json({ error: 'bad request' }, 400)
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return c.json({ error: 'bad request' }, 400)
    await next()
  }
}

/**
 * Guards reads that need the session token: the setup check's /api/tools
 * (production only). After the request guard's checks (Host; Origin too on anything but
 * GET and HEAD), the `X-OpenAFlow-Token` header must match. A token in the URL
 * doesn't count. Host 403, Origin 403, then token 403.
 */
export function readGuard({ ports, token }: { ports: readonly number[]; token: string }): MiddlewareHandler {
  const check = hostAndOrigin(ports)
  const tokenOk = tokenCheck(token)
  return async (c, next) => {
    const refused = check(c)
    if (refused) return refused
    if (!tokenOk(c)) return c.json({ error: 'bad token' }, 403)
    await next()
  }
}

/** Whether a request's `X-OpenAFlow-Token` header is the session token, compared in constant time. */
function tokenCheck(token: string): (c: Context) => boolean {
  const expected = Buffer.from(token, 'utf8')
  return (c) => {
    const given = Buffer.from(c.req.header('x-openaflow-token') ?? '', 'utf8')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

/**
 * A repo path in one canonical form: resolved, no trailing separator (the
 * root keeps its own), and `\` on win32. Compare two with `sameRepoPath`.
 */
export function normalizeRepoPath(p: string, platform: NodeJS.Platform): string {
  // `resolve` drops `.`, `..`, doubled and trailing separators, and on win32
  // turns `/` into `\`.
  return pathFor(platform).resolve(p)
}

/**
 * Whether two paths name the same repo. `ignoresCase` is the file system's
 * rule for the folder (see `ignoresCase()`), not the OS: a default macOS
 * volume ignores case and a Windows folder can be made case-sensitive.
 */
export function sameRepoPath(a: string, b: string, platform: NodeJS.Platform, ignoresCase: boolean): boolean {
  const x = normalizeRepoPath(a, platform)
  const y = normalizeRepoPath(b, platform)
  return ignoresCase ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * A repo's plain id: its normalized path with each non-alphanumeric character
 * as `-`, lowercased when its file system ignores case. Two paths that differ
 * only in symbols get one plain id; `repoIds` keeps the Board's ids unique.
 */
export function repoId(p: string, platform: NodeJS.Platform, ignoresCase: boolean): string {
  const id = normalizeRepoPath(p, platform).replace(/[^A-Za-z0-9]/g, '-')
  return ignoresCase ? id.toLowerCase() : id
}

const sha256 = (key: string) => createHash('sha256').update(key).digest('hex')

/** The values that occur more than once. */
function repeated(values: readonly string[]): Set<string> {
  return new Set(values.filter((v, i) => values.indexOf(v) !== i))
}

/**
 * One unique id per repo, in order, from the whole list of repos. A repo with no clash keeps its plain id. Every member of a clash gets `-` and 6 hex
 * characters of a hash of its path, so an id depends only on the path and the set, never on list order,
 * and removing one member passes its id to nobody who still clashes. Suffixed ids that still collide
 * (with each other, or with another repo's plain id) double their suffix until they differ.
 */
export function repoIds(
  repos: readonly { path: string; caseless: boolean }[],
  platform: NodeJS.Platform,
  hash: (key: string) => string = sha256,
): { ids: string[] } {
  const plain = repos.map((r) => repoId(r.path, platform, r.caseless))
  const clashed = repeated(plain)
  const hex = repos.map((r, i) => {
    if (!clashed.has(plain[i]!)) return ''
    const p = normalizeRepoPath(r.path, platform)
    // The mark keeps a case-sensitive path apart from a caseless one that folds to the same text.
    return hash(r.caseless ? p.toLowerCase() : `${p}\0`)
  })
  const sizes = hex.map((h) => (h === '' ? 0 : 6))
  for (;;) {
    const ids = plain.map((id, i) => (sizes[i] === 0 ? id : `${id}-${hex[i]!.slice(0, sizes[i])}`))
    const collide = repeated(ids)
    const grow = ids.flatMap((id, i) => (sizes[i]! > 0 && sizes[i]! < hex[i]!.length && collide.has(id) ? [i] : []))
    if (grow.length === 0) return { ids }
    for (const i of grow) sizes[i]! *= 2
  }
}

/** Whether an absolute path is the repo's folder or under it, by the same case rule as `sameRepoPath`. A relative path isn't. */
export function isInsideRepo(p: string, repo: string, platform: NodeJS.Platform, ignoresCase: boolean): boolean {
  const { isAbsolute, sep } = pathFor(platform)
  if (!isAbsolute(p)) return false
  const fold = (s: string) => (ignoresCase ? s.toLowerCase() : s)
  const x = fold(normalizeRepoPath(p, platform))
  const y = fold(normalizeRepoPath(repo, platform))
  return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep)
}

/**
 * Whether the file system holding an existing folder ignores case. It flips
 * the case of the last path part with an ASCII letter and checks that the
 * flipped path reaches the same folder. A path it can't probe (missing,
 * unreadable, no letters) gets the OS default: win32 and macOS volumes
 * ignore case unless set up otherwise.
 */
export async function ignoresCase(dir: string): Promise<boolean> {
  const fallback = process.platform === 'win32' || process.platform === 'darwin'
  const full = path.resolve(dir)
  const { root } = path.parse(full)
  const parts = full.slice(root.length).split(path.sep)
  const i = parts.findLastIndex((part) => /[A-Za-z]/.test(part))
  if (i < 0) return fallback
  const flipped = [...parts]
  flipped[i] = parts[i]!.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
  let original: { dev: bigint; ino: bigint }
  try {
    original = await stat(full, { bigint: true })
  } catch {
    return fallback
  }
  try {
    const other = await stat(root + flipped.join(path.sep), { bigint: true })
    return other.dev === original.dev && other.ino === original.ino
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : fallback
  }
}
