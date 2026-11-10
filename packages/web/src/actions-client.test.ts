import { describe, expect, it } from 'vitest'
import { postAction, type ActionDeps } from './actions-client.ts'

const TOKEN = 'k'.repeat(43)

type Call = { url: string; init: RequestInit }

/** A fetch that records each call and answers with `reply`. */
function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as typeof fetch
  return { calls, fn }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const deps = (fetchFn: typeof fetch, ...token: [string | null | undefined] | []): ActionDeps => ({
  fetch: fetchFn,
  token: () => (token.length === 0 ? TOKEN : token[0]),
})

describe('action client', () => {
  it('sends the token header', async () => {
    const f = fakeFetch(() => json(200, { number: 7 }))
    const reply = await postAction<{ number: number }>('merge-preview', { repoId: 'r1', number: 7 }, deps(f.fn))
    expect(reply).toEqual({ ok: true, data: { number: 7 } })
    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0]!
    expect(url).toBe('/api/actions/merge-preview')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('x-openaflow-token')).toBe(TOKEN)
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ repoId: 'r1', number: 7 })
  })

  it('reads the token from the page on each call', async () => {
    let token = 'first'
    const f = fakeFetch(() => json(200, {}))
    await postAction('merge', {}, { fetch: f.fn, token: () => token })
    token = 'second'
    await postAction('merge', {}, { fetch: f.fn, token: () => token })
    expect(f.calls.map((c) => new Headers(c.init.headers).get('x-openaflow-token'))).toEqual(['first', 'second'])
  })

  it('reports each failure in words', async () => {
    // No token meta (or an empty one): no request, and the reload message.
    for (const token of [undefined, null, '']) {
      const f = fakeFetch(() => json(200, {}))
      expect(await postAction('merge', {}, deps(f.fn, token)), String(token)).toEqual({ ok: false, status: 0, message: 'Actions need a page reload.' })
      expect(f.calls).toEqual([])
    }

    // The server restarted with a new token.
    const restarted = fakeFetch(() => json(403, { error: 'bad token' }))
    expect(await postAction('merge', {}, deps(restarted.fn))).toEqual({ ok: false, status: 403, message: 'The board restarted. Reload the page.' })

    // The network failed.
    const down = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await postAction('merge', {}, deps(down.fn))).toEqual({ ok: false, status: 0, message: "Can't reach the board." })

    // Any other error: the body's error word.
    const notWaiting = fakeFetch(() => json(404, { error: 'not waiting on you' }))
    expect(await postAction('merge', {}, deps(notWaiting.fn))).toEqual({ ok: false, status: 404, message: 'not waiting on you' })
    const origin = fakeFetch(() => json(403, { error: 'forbidden origin' }))
    expect(await postAction('merge', {}, deps(origin.fn))).toEqual({ ok: false, status: 403, message: 'forbidden origin' })

    // No error word, or a body that isn't JSON: the HTTP status.
    const bare = fakeFetch(() => new Response('', { status: 500 }))
    expect(await postAction('merge', {}, deps(bare.fn))).toEqual({ ok: false, status: 500, message: 'HTTP 500' })
    const html = fakeFetch(() => new Response('<h1>Bad Gateway</h1>', { status: 502 }))
    expect(await postAction('merge', {}, deps(html.fn))).toEqual({ ok: false, status: 502, message: 'HTTP 502' })
    const blank = fakeFetch(() => json(503, { error: '' }))
    expect(await postAction('merge', {}, deps(blank.fn))).toEqual({ ok: false, status: 503, message: 'HTTP 503' })
  })

  it('a 502 with an empty body means the board is down', async () => {
    // The Vite proxy answers 502 with no body when the API isn't running.
    const proxy = fakeFetch(() => new Response('', { status: 502 }))
    expect(await postAction('merge-preview', {}, deps(proxy.fn))).toEqual({ ok: false, status: 502, message: "Can't reach the board." })
    const spaces = fakeFetch(() => new Response('  \n', { status: 502 }))
    expect(await postAction('merge-preview', {}, deps(spaces.fn))).toEqual({ ok: false, status: 502, message: "Can't reach the board." })
    // A 502 from the API itself (gh failed) keeps its words.
    const gh = fakeFetch(() => json(502, { error: 'gh failed' }))
    expect(await postAction('merge-preview', {}, deps(gh.fn))).toEqual({ ok: false, status: 502, message: 'gh failed' })
    // Only 502: an empty 500 or 504 still reads its status.
    const other = fakeFetch(() => new Response('', { status: 504 }))
    expect(await postAction('merge-preview', {}, deps(other.fn))).toEqual({ ok: false, status: 504, message: 'HTTP 504' })
  })

  it('a success whose body is not JSON is an error, not data', async () => {
    const f = fakeFetch(() => new Response('<html></html>', { status: 200 }))
    expect(await postAction('merge', {}, deps(f.fn))).toEqual({ ok: false, status: 200, message: 'HTTP 200' })
  })
})
