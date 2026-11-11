import { describe, expect, test } from 'vitest'
import { createUpdateFlow, FIRST_CHECK_MS, LAST_CHANCE_MS, RECHECK_MS, type UpdaterPort } from './update-flow.ts'

type Answer = 'restart' | 'later'

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0
  let timers: { at: number; fn: () => void }[] = []
  return {
    after(ms: number, fn: () => void) {
      timers.push({ at: now + ms, fn })
    },
    count: () => timers.length,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = due.at
        due.fn()
        await settle()
      }
      now = end
    },
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(o: { packaged?: boolean; firstCheckMs?: number; stop?: () => Promise<unknown>; updaterThrows?: boolean; ask?: (v: string) => Promise<Answer> } = {}) {
  const events: string[] = []
  const logs: string[] = []
  const clock = fakeClock()
  let downloaded: (version: string) => void = () => {}
  let errored: (e: unknown) => void = () => {}
  let made = 0
  let quitting = false
  const port: UpdaterPort & { nextCheck: () => ReturnType<UpdaterPort['check']>; installImpl: () => void } = {
    nextCheck: () => Promise.resolve(null),
    installImpl: () => {},
    check() {
      events.push('check')
      return port.nextCheck()
    },
    install() {
      events.push('install')
      port.installImpl()
    },
    onDownloaded: (fn) => void (downloaded = fn),
    onError: (fn) => void (errored = fn),
  }
  const answers: Answer[] = []
  const flow = createUpdateFlow({
    packaged: o.packaged ?? true,
    firstCheckMs: o.firstCheckMs,
    updater: () => {
      made++
      if (o.updaterThrows) throw new Error('bad https://example.com/secret')
      return port
    },
    ask:
      o.ask ??
      (async (version) => {
        events.push(`ask ${version}`)
        return answers.shift() ?? 'later'
      }),
    stop:
      o.stop ??
      (async () => {
        events.push('stop')
        return 'stopped'
      }),
    quit: () => void events.push('quit'),
    quitting: () => quitting,
    clock,
    log: (line) => void logs.push(line),
  })
  return {
    flow,
    port,
    clock,
    events,
    logs,
    answers,
    made: () => made,
    beginQuit: () => void (quitting = true),
    download: async (version: string) => {
      downloaded(version)
      await settle()
    },
    error: async (e: unknown) => {
      errored(e)
      await settle()
    },
    checks: () => events.filter((e) => e === 'check').length,
  }
}

