// The built web app, on the production server's one port. It mounts after every API route, so it
// sits behind the request guard. URL text is only ever a key into a list of files made at start:
// it never becomes a disk path. The rules and why are in pod-docs/feature-details/server.md.

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { Hono } from 'hono'
import { injectTokenMeta } from './session-token.ts'

const HTML = 'text/html; charset=utf-8'

const TYPES: Record<string, string> = {
  '.html': HTML,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** Every regular file under `dir`, by its URL path. Links aren't followed, so none leads outside. */
async function listFiles(dir: string): Promise<Map<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
  return new Map(files.map((file) => [`/${relative(dir, file).split(sep).join('/')}`, file]))
}

/** Rejects with an error naming the folder when `dir` or its index.html is missing, or index.html has no </head>. */
export async function createWebApp(o: { dir: string; token: string }): Promise<Hono> {
  let files: Map<string, string>
  let page: string
  try {
    files = await listFiles(o.dir)
    page = await readFile(join(o.dir, 'index.html'), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(`no web build in ${o.dir}: the folder or its index.html is missing${code ? ` (${code})` : ''}`)
  }
  const withToken = injectTokenMeta(page, o.token)
  if (withToken === page) throw new Error(`bad web build in ${o.dir}: index.html has no </head>`)

  const servePage = () => answer(withToken, HTML, 'no-store')

  return new Hono().all('*', async (c) => {
    const notFound = () => c.json({ error: 'not found' }, 404)
    // Without its query, and with escapes undone as the router undoes them. A malformed escape stays as text.
    const path = c.req.path
    if (path === '/api' || path.startsWith('/api/')) return notFound()
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return notFound()
    if (path === '/' || path === '/index.html') return servePage()
    const file = files.get(path)
    if (file !== undefined) {
      let bytes: Uint8Array<ArrayBuffer>
      try {
        bytes = new Uint8Array(await readFile(file))
      } catch {
        return notFound()
      }
      const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      return answer(bytes, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', cache)
    }
    if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return notFound()
    return servePage()
  })
}

/** A 200. Hono drops the body for a HEAD and keeps these headers. */
function answer(body: string | Uint8Array<ArrayBuffer>, type: string, cache: string): Response {
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': String(length) } })
}
