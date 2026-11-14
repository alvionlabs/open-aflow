// Adding a repo: the POST to /api/repos and the error word as a sentence. The
// Add repo flow (screens/runs/add-repo-flow.ts) drives them.

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
    headers: { 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
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

// Short and warm, with no period at the end (DESIGN.md, "Forms and errors"). Remove repo and Forget use the last two too.
export const ADD_ALREADY = 'This repo is already here'
export const ADD_BAD_PATH = "That path doesn't look right"
export const TRY_AGAIN = 'Something went wrong. Please try again'
export const RELOAD = 'The app restarted. Please reload'

/** What the modal says after a refused add. `pathError`: the same path would fail again, so Add waits for a change. */
export type AddError = { message: string; pathError: boolean }

const BAD_PATH = new Set(['not absolute', 'not a local path', 'not a directory'])

/**
 * Three messages, by what you can do next: change the path, reload, or try again. The exact cause goes to the
 * console, so a bug report can still name it.
 */
export function addError(r: AddResult): AddError {
  const word = r.error?.trim()
  if (word === 'already registered') return { message: ADD_ALREADY, pathError: true }
  if (word !== undefined && BAD_PATH.has(word)) return { message: ADD_BAD_PATH, pathError: true }
  if (word === RESTARTED || word === NEED_RELOAD) return { message: RELOAD, pathError: false }
  console.warn(`openaflow: add repo failed (HTTP ${r.status}${word ? `: ${word}` : ''})`)
  return { message: TRY_AGAIN, pathError: false }
}
