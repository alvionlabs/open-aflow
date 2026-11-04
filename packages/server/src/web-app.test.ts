import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Hono } from 'hono'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createWebApp } from './web-app.ts'

const TOKEN = 'test-token-value'
const INDEX = '<!doctype html><html><head><title>Board</title></head><body>page body</body></html>'
const META = `<meta name="pod-board-token" content="${TOKEN}">`

let root: string
let web: string
let app: Hono

/** Writes a file under the web folder, making its folders. */
const put = async (rel: string, text: string) => {
  const file = join(web, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

const expectPage = async (res: Response) => {
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-store')
  const body = await res.text()
  expect(body).toContain(META)
  expect(body).toContain('page body')
}

const expect404 = async (res: Response) => {
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  expect(await res.json()).toEqual({ error: 'not found' })
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pod-board-web-')))
  web = join(root, 'web')
  await put('index.html', INDEX)
  await put('assets/app-abc.js', 'console.log(1)')
  await put('assets/app-abc.css', 'body{}')
  await put('manifest.webmanifest', '{"name":"Pod Board"}')
  await put('data.json', '{}')
  await put('icons/icon.png', 'png')
  await put('icons/icon.svg', '<svg/>')
  await put('fonts/geist.woff2', 'font')
  await put('fonts/OFL.txt', 'licence')
  await put('other.bin', 'bytes')
  await put('sub/page.html', '<p>plain</p>')
  await writeFile(join(root, 'secret.txt'), 'SECRET')
  app = await createWebApp({ dir: web, token: TOKEN })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('serves the page with its token, uncached', async () => {
  await expectPage(await app.request('/'))
  await expectPage(await app.request('/index.html'))
})

test('nothing on disk holds the token', async () => {
  await app.request('/')
  expect(await readFile(join(web, 'index.html'), 'utf8')).toBe(INDEX)
})

test('page routes fall back to the page', async () => {
  await expectPage(await app.request('/some/page'))
  await expectPage(await app.request('/some/page?x=1.js'))
  await expectPage(await app.request('/?a=b'))
  await expectPage(await app.request('/index.html?v=2'))
  await expectPage(await app.request('/assets/'))
  await expectPage(await app.request('/a.b/page'))
})

test('a missing file is 404, not the page', async () => {
  for (const path of ['/sw.js', '/assets/missing.js', '/INDEX.HTML', '/index.html::$DATA', '/sw.js?x=1']) {
    await expect404(await app.request(path))
  }
})

test('API paths never get the page', async () => {
  for (const path of ['/api', '/api/', '/api/nope', '/api/index.html', '/api?x=1']) {
    await expect404(await app.request(path))
    await expect404(await app.request(path, { method: 'POST' }))
  }
  await expectPage(await app.request('/apix'))
  await expectPage(await app.request('/apix/nope'))
})

test('files keep their content types', async () => {
  const types: Record<string, string> = {
    '/assets/app-abc.js': 'text/javascript; charset=utf-8',
    '/assets/app-abc.css': 'text/css; charset=utf-8',
    '/manifest.webmanifest': 'application/manifest+json',
    '/data.json': 'application/json',
    '/icons/icon.png': 'image/png',
    '/icons/icon.svg': 'image/svg+xml',
    '/fonts/geist.woff2': 'font/woff2',
    '/fonts/OFL.txt': 'text/plain; charset=utf-8',
    '/sub/page.html': 'text/html; charset=utf-8',
    '/other.bin': 'application/octet-stream',
  }
  for (const [path, type] of Object.entries(types)) {
    const res = await app.request(path)
    expect(res.status, path).toBe(200)
    expect(res.headers.get('content-type'), path).toBe(type)
  }
  expect(await (await app.request('/manifest.webmanifest')).text()).toBe('{"name":"Pod Board"}')
  // Only the root page gets the token.
  expect(await (await app.request('/sub/page.html')).text()).toBe('<p>plain</p>')
})

test('cache headers by file kind', async () => {
  const immutable = 'public, max-age=31536000, immutable'
  expect((await app.request('/assets/app-abc.js')).headers.get('cache-control')).toBe(immutable)
  expect((await app.request('/assets/app-abc.css')).headers.get('cache-control')).toBe(immutable)
  expect((await app.request('/manifest.webmanifest')).headers.get('cache-control')).toBe('no-cache')
  expect((await app.request('/fonts/geist.woff2')).headers.get('cache-control')).toBe('no-cache')
})

test('no path reaches a file outside the folder', async () => {
  const spellings = [
    '/../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/%2e%2e%5csecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/secret.txt%00',
    '/%00/../secret.txt',
    '/..%2f..%2fsecret.txt%00.js',
    '/secret.txt',
  ]
  for (const path of spellings) {
    const res = await app.request(path)
    expect(res.status, path).toBe(404)
    expect(await res.text(), path).not.toContain('SECRET')
  }
  // An encoded separator never makes a listed file's path.
  await expect404(await app.request('/assets%2fapp-abc.js'))
})

test('a malformed path does not throw', async () => {
  for (const path of ['/%E0%A4%A', '/%', '/%zz', '/assets/%E0%A4%A.js', '/api/%E0%A4%A']) {
    const res = await app.request(path)
    expect(res.status, path).toBeLessThan(500)
  }
  await expectPage(await app.request('/%E0%A4%A'))
  await expect404(await app.request('/assets/%E0%A4%A.js'))
})

test('the file list is fixed at start', async () => {
  await rm(join(web, 'assets/app-abc.js'))
  await expect404(await app.request('/assets/app-abc.js'))
  expect((await app.request('/assets/app-abc.css')).status).toBe(200)
  await expectPage(await app.request('/'))

  await put('assets/later.js', 'later')
  await expect404(await app.request('/assets/later.js'))
})

test('the page text is read once, at start', async () => {
  await writeFile(join(web, 'index.html'), '<html><head></head><body>changed</body></html>')
  await expectPage(await app.request('/'))
  await rm(join(web, 'index.html'))
  await expectPage(await app.request('/'))
})

test('HEAD and other methods', async () => {
  for (const path of ['/', '/some/page', '/assets/app-abc.js', '/sw.js', '/api/nope']) {
    const get = await app.request(path)
    const head = await app.request(path, { method: 'HEAD' })
    expect(head.status, path).toBe(get.status)
    expect(Object.fromEntries(head.headers), path).toEqual(Object.fromEntries(get.headers))
    expect(await head.text(), path).toBe('')
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    await expect404(await app.request('/', { method }))
    await expect404(await app.request('/some/page', { method }))
    await expect404(await app.request('/assets/app-abc.js', { method }))
  }
})

test('a bad web folder rejects', async () => {
  const missing = join(root, 'missing')
  await expect(createWebApp({ dir: missing, token: TOKEN })).rejects.toThrow(missing)

  const noIndex = join(root, 'no-index')
  await mkdir(noIndex)
  await expect(createWebApp({ dir: noIndex, token: TOKEN })).rejects.toThrow(noIndex)

  const noHead = join(root, 'no-head')
  await mkdir(noHead)
  await writeFile(join(noHead, 'index.html'), '<html><body>no head</body></html>')
  await expect(createWebApp({ dir: noHead, token: TOKEN })).rejects.toThrow(noHead)

  const aFile = join(root, 'secret.txt')
  await expect(createWebApp({ dir: aFile, token: TOKEN })).rejects.toThrow(aFile)
})

test('every web answer refuses to be framed', async () => {
  const answers = await Promise.all([
    app.request('/'),
    app.request('/index.html'),
    app.request('/some/route'),
    app.request('/assets/app-abc.js'),
    app.request('/manifest.webmanifest'),
    app.request('/', { method: 'HEAD' }),
    app.request('/missing.js'),
    app.request('/api/nothing'),
    app.request('/', { method: 'POST' }),
  ])
  for (const res of answers) {
    expect(res.headers.get('content-security-policy'), res.url).toBe("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options'), res.url).toBe('DENY')
  }
})
