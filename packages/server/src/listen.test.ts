import { describe, expect, test } from 'vitest'
import { APP_PORT, openWithFallback, wantedPort } from './listen.ts'

const failure = (code: string) => Object.assign(new Error(`listen ${code}`), { code })

/** A fake `open`: throws the listed failures in order, then answers with the port it was given. */
function opener(...failures: Error[]) {
  const calls: number[] = []
  const open = async (port: number) => {
    calls.push(port)
    const next = failures.shift()
    if (next) throw next
    return `open on ${port}`
  }
  return { calls, open }
}

test('wantedPort', () => {
  expect(APP_PORT).toBe(47800)
  expect(wantedPort({})).toEqual({ port: 47800, fallback: true })
  expect(wantedPort({ POD_BOARD_API_PORT: '' })).toEqual({ port: 47800, fallback: true })
  expect(wantedPort({}, 5123)).toEqual({ port: 5123, fallback: true })
  expect(wantedPort({ POD_BOARD_API_PORT: '3110' })).toEqual({ port: 3110, fallback: false })
  expect(wantedPort({ POD_BOARD_API_PORT: '3110' }, 5123)).toEqual({ port: 3110, fallback: false })
  for (const bad of ['abc', '0', '70000', ' 3110', '-1']) {
    expect(() => wantedPort({ POD_BOARD_API_PORT: bad })).toThrow(/POD_BOARD_API_PORT/)
  }
})

describe('openWithFallback', () => {
  test.each(['EADDRINUSE', 'EACCES'])('falls back when the preferred port is unavailable (%s)', async (code) => {
    const { calls, open } = opener(failure(code))
    await expect(openWithFallback({ port: 5123, fallback: true }, open)).resolves.toBe('open on 0')
    expect(calls).toEqual([5123, 0])
  })

  test('the preferred port is used when it is free', async () => {
    const { calls, open } = opener()
    await expect(openWithFallback({ port: 5123, fallback: true }, open)).resolves.toBe('open on 5123')
    expect(calls).toEqual([5123])
  })

  test('a failure of the fallback itself rejects', async () => {
    const second = failure('EMFILE')
    const { calls, open } = opener(failure('EADDRINUSE'), second)
    await expect(openWithFallback({ port: 5123, fallback: true }, open)).rejects.toBe(second)
    expect(calls).toEqual([5123, 0])
  })

  test('no fallback', async () => {
    // Another listen error rejects as it is, with fallback on or off.
    for (const fallback of [true, false]) {
      const other = failure('EADDRNOTAVAIL')
      const { calls, open } = opener(other)
      await expect(openWithFallback({ port: 5123, fallback }, open)).rejects.toBe(other)
      expect(calls).toEqual([5123])
    }
    // A strict port that is busy or refused rejects naming the variable and the port.
    for (const code of ['EADDRINUSE', 'EACCES']) {
      const { calls, open } = opener(failure(code))
      await expect(openWithFallback({ port: 3110, fallback: false }, open)).rejects.toThrow(/POD_BOARD_API_PORT.*3110/)
      expect(calls).toEqual([3110])
    }
  })
})
