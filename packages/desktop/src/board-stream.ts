// The live Board in the main process: a fetch stream of GET /api/events, with its own SSE parser.
// It follows the server's port, and comes back by itself when the stream is lost. The rules are in
// pod-docs/feature-details/toasts.md.

import type { Board } from '@pod-board/model'

export const RETRY_MS = 5000
/** The server pings every 15 s. */
export const SILENCE_MS = 45_000

export type BoardStreamOptions = {
  fetch(url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> | null }>
  onBoard(board: Board): void
  /** The Boards stopped: until the next one, the last one may be stale. */
  onLost(): void
}
export type BoardStream = {
  /** Connects to this port at once, in place of any stream or retry. */
  moveTo(port: number): void
  close(): void
}

/** A Board-shaped value, the same check as the web page's stream. */
function asBoard(data: string): Board | undefined {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const b = v as Partial<Board>
  return typeof b.generatedAt === 'number' && Array.isArray(b.repos) ? (v as Board) : undefined
}

/** Feeds text in, and calls `onEvent` for each whole event. A line end split across chunks waits for the next one. */
function sseParser(onEvent: (type: string, data: string) => void): (text: string) => void {
  let buffer = ''
  let type = ''
  let data: string[] = []
  const line = (text: string) => {
    if (text === '') {
      if (data.length > 0) onEvent(type || 'message', data.join('\n'))
      type = ''
      data = []
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') type = value
    else if (field === 'data') data.push(value)
  }
  return (text) => {
    buffer += text
    for (;;) {
      const end = buffer.search(/[\r\n]/)
      // A CR at the very end may be half of a CRLF.
      if (end < 0 || (buffer[end] === '\r' && end === buffer.length - 1)) return
      const next = buffer[end] === '\r' && buffer[end + 1] === '\n' ? end + 2 : end + 1
      const current = buffer.slice(0, end)
      buffer = buffer.slice(next)
      line(current)
    }
  }
}

export function createBoardStream(o: BoardStreamOptions): BoardStream {
  let port: number | undefined
  let current: AbortController | undefined
  let silence: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false

  /** Ends the live connection and any wait. */
  const drop = () => {
    clearTimeout(silence)
    clearTimeout(retry)
    current?.abort()
    current = undefined
  }

  const lost = (conn: AbortController) => {
    if (conn !== current) return
    drop()
    o.onLost()
    retry = setTimeout(connect, RETRY_MS)
  }

  const heard = (conn: AbortController) => {
    clearTimeout(silence)
    silence = setTimeout(() => lost(conn), SILENCE_MS)
  }

  async function read(conn: AbortController, url: string): Promise<void> {
    const res = await o.fetch(url, { signal: conn.signal })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    // One decoder per connection: `stream` holds a character split across chunks.
    const decoder = new TextDecoder()
    const feed = sseParser((type, data) => {
      if (type !== 'board') return
      const board = asBoard(data)
      if (board) o.onBoard(board)
    })
    for (;;) {
      const { done, value } = await reader.read()
      if (done || conn !== current) return
      heard(conn)
      feed(decoder.decode(value, { stream: true }))
    }
  }

  function connect(): void {
    if (closed || port === undefined) return
    const conn = new AbortController()
    current = conn
    heard(conn)
    // Any way the read ends, the stream is lost. A connection already replaced counts for nothing.
    read(conn, `http://127.0.0.1:${port}/api/events`).then(
      () => lost(conn),
      () => lost(conn),
    )
  }

  return {
    moveTo(next) {
      if (closed) return
      drop()
      if (port !== undefined) o.onLost()
      port = next
      connect()
    },
    close() {
      closed = true
      drop()
    },
  }
}
