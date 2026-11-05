import { describe, expect, test } from 'vitest'
import { createLogFile, LOG_FILE, LOG_MAX_BYTES, logLines, teeConsole, type LogFs } from './shell-log.ts'

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

describe('the home folder', () => {
  const HOME = 'C:\\Users\\Name'
  const line = (text: string) => logLines([text], HOME)[0]

  test('becomes ~, in each spelling', () => {
    expect(line('config: C:\\Users\\Name\\AppData\\x')).toBe('config: ~\\AppData\\x')
    expect(line('c:\\users\\NAME\\AppData')).toBe('~\\AppData')
    expect(line('C:/Users/Name/AppData')).toBe('~/AppData')
    expect(line('{"path":"C:\\\\Users\\\\Name\\\\AppData"}')).toBe('{"path":"~\\\\AppData"}')
    expect(line('file:///C:/Users/Name/x')).toBe('file:///~/x')
    expect(line('C:\\Users\\Name')).toBe('~')
    expect(line('in C:\\Users\\Name. Then C:\\Users\\Name\\a and "C:\\Users\\Name"')).toBe('in ~. Then ~\\a and "~"')
  })

  test('a folder that only starts with the same letters stays', () => {
    for (const other of ['C:\\Users\\Name2', 'C:\\Users\\Name2\\x', 'C:\\Users\\Name-old', 'C:\\Users\\Name_b', 'C:\\Users\\Name.old\\x', 'C:\\Users\\Namé', 'D:\\Users\\Name']) {
      expect(line(other), other).toBe(other)
    }
  })

  test('a name with signs in it is read as plain text', () => {
    expect(logLines(['C:\\Users\\a.b (c)+\\x', 'C:\\Users\\aXb (c)+\\x'], 'C:\\Users\\a.b (c)+')[0]).toBe('~\\x C:\\Users\\aXb (c)+\\x')
  })

  test('with no home, or a drive root, nothing changes', () => {
    expect(logLines(['C:\\Users\\Name\\x'])).toEqual(['C:\\Users\\Name\\x'])
    expect(logLines(['C:\\Users\\Name\\x'], '')).toEqual(['C:\\Users\\Name\\x'])
    expect(logLines(['C:\\x'], 'C:\\')).toEqual(['C:\\x'])
  })

  test('the file gets it, in every line of a chunk', () => {
    const { files, fs } = fakeFs()
    createLogFile({ file: 'd.log', fs, now: () => NOW, home: HOME }).write(['pod-board config: C:\\Users\\Name\\a\nnext C:/Users/Name/b'])
    expect(files.get('d.log')).toBe(`${STAMP} pod-board config: ~\\a\n${STAMP} next ~/b\n`)
  })

  test('a long line is cut after the swap, so a cut never leaves part of the name', () => {
    const text = `${'x'.repeat(495)}C:\\Users\\Name\\y`
    expect(line(text)).toBe(`${'x'.repeat(495)}~\\y`)
  })
})

describe('the console', () => {
  test('each line still reaches the console, and also the file', () => {
    const seen: unknown[][] = []
    const target = { log: (...a: unknown[]) => void seen.push(['log', ...a]), error: (...a: unknown[]) => void seen.push(['error', ...a]), warn: (...a: unknown[]) => void seen.push(['warn', ...a]) }
    const written: unknown[][] = []
    teeConsole(target, { write: (args) => void written.push(args) })
    const err = new Error('entry text')
    target.log('a')
    target.error('b', err)
    target.warn('c')
    expect(seen).toEqual([['log', 'a'], ['error', 'b', err], ['warn', 'c']])
    expect(written).toEqual([['a'], ['b', err], ['c']])
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