describe('createUpdateFlow', () => {
  test('no check when unpackaged', async () => {
    const t = setup({ packaged: false })
    t.flow.start()
    await t.clock.advance(RECHECK_MS * 3)
    expect(t.checks()).toBe(0)
    expect(t.logs).toEqual([])
    expect(t.clock.count()).toBe(0)
    expect(t.made()).toBe(0)
  })

  test('check times', async () => {
    expect(FIRST_CHECK_MS).toBe(30_000)
    expect(RECHECK_MS).toBe(6 * 60 * 60_000)
    const t = setup()
    await t.clock.advance(FIRST_CHECK_MS * 10)
    expect(t.checks()).toBe(0)

    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS - 1)
    expect(t.checks()).toBe(0)
    await t.clock.advance(1)
    expect(t.checks()).toBe(1)

    // A server restart's second ready adds no timer, before or after the first check.
    t.flow.start()
    expect(t.clock.count()).toBe(1)
    await t.clock.advance(RECHECK_MS - 1)
    expect(t.checks()).toBe(1)
    await t.clock.advance(1)
    expect(t.checks()).toBe(2)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(3)
    expect(t.clock.count()).toBe(1)
  })

  test('a second start before the first check adds no timer', async () => {
    const t = setup()
    t.flow.start()
    t.flow.start()
    expect(t.clock.count()).toBe(1)
    await t.clock.advance(FIRST_CHECK_MS)
    expect(t.checks()).toBe(1)
    expect(t.made()).toBe(1)
  })

  test('the first delay can be replaced', async () => {
    const t = setup({ firstCheckMs: 500 })
    t.flow.start()
    await t.clock.advance(500)
    expect(t.checks()).toBe(1)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)
  })

  test('no overlapping checks', async () => {
    const t = setup()
    const check = deferred<null>()
    t.port.nextCheck = () => check.promise
    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS)
    expect(t.checks()).toBe(1)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(1)

    // The check ends with a download, which also holds the next one back.
    const download = deferred()
    t.port.nextCheck = () => Promise.resolve({ downloadPromise: download.promise })
    check.resolve(null)
    await settle()
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)

    download.resolve()
    await settle()
    t.port.nextCheck = () => Promise.resolve(null)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(3)
  })

  test('a failure stays quiet and retries', async () => {
    const URL_TEXT = 'https://github.com/alvionlabs/openaflow/releases/latest?token=abc123'
    const t = setup()
    const failure = Object.assign(new Error(`HttpError: 500 ${URL_TEXT}`), { code: 'HTTP_ERROR_500' })
    t.port.nextCheck = () => {
      // electron-updater emits `error`, and also rejects.
      void t.error(failure)
      return Promise.reject(failure)
    }
    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS)
    expect(t.logs).toHaveLength(1)
    expect(t.logs[0]).toContain('HTTP_ERROR_500')
    expect(t.logs.join()).not.toMatch(/https?:|token|abc123|github/)
    expect(t.events.filter((e) => e.startsWith('ask'))).toEqual([])

    t.port.nextCheck = () => Promise.resolve(null)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)
    expect(t.logs).toHaveLength(1)

    // Each failed check gets its own line.
    t.port.nextCheck = () => Promise.reject(failure)
    await t.clock.advance(RECHECK_MS)
    expect(t.logs).toHaveLength(2)
  })

  test('a failed download logs one line, and a check that throws or a bad updater never throws', async () => {
    const t = setup()
    const failure = new Error('net::ERR_CONNECTION_RESET at https://example.com/x.exe')
    t.port.nextCheck = () => {
      const download = Promise.reject(failure)
      return Promise.resolve({ downloadPromise: download })
    }
    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS)
    await t.error(failure)
    expect(t.logs).toHaveLength(1)
    expect(t.logs[0]).toContain('net::ERR_CONNECTION_RESET')
    expect(t.logs[0]).not.toContain('example.com')

    t.port.nextCheck = () => {
      throw new Error('sync https://example.com')
    }
    await t.clock.advance(RECHECK_MS)
    expect(t.logs).toHaveLength(2)
    expect(t.logs[1]).not.toContain('example.com')

    // No code and no safe name.
    t.port.nextCheck = () => Promise.reject('https://example.com')
    await t.clock.advance(RECHECK_MS)
    expect(t.logs).toHaveLength(3)
    expect(t.logs[2]).not.toContain('example.com')

    const bad = setup({ updaterThrows: true })
    expect(() => bad.flow.start()).not.toThrow()
    await bad.clock.advance(RECHECK_MS * 2)
    expect(bad.logs).toHaveLength(1)
    expect(bad.logs[0]).not.toContain('example.com')
    expect(bad.checks()).toBe(0)
  })

  test('when it asks', async () => {
    const t = setup()
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])
    expect(t.logs.join('\n')).toContain('1.0.1')

    // The same version again: the Later of this app run holds.
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])

    await t.download('1.0.2')
    expect(t.events).toEqual(['ask 1.0.1', 'ask 1.0.2'])
  })

  test('an open box blocks a second, and the blocked version asks later', async () => {
    const box = deferred<Answer>()
    const asked: string[] = []
    const t = setup({
      ask: (version) => {
        asked.push(version)
        return box.promise
      },
    })
    t.flow.start()
    await t.download('1.0.1')
    await t.download('1.0.2')
    expect(asked).toEqual(['1.0.1'])

    // A check while the box is open could swap the file the box names.
    await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS)
    expect(t.checks()).toBe(0)

    box.resolve('later')
    await settle()
    await t.download('1.0.2')
    expect(asked).toEqual(['1.0.1', '1.0.2'])
  })

  test('no box opens once a quit has begun, and no check runs', async () => {
    const t = setup()
    t.flow.start()
    t.beginQuit()
    await t.download('1.0.1')
    await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS)
    expect(t.events).toEqual([])
  })

  test('an answer after a quit began installs nothing', async () => {
    const box = deferred<Answer>()
    const t = setup({ ask: () => box.promise })
    t.flow.start()
    await t.download('1.0.1')
    t.beginQuit()
    box.resolve('restart')
    await settle()
    expect(t.events).toEqual([])
  })

  test('later installs nothing', async () => {
    const t = setup()
    t.answers.push('later')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])

    // A box that fails counts as Later.
    const broken = setup({ ask: () => Promise.reject(new Error('https://example.com')) })
    broken.flow.start()
    await broken.download('1.0.1')
    expect(broken.events).toEqual([])
    expect(broken.logs.join()).not.toContain('example.com')
  })

  test.each(['stopped', 'killed', 'not running'])('restart stops first (%s)', async (result) => {
    const stop = deferred<string>()
    const t = setup({ stop: () => stop.promise })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])
    stop.resolve(result)
    await settle()
    expect(t.events).toEqual(['ask 1.0.1', 'install'])
    expect(t.events).not.toContain('quit')
  })

  test('restart stops first, and a stop that throws goes on', async () => {
    const t = setup({ stop: () => Promise.reject(new Error('gone')) })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1', 'install'])
  })

  test('a restart in progress starts no check and opens no box', async () => {
    const stop = deferred<string>()
    const t = setup({ stop: () => stop.promise })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS * 2)
    await t.download('1.0.2')
    expect(t.events).toEqual(['ask 1.0.1'])
  })

  test('a failed install quits', async () => {
    const t = setup()
    t.answers.push('restart')
    t.port.installImpl = () => {
      throw Object.assign(new Error('spawn https://example.com'), { code: 'EACCES' })
    }
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install', 'quit'])
    expect(t.logs.join()).toContain('EACCES')
    expect(t.logs.join()).not.toContain('example.com')
  })

  // quitAndInstall catches its own failure: it emits `error`, returns, and doesn't quit, and the server has gone by then.
  test('an install that fails with an error event also quits, once', async () => {
    const t = setup()
    t.answers.push('restart')
    t.port.installImpl = () => void t.error(new Error('No update filepath provided'))
    t.flow.start()
    await t.download('1.0.1')
    await t.error(new Error('again'))
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install', 'quit'])
    expect(t.logs.filter((l) => l.includes('install failed'))).toHaveLength(1)
  })

  test('an error during the stop only logs: the install still goes on', async () => {
    const stop = deferred<string>()
    const t = setup({ stop: () => stop.promise })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    await t.error(new Error('late check failure'))
    expect(t.events).toEqual(['ask 1.0.1'])
    stop.resolve('stopped')
    await settle()
    expect(t.events).toEqual(['ask 1.0.1', 'install'])
  })

  describe('last chance, after the server failed', () => {
    /** Tracks whether lastChance resolved. */
    const watch = (p: Promise<void>) => {
      const s = { done: false }
      void p.then(() => (s.done = true))
      return s
    }

    test('checks at once, before the first timed check, and resolves when no update comes', async () => {
      const t = setup()
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.checks()).toBe(1)
      expect(s.done).toBe(true)
      expect(t.events).not.toContain('quit')
    })

    test('an update found asks, and Restart now installs and never resolves', async () => {
      const t = setup()
      t.answers.push('restart')
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.events).toEqual(['check', 'ask 1.0.1', 'stop', 'install'])
      await t.clock.advance(LAST_CHANCE_MS)
      expect(s.done).toBe(false)
    })

    test('Later resolves', async () => {
      const t = setup()
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.events).toEqual(['check', 'ask 1.0.1'])
      await settle()
      expect(s.done).toBe(true)
    })

    test('a failed check resolves', async () => {
      const t = setup()
      t.port.nextCheck = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(s.done).toBe(true)
    })

    test('waits for a check that runs now and for an open box', async () => {
      const download = deferred()
      const box = deferred<Answer>()
      const t = setup({ ask: () => box.promise })
      t.port.nextCheck = () => Promise.resolve({ downloadPromise: download.promise })
      t.flow.start()
      await t.clock.advance(FIRST_CHECK_MS)
      const s = watch(t.flow.lastChance())
      await settle()
      // One check: the one that runs now.
      expect(t.checks()).toBe(1)
      expect(s.done).toBe(false)
      await t.download('1.0.1')
      download.resolve()
      await settle()
      expect(s.done).toBe(false)
      box.resolve('later')
      await settle()
      expect(s.done).toBe(true)
    })

    test('a download that hangs resolves after the limit', async () => {
      const t = setup()
      t.port.nextCheck = () => Promise.resolve({ downloadPromise: new Promise(() => {}) })
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await t.clock.advance(LAST_CHANCE_MS - 1)
      expect(s.done).toBe(false)
      await t.clock.advance(1)
      expect(s.done).toBe(true)
      expect(t.logs.at(-1)).toContain('no update in time')
    })

    test('an unpackaged app, or an updater that failed to start, resolves at once', async () => {
      for (const t of [setup({ packaged: false }), setup({ updaterThrows: true })]) {
        t.flow.start()
        const s = watch(t.flow.lastChance())
        await settle()
        expect(s.done).toBe(true)
        expect(t.checks()).toBe(0)
      }
    })
  })
})
