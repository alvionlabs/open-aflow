import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSessionToken, injectTokenMeta, readSessionToken, TOKEN_FILE, tokenMetaPlugin, writeSessionToken } from './session-token.ts'

const HTML = '<!doctype html>\n<html>\n  <head>\n    <title>Open AFlow</title>\n  </head>\n  <body></body>\n</html>\n'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-aflow-s1-token-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The token meta tags in an HTML text, with their `content`. */
const metas = (html: string) => [...html.matchAll(/<meta name="open-aflow-token" content="([^"]*)">/g)].map((m) => m[1])

describe('session token', () => {
  test('creates a fresh token each launch', () => {
    const tokens = Array.from({ length: 20 }, () => createSessionToken())
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  test('writes the token atomically, owner-only', async () => {
    // The config folder doesn't exist yet on a first launch.
    const dir = join(root, 'cfg')
    const first = createSessionToken()
    await writeSessionToken(dir, first)
    expect(await readFile(join(dir, TOKEN_FILE), 'utf8')).toBe(first)

    const second = createSessionToken()
    await writeSessionToken(dir, second)
    expect(await readFile(join(dir, TOKEN_FILE), 'utf8')).toBe(second)
    // The temp file was renamed into place: only the token file is left.
    expect(await readdir(dir)).toEqual([TOKEN_FILE])
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, TOKEN_FILE))).mode & 0o777).toBe(0o600)
    }
  })

  test('a token that cannot be written fails with the file named, and no token in the error', async () => {
    // The config "folder" is a file, so nothing can be written under it.
    const dir = join(root, 'not-a-folder')
    await writeFile(dir, 'x')
    const token = createSessionToken()
    const err = await writeSessionToken(dir, token).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(join(dir, TOKEN_FILE))
    expect((err as Error).message).not.toContain(token)
  })

  test('a failed rename leaves no temp file behind', async () => {
    // A folder where the token file should be makes the rename fail.
    const dir = join(root, 'cfg')
    await mkdir(join(dir, TOKEN_FILE), { recursive: true })
    await expect(writeSessionToken(dir, createSessionToken())).rejects.toThrow(join(dir, TOKEN_FILE))
    expect(await readdir(dir)).toEqual([TOKEN_FILE])
  })

  test('reads no token from a missing file', async () => {
    expect(readSessionToken(join(root, 'nope'))).toBeUndefined()
    // Unreadable: the token path is a folder.
    await mkdir(join(root, 'dir', TOKEN_FILE), { recursive: true })
    expect(readSessionToken(join(root, 'dir'))).toBeUndefined()
    // Empty or blank.
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'empty', TOKEN_FILE), ' \n')
    expect(readSessionToken(join(root, 'empty'))).toBeUndefined()
    // A written token reads back, without a trailing newline someone added.
    const token = createSessionToken()
    await writeSessionToken(join(root, 'ok'), token)
    expect(readSessionToken(join(root, 'ok'))).toBe(token)
    await writeFile(join(root, 'ok', TOKEN_FILE), `${token}\n`)
    expect(readSessionToken(join(root, 'ok'))).toBe(token)
  })
})

describe('token meta', () => {
  test('asks for the folder at each page load, so it follows the folder the server picked', async () => {
    let dir = join(root, 'old')
    const plugin = tokenMetaPlugin(() => dir)
    const a = createSessionToken()
    await writeSessionToken(dir, a)
    expect(metas(plugin.transformIndexHtml(HTML))).toEqual([a])
    dir = join(root, 'new')
    const b = createSessionToken()
    await writeSessionToken(dir, b)
    expect(metas(plugin.transformIndexHtml(HTML))).toEqual([b])
  })

  test('injects the token meta on each page load', async () => {
    const dir = join(root, 'cfg')
    const plugin = tokenMetaPlugin(dir)

    // No file → html unchanged.
    expect(plugin.transformIndexHtml(HTML)).toBe(HTML)

    const first = createSessionToken()
    await writeSessionToken(dir, first)
    const page = plugin.transformIndexHtml(HTML)
    expect(metas(page)).toEqual([first])
    const head = page.slice(page.indexOf('<head>'), page.indexOf('</head>'))
    expect(metas(head)).toEqual([first])

    // A restart writes a new token; the next page load has it.
    const second = createSessionToken()
    await writeSessionToken(dir, second)
    expect(metas(plugin.transformIndexHtml(HTML))).toEqual([second])
  })

  test('the meta value is HTML-escaped', () => {
    const page = injectTokenMeta(HTML, `a"b<c>d&e'f`)
    expect(page).toContain('<meta name="open-aflow-token" content="a&quot;b&lt;c&gt;d&amp;e&#39;f">')
    expect(page).not.toContain('a"b')
  })

  test('no token, or no head, leaves the html unchanged', () => {
    expect(injectTokenMeta(HTML)).toBe(HTML)
    expect(injectTokenMeta(HTML, '')).toBe(HTML)
    expect(injectTokenMeta('<p>no head</p>', 'abc')).toBe('<p>no head</p>')
    // An upper-case head still gets it.
    expect(metas(injectTokenMeta('<HTML><HEAD></HEAD></HTML>', 'abc'))).toEqual(['abc'])
  })

  test('plugin runs only on the dev server', () => {
    const plugin = tokenMetaPlugin(root)
    expect(plugin.apply).toBe('serve')
    expect(plugin.name).toBe('open-aflow-token')
  })
})
