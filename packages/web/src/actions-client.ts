// Sends one action to the API with the page's session token. The Vite dev
// server puts the token in a <meta name="open-aflow-token"> tag; the API checks
// it on every /api/actions/ route. Every failure comes back as words a person
// can act on, never as a throw.

export type ActionReply<T> = { ok: true; data: T } | { ok: false; status: number; message: string }

export type ActionDeps = {
  fetch?: typeof fetch
  /** The session token; by default the page's token meta, read on each call. */
  token?: () => string | null | undefined
}

export const NEED_RELOAD = 'Actions need a page reload.'
export const RESTARTED = 'The board restarted. Reload the page.'
export const UNREACHABLE = "Can't reach the board."

/** The page's session token, from the `open-aflow-token` meta tag. */
export const pageToken = () => document.querySelector('meta[name="open-aflow-token"]')?.getAttribute('content')

/**
 * POST `/api/actions/<path>` with `body` as JSON. `path` is the action's name
 * under /api/actions, such as `merge-preview` (no leading slash).
 */
export async function postAction<T>(path: string, body: object, deps: ActionDeps = {}): Promise<ActionReply<T>> {
  const token = (deps.token ?? pageToken)()
  if (!token) return { ok: false, status: 0, message: NEED_RELOAD }
  let res: Response
  try {
    res = await (deps.fetch ?? fetch)(`/api/actions/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Open-AFlow-Token': token },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, status: 0, message: UNREACHABLE }
  }
  let text = ''
  try {
    text = await res.text()
  } catch {
    // An unreadable body reads like an empty one.
  }
  // The Vite proxy answers 502 with no body when the API isn't running.
  if (res.status === 502 && text.trim() === '') return { ok: false, status: 502, message: UNREACHABLE }
  let data: unknown
  let parsed = true
  try {
    data = JSON.parse(text)
  } catch {
    parsed = false
  }
  if (res.ok && parsed) return { ok: true, data: data as T }
  const error = parsed && typeof data === 'object' && data !== null ? (data as { error?: unknown }).error : undefined
  if (res.status === 403 && error === 'bad token') return { ok: false, status: 403, message: RESTARTED }
  const message = typeof error === 'string' && error.trim() !== '' ? error : `HTTP ${res.status}`
  return { ok: false, status: res.status, message }
}
