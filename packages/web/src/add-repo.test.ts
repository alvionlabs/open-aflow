import { describe, expect, it, vi } from 'vitest'
import { NEED_RELOAD, RESTARTED, UNREACHABLE } from './actions-client.ts'
import { ADD_ALREADY, ADD_BAD_PATH, ADD_FAILED, ADD_RELOAD, addError, postRepo } from './add-repo.ts'

describe('the message for a failed add', () => {
  it('a status with no error word is a failed add', () => {
    expect(addError({ status: 415 })).toEqual({ message: ADD_FAILED, pathError: false })
  })
})

describe('postRepo', () => {
  const token = () => 'tok-123'

  it('posts JSON with the session token and reads the status and error word', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'already registered' }), { status: 409 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 409, error: 'already registered' })
    expect(fetchFn).toHaveBeenCalledWith('/api/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenAFlow-Token': 'tok-123' },
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
    expect(addError({ status: 403, error: RESTARTED })).toEqual({ message: ADD_RELOAD, pathError: false })
  })

  it('a body that is not JSON gives just the status', async () => {
    const fetchFn = vi.fn(async () => new Response('oops', { status: 502 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 502 })
    const ok = vi.fn(async () => new Response(JSON.stringify({ path: '/repo' }), { status: 201 }))
    expect(await postRepo('/repo', { fetch: ok, token })).toEqual({ status: 201 })
  })
})

describe('the three messages and the path rule', () => {
  it('a repo already on the board', () => {
    expect(addError({ status: 409, error: 'already registered' })).toEqual({ message: ADD_ALREADY, pathError: true })
  })
  it('a path that is not a folder on this computer', () => {
    for (const error of ['not absolute', 'not a local path', 'not a directory']) {
      expect(addError({ status: 400, error })).toEqual({ message: ADD_BAD_PATH, pathError: true })
    }
  })
  it('anything else: try again, or reload when the token is gone', () => {
    for (const r of [{ status: 0, error: UNREACHABLE }, { status: 500, error: 'config unreadable' }, { status: 403, error: 'forbidden origin' }, { status: 502 }]) {
      expect(addError(r)).toEqual({ message: ADD_FAILED, pathError: false })
    }
    expect(addError({ status: 0, error: NEED_RELOAD })).toEqual({ message: ADD_RELOAD, pathError: false })
  })

  it('the exact cause goes to the console for a failed add, and only then', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addError({ status: 500, error: 'config unreadable' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/HTTP 500.*config unreadable/))
    addError({ status: 502 })
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('HTTP 502'))
    warn.mockClear()
    addError({ status: 409, error: 'already registered' })
    addError({ status: 400, error: 'not a directory' })
    addError({ status: 403, error: RESTARTED })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
