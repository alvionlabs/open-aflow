import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Board } from '@pod-board/model'
import { createBoardStream, RETRY_MS, SILENCE_MS, type BoardStreamOptions } from './board-stream.ts'

const enc = new TextEncoder()
const boardAt = (generatedAt: number, name = 'repo'): Board => ({ generatedAt, gh: 'ok', repos: [{ id: name } as Board['repos'][number]] })
const event = (b: Board) => `event: board\ndata: ${JSON.stringify(b)}\n\n`

type Conn = { url: string; signal: AbortSignal; push(text: string | Uint8Array): void; end(): void; fail(): void }

/** A stand-in fetch: each call is one connection the test drives by hand. */
function fakeFetch() {
  const conns: Conn[] = []
  const fetch: BoardStreamOptions['fetch'] = (url, init) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
      },
    })
    let open = true
    const stop = (how: () => void) => {
      if (!open) return
      open = false
      how()
    }
    init.signal.addEventListener('abort', () => stop(() => ctrl.error(new Error('aborted'))))
    conns.push({
      url,
      signal: init.signal,
      push: (text) => ctrl.enqueue(typeof text === 'string' ? enc.encode(text) : text),
      end: () => stop(() => ctrl.close()),
      fail: () => stop(() => ctrl.error(new Error('socket hang up'))),
    })
    return Promise.resolve({ ok: true, body })
  }
  return { fetch, conns }
}

