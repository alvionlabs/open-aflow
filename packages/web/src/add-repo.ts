// Adding a repo: the POST to /api/repos and the error word as a sentence. The
// folder picker (screens/runs/folder-picker.ts) drives them.

import { NEED_RELOAD, pageToken, RESTARTED } from './actions-client.ts'

export type AddResult = { status: number; error?: string }

export type PostRepoDeps = {
  fetch?: typeof fetch
  /** The session token; by default the page's token meta, read on each call. */
  token?: () => string | null | undefined
}

/**
 * POST /api/repos with the page's session token, as the action client sends it. The
 * browser adds the `Origin` header the server's guard checks. No token on the page →
 * nothing is sent and the error asks for a reload; a token from before an API restart →
 * the same words the actions use.
 */
export async function postRepo(path: string, deps: PostRepoDeps = {}): Promise<AddResult> {
  const token = (deps.token ?? pageToken)()
  if (!token) return { status: 0, error: NEED_RELOAD }
  const res = await (deps.fetch ?? fetch)('/api/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Open-AFlow-Token': token },
    body: JSON.stringify({ path }),
  })
  let error: unknown
  try {
    error = ((await res.json()) as { error?: unknown } | null)?.error
  } catch {
    error = undefined
  }
  if (res.status === 403 && error === 'bad token') return { status: 403, error: RESTARTED }
  return typeof error === 'string' && error.length > 0 ? { status: res.status, error } : { status: res.status }
}

/** `already registered` → `Already registered.` With no error word, says the HTTP status. */
export function errorSentence(r: AddResult): string {
  const word = r.error?.trim()
  if (!word) return `The server refused the request (HTTP ${r.status}).`
  const s = word[0]!.toUpperCase() + word.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}
