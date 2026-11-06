// The per-launch session token. The API writes a fresh one to the config
// folder at each start; the Vite dev server reads it on each page load and puts
// it in a <meta> tag; the page sends it back on every action request. A page on
// another site can't read the file or the meta, so it can't forge an action.
// The token is never printed, and never sent in the Board, SSE, a URL, or a cookie.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const TOKEN_FILE = 'session-token'
export const TOKEN_META = 'open-aflow-token'

/** A Vite plugin, typed by shape so the server package needs no `vite`. */
export type TokenMetaPlugin = { name: string; apply: 'serve'; transformIndexHtml: (html: string) => string }

/** 32 random bytes as base64url: 43 characters. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Writes `token` to `<dir>/session-token`, replacing the last launch's: a temp
 * file (owner-only on POSIX) renamed into place, so a reader never sees half a
 * token. Throws an error naming the file, never the token.
 */
export async function writeSessionToken(dir: string, token: string): Promise<void> {
  const file = path.join(dir, TOKEN_FILE)
  const temp = path.join(dir, `${TOKEN_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temp, token, { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(`could not write the session token file ${file}${code ? ` (${code})` : ''}`)
  }
}

/** The token in `<dir>/session-token`, or undefined when it's missing, unreadable, or blank. */
export function readSessionToken(dir: string): string | undefined {
  try {
    const token = readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim()
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** `html` with the token meta added at the end of its <head>. No token, or no </head>: unchanged. */
export function injectTokenMeta(html: string, token?: string): string {
  if (!token) return html
  const end = html.search(/<\/head\s*>/i)
  if (end < 0) return html
  const meta = `<meta name="${TOKEN_META}" content="${token.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)}">`
  return html.slice(0, end) + meta + html.slice(end)
}

/**
 * Puts the current token in index.html on every page load. `apply: 'serve'`,
 * so `vite build` never bakes a token into `dist`.
 */
export function tokenMetaPlugin(dir: string | (() => string)): TokenMetaPlugin {
  const at = typeof dir === 'function' ? dir : () => dir
  return { name: 'open-aflow-token', apply: 'serve', transformIndexHtml: (html) => injectTokenMeta(html, readSessionToken(at())) }
}
