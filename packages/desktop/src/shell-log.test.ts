import { describe, expect, test } from 'vitest'
import { createLogFile, LOG_FILE, LOG_MAX_BYTES, logLines, type LogFs } from './shell-log.ts'

const fakeFs = () => {
  const files = new Map<string, string>()
  const fs: LogFs = {
    size: (f) => {
      if (!files.has(f)) throw new Error('ENOENT')
      return files.get(f)!.length
    },
    append: (f, t) => void files.set(f, (files.get(f) ?? '') + t),
    rename: (a, b) => {
      files.set(b, files.get(a)!)
      files.delete(a)
    },
  }
  return { files, fs }
}
const NOW = new Date(Date.UTC(2026, 10, 4, 12))
const STAMP = '2026-11-04T12:00:00.000Z'

describe('log lines', () => {
  test('words join to one line, and a chunk of server output splits into its lines', () => {
    expect(logLines(['pod-board desktop: toast sent'])).toEqual(['pod-board desktop: toast sent'])
    expect(logLines(['a', 'b'])).toEqual(['a b'])
    expect(logLines(['one\r\ntwo\n\n'])).toEqual(['one', 'two'])
  })

  test('an error keeps only its name: its message can hold what the app read', () => {
    expect(logLines(['pod-board desktop: notifier error:', new TypeError('BLOCKED: entry text')])).toEqual(['pod-board desktop: notifier error: TypeError'])
    expect(logLines(['x', { title: 'entry text' }, 3])).toEqual(['x [object] [number]'])
  })

  test('a line that names a token is left out, in any case', () => {
    expect(logLines(['X-Pod-Board-Token: abc'])).toEqual(['[left out: names a token]'])
    expect(logLines(['ok\nsession TOKEN=abc\nok too'])).toEqual(['ok', '[left out: names a token]', 'ok too'])
  })

  test('a very long line is cut', () => {
    expect(logLines(['x'.repeat(5000)])[0]).toHaveLength(500)
  })
})

describe('the log file', () => {
  test('each line gets its time', () => {
    const { files, fs } = fakeFs()
    createLogFile({ file: 'd.log', fs, now: () => NOW }).write(['one\ntwo'])
    expect(files.get('d.log')).toBe(`${STAMP} one\n${STAMP} two\n`)
  })

  test('past the limit it moves to one old file, so at most two files ever stay', () => {
    const { files, fs } = fakeFs()
    const log = createLogFile({ file: 'd.log', fs, now: () => NOW, maxBytes: 60 })
    log.write(['first line'])
    log.write(['second line'])
    expect([...files.keys()]).toEqual(['d.log'])
    log.write(['third line'])
    expect(files.get('d.log.1')).toContain('second line')
    expect(files.get('d.log')).toBe(`${STAMP} third line\n`)
    log.write(['fourth line'])
    log.write(['fifth line'])
    expect([...files.keys()].sort()).toEqual(['d.log', 'd.log.1'])
    expect(files.get('d.log.1')).not.toContain('first line')
  })

  test('a limit keeps it small', () => {
    expect(LOG_FILE).toBe('desktop.log')
    expect(LOG_MAX_BYTES).toBe(256 * 1024)
  })

  test('a failed write never reaches the app', () => {
    const boom = () => {
      throw new Error('EPERM')
    }
    const log = createLogFile({ file: 'd.log', fs: { size: boom, append: boom, rename: boom }, now: () => NOW })
    expect(() => log.write(['a line'])).not.toThrow()
  })
})
