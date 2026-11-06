import { describe, expect, it, vi } from 'vitest'
import { NEED_RELOAD, RESTARTED } from './actions-client.ts'
import { errorSentence, postRepo } from './add-repo.ts'

describe('error sentences', () => {
  it('turns the API word into a sentence, with fallbacks', () => {
    expect(errorSentence({ status: 400, error: 'not absolute' })).toBe('Not absolute.')
    expect(errorSentence({ status: 403, error: 'forbidden origin' })).toBe('Forbidden origin.')
    expect(errorSentence({ status: 415 })).toBe('The server refused the request (HTTP 415).')
  })
})

describe('postRepo', () => {
  const token = () => 'tok-123'

  it('posts JSON with the session token and reads the status and error word', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'already registered' }), { status: 409 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 409, error: 'already registered' })
    expect(fetchFn).toHaveBeenCalledWith('/api/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Open-AFlow-Token': 'tok-123' },
      body: JSON.stringify({ path: '/repo' }),
    })
  })

  it('with no token on the page, sends nothing and asks for a reload', async () => {
    for (const none of [() => null, () => undefined, () => '']) {
      const fetchFn = vi.fn(async () => new Response('{}', { status: 201 }))
      expect(await postRepo('/repo', { fetch: fetchFn, token: none })).toEqual({ status: 0, error: NEED_RELOAD })
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })

  it('a dead token after a restart says to reload', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 403 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 403, error: RESTARTED })
    expect(errorSentence({ status: 403, error: RESTARTED })).toBe(RESTARTED)
  })

  it('a body that is not JSON gives just the status', async () => {
    const fetchFn = vi.fn(async () => new Response('oops', { status: 502 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 502 })
    const ok = vi.fn(async () => new Response(JSON.stringify({ path: '/repo' }), { status: 201 }))
    expect(await postRepo('/repo', { fetch: ok, token })).toEqual({ status: 201 })
  })
})