function setup(fetch?: BoardStreamOptions['fetch']) {
  const fake = fakeFetch()
  const boards: Board[] = []
  const lost = vi.fn()
  const stream = createBoardStream({ fetch: fetch ?? fake.fetch, onBoard: (b) => boards.push(b), onLost: lost })
  return { ...fake, boards, lost, stream }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('board stream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('parses the stream', async () => {
    const s = setup()
    s.stream.moveTo(47800)
    await settle()
    expect(s.conns[0]?.url).toBe('http://127.0.0.1:47800/api/events')

    // Pings, another event, and a retry field around one whole Board.
    s.conns[0]!.push(`: ping\n\nevent: other\ndata: {"generatedAt":1,"repos":[]}\n\nretry: 10\n\n${event(boardAt(1))}: ping\n\n`)
    await settle()
    expect(s.boards.map((b) => b.generatedAt)).toEqual([1])

    // CRLF line ends, a comment inside the event, and data on two lines.
    const two = JSON.stringify(boardAt(2)).replace('"gh":', '"gh":\r\ndata: ')
    s.conns[0]!.push(`event: board\r\n: note\r\ndata: ${two}\r\n\r\n`)
    await settle()
    expect(s.boards.map((b) => b.generatedAt)).toEqual([1, 2])

    // Every split of one event, also inside a multi-byte character and between CR and LF.
    const multi = boardAt(3, 'bàn cờ – 日本語 🎲')
    const bytes = enc.encode(`: ping\r\n\r\n${event(multi)}`)
    for (let cut = 1; cut < bytes.length; cut++) {
      s.conns[0]!.push(bytes.slice(0, cut))
      await settle()
      s.conns[0]!.push(bytes.slice(cut))
      await settle()
    }
    expect(s.boards.slice(2)).toHaveLength(bytes.length - 1)
    for (const b of s.boards.slice(2)) expect(b).toEqual(multi)

    // One byte at a time.
    s.boards.length = 0
    for (const byte of bytes) s.conns[0]!.push(Uint8Array.of(byte))
    await settle()
    expect(s.boards).toEqual([multi])
    s.stream.close()
  })

  test("bad data doesn't end the stream", async () => {
    const s = setup()
    s.stream.moveTo(1)
    await settle()
    // Not JSON, then JSON that isn't a Board.
    s.conns[0]!.push('event: board\ndata: {oops\n\nevent: board\ndata: null\n\nevent: board\ndata: {"generatedAt":"x","repos":[]}\n\nevent: board\ndata: {"generatedAt":1}\n\n')
    s.conns[0]!.push(event(boardAt(7)))
    await settle()
    expect(s.boards.map((b) => b.generatedAt)).toEqual([7])
    expect(s.conns).toHaveLength(1)
    expect(s.lost).not.toHaveBeenCalled()
    s.stream.close()
  })

  test('a lost stream comes back', async () => {
    // A rejected fetch, then a server error: each retries after 5 s and nothing rejects.
    let calls = 0
    const fake = fakeFetch()
    const flaky: BoardStreamOptions['fetch'] = (url, init) => {
      calls++
      if (calls === 1) return Promise.reject(new Error('ECONNREFUSED'))
      if (calls === 2) return Promise.resolve({ ok: false, body: null })
      return fake.fetch(url, init)
    }
    const s = setup(flaky)
    s.stream.moveTo(1)
    await settle()
    expect(calls).toBe(1)
    expect(s.lost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(calls).toBe(3)
    fake.conns[0]!.push(event(boardAt(1)))
    await settle()
    expect(s.boards).toHaveLength(1)

    // A closed stream retries after 5 s. A half event from it is dropped.
    fake.conns[0]!.push('event: board\ndata: {"generatedAt":99,')
    await settle()
    fake.conns[0]!.end()
    await settle()
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1)
    expect(fake.conns).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.conns).toHaveLength(2)
    fake.conns[1]!.push('"repos":[]}\n\n')
    fake.conns[1]!.push(event(boardAt(2)))
    await settle()
    expect(s.boards.map((b) => b.generatedAt)).toEqual([1, 2])

    // An error on the socket does the same.
    fake.conns[1]!.fail()
    await settle()
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(fake.conns).toHaveLength(3)

    // 45 s of silence counts as lost, and any byte, a ping included, keeps it alive.
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1)
    fake.conns[2]!.push(': ping\n\n')
    await settle()
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1)
    expect(fake.conns[2]!.signal.aborted).toBe(false)
    const before = s.lost.mock.calls.length
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.conns[2]!.signal.aborted).toBe(true)
    expect(s.lost).toHaveBeenCalledTimes(before + 1)
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(fake.conns).toHaveLength(4)
    s.stream.close()
  })

  test('a fetch that never answers counts as silence', async () => {
    const signals: AbortSignal[] = []
    const s = setup((_url, init) => {
      signals.push(init.signal)
      return new Promise(() => {})
    })
    s.stream.moveTo(1)
    await settle()
    await vi.advanceTimersByTimeAsync(SILENCE_MS)
    expect(signals[0]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(signals).toHaveLength(2)
    s.stream.close()
  })

  test('follows the server', async () => {
    const s = setup()
    s.stream.moveTo(1)
    await settle()
    s.conns[0]!.push(event(boardAt(1)))
    await settle()

    // A new port opens at once and ends the old stream.
    s.stream.moveTo(2)
    await settle()
    expect(s.conns[1]?.url).toBe('http://127.0.0.1:2/api/events')
    expect(s.conns[0]!.signal.aborted).toBe(true)
    s.conns[1]!.push(event(boardAt(2)))
    await settle()
    expect(s.boards.map((b) => b.generatedAt)).toEqual([1, 2])

    // A move while a retry waits replaces that retry.
    s.conns[1]!.end()
    await settle()
    s.stream.moveTo(3)
    await settle()
    expect(s.conns.map((c) => c.url.match(/:(\d+)\//)?.[1])).toEqual(['1', '2', '3'])
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(s.conns).toHaveLength(3)

    // Close ends the stream with no later retry, and a later move does nothing.
    s.stream.close()
    await settle()
    expect(s.conns[2]!.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(RETRY_MS + SILENCE_MS)
    s.stream.moveTo(4)
    await settle()
    expect(s.conns).toHaveLength(3)

    // Close while a retry waits.
    const t = setup()
    t.stream.moveTo(1)
    await settle()
    t.conns[0]!.end()
    await settle()
    t.stream.close()
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(t.conns).toHaveLength(1)
  })
})
