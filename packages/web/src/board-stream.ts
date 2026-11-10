// The live Board from GET /api/events. Over an injected EventSource factory so
// tests can drive it. On error it closes the source (EventSource's own retry is
// too eager and can't be capped), keeps the last Board, reports `lost`, and
// opens a new one after 1 s, doubling to 30 s at most. The delay resets once a
// valid Board arrives. Data that isn't a Board is ignored. With a `probe`, a
// failed health check (or one slower than 4 s) while a stream is open counts
// as an error too.

import type { Board } from '@openaflow/model'

export type StreamState = 'connecting' | 'live' | 'lost'

/** The part of `EventSource` the stream uses. */
export type StreamSource = {
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void
  close(): void
}

export const FIRST_RETRY_MS = 1000
export const MAX_RETRY_MS = 30_000
export const PROBE_EVERY_MS = 5000
/** A health check slower than this counts as down; under PROBE_EVERY_MS, so checks never overlap. */
export const PROBE_TIMEOUT_MS = 4000

export type StreamOptions = {
  /** Resolves true while the server is up. Checked every `probeEveryMs` while a stream is open. */
  probe?: () => Promise<boolean>
  probeEveryMs?: number
}

/** GET /api/health through the same origin as the stream; rejects after PROBE_TIMEOUT_MS. */
export async function healthProbe(fetchFn: typeof fetch = fetch): Promise<boolean> {
  // A hung request would block every later check (the stream skips while one runs).
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetchFn('/api/health', { cache: 'no-store', signal: abort.signal })
    return res.ok
  } finally {
    clearTimeout(timer)
  }
}

/** A Board-shaped value: enough to render without throwing. */
function asBoard(data: unknown): Board | undefined {
  if (typeof data !== 'string') return undefined
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const b = v as Partial<Board>
  if (typeof b.generatedAt !== 'number' || !Array.isArray(b.repos)) return undefined
  return v as Board
}

export function createBoardStream(
  open: () => StreamSource,
  onBoard: (b: Board) => void,
  onState: (s: StreamState) => void,
  options: StreamOptions = {},
): { stop(): void } {
  const { probe, probeEveryMs = PROBE_EVERY_MS } = options
  let probing = false
  let state: StreamState | undefined
  let source: StreamSource | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = FIRST_RETRY_MS
  let stopped = false

  const setState = (s: StreamState) => {
    if (s === state) return
    state = s
    onState(s)
  }

  const fail = (from: StreamSource | undefined) => {
    if (stopped || from !== source || timer !== undefined) return
    source?.close()
    source = undefined
    setState('lost')
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
    delay = Math.min(delay * 2, MAX_RETRY_MS)
  }

  const connect = () => {
    let s: StreamSource
    try {
      s = open()
    } catch {
      fail(undefined)
      return
    }
    source = s
    s.addEventListener('board', (ev) => {
      if (stopped || s !== source) return
      const board = asBoard(ev.data)
      if (!board) return
      delay = FIRST_RETRY_MS
      setState('live')
      onBoard(board)
    })
    s.addEventListener('error', () => fail(s))
  }

  // A proxy (Vite's, in dev) can hold the stream open after the server dies, and
  // the server's `: ping` comments never reach page code, so ask for health.
  const probeTimer = probe
    ? setInterval(() => {
        const s = source
        if (stopped || !s || probing) return
        probing = true
        probe()
          .then(
            (ok) => {
              if (!ok) fail(s)
            },
            () => fail(s),
          )
          .finally(() => {
            probing = false
          })
      }, probeEveryMs)
    : undefined

  setState('connecting')
  connect()

  return {
    stop() {
      stopped = true
      if (probeTimer !== undefined) clearInterval(probeTimer)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      source?.close()
      source = undefined
    },
  }
}
