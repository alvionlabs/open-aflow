import { EventEmitter } from 'node:events'
import { cpSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Board } from '@pod-board/model'
import type { FSWatcher } from 'chokidar'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createBoardService, type BoardService } from './board-service.ts'
import type { GhReader } from './gh.ts'
import { createBoardWatcher, DEBOUNCE_MS, MAX_WAIT_MS, type BoardWatcher } from './watcher.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'model', 'fixtures', 'chess-web')

let root: string
let configFile: string
let portsDir: string
let claudeDir: string
let watcher: BoardWatcher | undefined

const gh: GhReader = {
  status: () => 'unknown',
  checkedAt: () => undefined,
  get: () => undefined,
  getBranch: () => undefined,
  refresh: async () => false,
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pod-board-a1-watch-'))
  configFile = join(root, 'config', 'config.json')
  portsDir = join(root, 'ports')
  claudeDir = join(root, 'claude')
  await mkdir(portsDir)
})

afterEach(async () => {
  vi.useRealTimers()
  await watcher?.close()
  watcher = undefined
  await rm(root, { recursive: true, force: true })
})

function copyFixture(name: string): string {
  const repo = join(root, 'repos', name)
  cpSync(FIXTURE, repo, { recursive: true })
  return repo
}

async function register(...paths: string[]): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, JSON.stringify({ version: 1, repos: paths.map((path) => ({ path })) }))
}

function service(): BoardService {
  return createBoardService({ configFile, portsDir, claudeDir, transcriptDays: 30, platform: process.platform, gh })
}

/** Collects every board event, with a way to wait for the next one that passes `test`. */
function collect(w: BoardWatcher) {
  const events: Board[] = []
  const waiters: { test: (b: Board) => boolean; resolve: (b: Board) => void }[] = []
  w.subscribe((b) => {
    events.push(b)
    for (const waiter of [...waiters]) {
      if (waiter.test(b)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(b)
      }
    }
  })
  const next = (test: (b: Board) => boolean = () => true, ms = EVENT_MS) =>
    new Promise<Board>((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = events.map((b) => t1Status(b) ?? '-').join(', ')
        reject(new Error(`no matching board event within ${ms} ms (${events.length} events so far, T1: ${seen || 'none'})`))
      }, ms)
      waiters.push({
        test,
        resolve: (b) => {
          clearTimeout(timer)
          resolve(b)
        },
      })
    })
  return { events, next }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** How long a test waits for an event: it ends as soon as the event comes, so this bound only catches a lost one. */
const EVENT_MS = 20_000

/** Waits until `check` holds, for a test whose count depends on real timers. */
async function until(check: () => boolean, ms = EVENT_MS) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(25)
  }
}

/** One temp-folder cycle, in ms: about 6 on a free disk, and hundreds while other work competes for it. */
async function diskCycleMs(): Promise<number> {
  const started = performance.now()
  const dir = await mkdtemp(join(tmpdir(), 'pod-board-a1-probe-'))
  for (let i = 0; i < 5; i++) await writeFile(join(dir, `${i}.md`), 'x'.repeat(2000))
  for (let i = 0; i < 5; i++) await readFile(join(dir, `${i}.md`))
  await rm(dir, { recursive: true, force: true })
  return performance.now() - started
}

/** Times temp-folder cycles from now on, because a disk is busy in bursts. `worst` stops and gives the slowest. */
function sampleDisk() {
  let stop = false
  let worst = 0
  const loop = (async () => {
    while (!stop) {
      worst = Math.max(worst, await diskCycleMs())
      await sleep(100)
    }
  })()
  return {
    worst: async () => {
      stop = true
      await loop
      return worst
    },
  }
}

/**
 * Starts the clock for the 5 s promise, which holds on a free disk. Past 5 s the test fails unless the disk was busy
 * during the wait: a rebuild is file reads, so a busy disk delays it with no fault of the watcher's.
 */
function promiseClock() {
  const started = Date.now()
  const disk = sampleDisk()
  return async () => {
    const took = Date.now() - started
    const worst = await disk.worst()
    if (took >= 5000) expect(worst, `took ${took} ms with the disk free (slowest temp cycle ${Math.round(worst)} ms)`).toBeGreaterThan(100)
  }
}

// Real timers, kept before any test fakes them, so the watcher's real `stat` calls can finish between fake steps.
const realSetTimeout = globalThis.setTimeout
const realYield = () => new Promise((r) => realSetTimeout(r, 2))

/**
 * Moves fake time forward in `step` ms steps, giving real I/O a turn after each. Each turn waits
 * a real timer, which Windows rounds up to about 15 ms, so setup that measures nothing takes bigger steps.
 */
async function advance(ms: number, step = 50) {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left))
    await realYield()
  }
}

/** One folder watch that emits only what a test tells it to. */
function fakeWatches() {
  const fakes: EventEmitter[] = []
  const watch = () => {
    const w = Object.assign(new EventEmitter(), { close: async () => {} })
    fakes.push(w)
    process.nextTick(() => w.emit('ready'))
    return w as unknown as FSWatcher
  }
  return { fakes, watch }
}

/**
 * Wraps a service to note when each build starts, so a test can wait until the
 * watcher has gone `ms` without starting one. In poll mode a write can be seen
 * up to one poll interval late, and its rebuild follows a debounce after that.
 */
function tracked(s: BoardService) {
  let last = Date.now()
  const svc: BoardService = {
    build: () => {
      last = Date.now()
      return s.build()
    },
    refreshGh: s.refreshGh,
  }
  const quiet = async (ms: number) => {
    while (Date.now() - last < ms) await sleep(ms - (Date.now() - last))
  }
  return { service: svc, quiet }
}

const t1Status = (b: Board) =>
  b.repos[0]?.model.plans
    .find((p) => p.slug === 'sparring-ladder')
    ?.sprints.find((s) => s.slug === 'ladder')
    ?.waves.flatMap((w) => w.slices)
    .find((s) => s.code === 'T1')?.status

async function setT1(repo: string, status: string): Promise<void> {
  const file = join(repo, 'pod-docs', 'sprints', 'ladder.md')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace(/(\| 3 \| T1 \|[^\n]*\| — \| )[a-z-]+( \|)/, `$1${status}$2`))
}

describe('board watcher', () => {
  for (const poll of [false, true]) {
    test(`changes reach clients within 5 seconds${poll ? ' (polling)' : ''}`, async () => {
      const repo = copyFixture('chess-web')
      await register(repo)
      const { service: svc, quiet } = tracked(service())
      watcher = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir, poll })
      const first = await watcher.start()
      expect(t1Status(first)).toBe('pending')
      const { next } = collect(watcher)
      // Let the start-up rebuilds finish, so the edit below can reach clients only through the watcher.
      await quiet(poll ? 1500 : 800)

      // A burst of edits is pinned in 'a burst of real edits', with fake time, so a runner stall can't split it.
      const clock = promiseClock()
      await setT1(repo, 'pushed')
      const got = await next((b) => t1Status(b) === 'pushed')
      await clock()
      expect(watcher.board()).toBe(got)
    }, 60_000) // Its waits add up: start-up, the quiet time, and EVENT_MS.
  }

  // Polling is the same chokidar option on every watch, so the polling test above covers it here too.
  test('a config edit reaches clients within 5 seconds', async () => {
    const repo = copyFixture('chess-web')
    await register(repo)
    const { service: svc, quiet } = tracked(service())
    watcher = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir })
    const first = await watcher.start()
    expect(first.configError).toBeUndefined()
    const { next } = collect(watcher)
    // Let the start-up rebuilds finish, so only the watcher can see the edits below.
    await quiet(800)

    let clock = promiseClock()
    await writeFile(configFile, '{ not json')
    const broken = await next((b) => b.configError === 'config unreadable')
    await clock()
    expect(broken.repos).toHaveLength(1)

    await quiet(800)
    clock = promiseClock()
    await register(repo)
    await next((b) => b.configError === undefined)
    await clock()
  }, 60_000)

  test('in poll mode, events up to one poll interval apart give one rebuild', async () => {
    vi.useFakeTimers()
    const { fakes, watch: fakeWatch } = fakeWatches()
    let builds = 0
    const svc: BoardService = {
      build: async () => {
        builds++
        return { generatedAt: Date.now(), gh: 'unknown', repos: [] }
      },
      refreshGh: async () => false,
    }
    watcher = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir, poll: true, watch: fakeWatch, tickMs: 1e9 })
    const w = watcher
    // Fires every timer due within 5 s, then waits out the rebuilds they queued
    // (each reads real folders), plus one more, counted below.
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(5000)
      await w.rebuild()
    }
    await w.start()
    await settle()
    expect(fakes.length).toBeGreaterThan(0)
    const before = builds

    // A poller sees a quick burst of writes on up to two ticks, one poll interval apart.
    fakes[0]!.emit('all', 'change', configFile)
    await vi.advanceTimersByTimeAsync(450)
    fakes[0]!.emit('all', 'change', configFile)
    await settle()
    expect(builds - before - 1).toBe(1)
  })

  describe('steady events still rebuild within the cap', () => {
    /** A watcher over fake folder watches and a fake service that notes the fake time of each build. */
    async function fakeWatcher(poll: boolean, build?: () => Promise<void>) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const { fakes, watch: fakeWatch } = fakeWatches()
      const builds: number[] = []
      const svc: BoardService = {
        build: async () => {
          builds.push(Date.now())
          await build?.()
          return { generatedAt: Date.now(), gh: 'unknown', repos: [] }
        },
        refreshGh: async () => false,
      }
      const w = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir, poll, watch: fakeWatch, tickMs: 1e9 })
      watcher = w
      await w.start()
      // Lets the start-up rebuilds run and finish.
      await advance(5000, 500)
      expect(fakes.length).toBeGreaterThan(0)
      builds.length = 0
      return { fakes, builds, emit: () => fakes[0]!.emit('all', 'change', configFile) }
    }

    /** Emits an event every `every` ms for `forMs` ms; returns the fake time of the first one. */
    async function stream(emit: () => void, every: number, forMs: number): Promise<number> {
      const first = Date.now()
      for (let t = 0; t < forMs; t += every) {
        emit()
        await advance(every)
      }
      return first
    }

    for (const [poll, every] of [
      [true, 400],
      [false, 150],
    ] as const) {
      test(`events every ${every} ms for 6 s${poll ? ' (polling)' : ''} rebuild every ${MAX_WAIT_MS} ms at most`, async () => {
        const { builds, emit } = await fakeWatcher(poll)
        const first = await stream(emit, every, 6000)
        // During the 6 s: a rebuild no later than the cap after the first event, then again and again.
        const during = builds.filter((t) => t < first + 6000)
        expect(during.length).toBeGreaterThanOrEqual(3)
        expect(during[0]! - first).toBeLessThanOrEqual(MAX_WAIT_MS)
        // After a rebuild, the next event starts a new burst, so gaps stay within the cap plus one event gap.
        for (let i = 1; i < during.length; i++) expect(during[i]! - during[i - 1]!).toBeLessThanOrEqual(MAX_WAIT_MS + every)
      }, 30_000)
    }

    test('the cap counts from the first event, not the last', async () => {
      const { builds, emit } = await fakeWatcher(false)
      // Events 250 ms apart, the last at 1400 ms: the quiet spell alone would rebuild at 1700 ms.
      const first = Date.now()
      for (const at of [0, 250, 500, 750, 1000, 1250, 1400]) {
        await advance(at - (Date.now() - first))
        emit()
      }
      await advance(50)
      expect(builds).toEqual([])
      await advance(1000)
      expect(builds).toHaveLength(1)
      expect(builds[0]! - first).toBeLessThanOrEqual(MAX_WAIT_MS)
    }, 30_000)

    test('a quick burst still gives exactly one rebuild', async () => {
      const { builds, emit } = await fakeWatcher(false)
      emit()
      await advance(100)
      emit()
      await advance(100)
      emit()
      await advance(5000)
      expect(builds).toHaveLength(1)
    }, 30_000)

    test('an event during a rebuild gets its own rebuild within the cap', async () => {
      let release: (() => void) | undefined
      let hold = false
      const { builds, emit } = await fakeWatcher(false, () => (hold ? new Promise<void>((r) => (release = r)) : Promise.resolve()))
      hold = true
      emit()
      await advance(400)
      expect(builds).toHaveLength(1)
      // The first rebuild is still running when this event comes in.
      const late = Date.now()
      emit()
      await advance(200)
      hold = false
      release!()
      await advance(MAX_WAIT_MS)
      expect(builds).toHaveLength(2)
      expect(builds[1]! - late).toBeLessThanOrEqual(MAX_WAIT_MS)
    }, 30_000)
  })

  // Real files and the real service, but a fake watch and fake timers, so the
  // test sets when the watcher hears of each write. A real-file test can't:
  // a runner stall between two writes splits them into two correct boards.
  describe('a burst of real edits', () => {
    async function editWatcher(poll: boolean) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const repo = copyFixture('chess-web')
      await register(repo)
      const { fakes, watch: fakeWatch } = fakeWatches()
      // Counts builds still reading, so a test can let one finish before its next write.
      const real = service()
      let reading = 0
      const svc: BoardService = {
        build: async () => {
          reading++
          try {
            return await real.build()
          } finally {
            reading--
          }
        },
        refreshGh: real.refreshGh,
      }
      const w = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir, poll, watch: fakeWatch, tickMs: 1e9 })
      watcher = w
      const first = await w.start()
      expect(t1Status(first)).toBe('pending')
      // Lets the start-up rebuilds run, then waits for the last one to finish.
      await advance(5000, 500)
      await w.rebuild()
      expect(fakes.length).toBeGreaterThan(0)
      const { events } = collect(w)
      /** Moves fake time forward, then lets any rebuild it started finish reading. */
      const wait = async (ms: number) => {
        await advance(ms)
        while (reading > 0) await realYield()
      }
      /** Writes T1's status for real, then tells the watcher. */
      const edit = async (status: string) => {
        await setT1(repo, status)
        fakes[0]!.emit('all', 'change', join(repo, 'pod-docs', 'sprints', 'ladder.md'))
      }
      /** Fires every timer still due, then waits out the rebuilds they queued. A rebuild that finds nothing new sends nothing. */
      const settle = async () => {
        await advance(MAX_WAIT_MS + 1000)
        await w.rebuild()
      }
      return { w, events, edit, wait, settle }
    }

    for (const [poll, gap] of [
      [false, 100],
      // A poller sees a quick burst on up to two ticks, one poll interval apart.
      [true, 450],
    ] as const) {
      test(`quick edits give one board, carrying the last${poll ? ' (polling)' : ''}`, async () => {
        const { w, events, edit, wait, settle } = await editWatcher(poll)
        await edit('blocked')
        await wait(gap)
        await edit('pending')
        await wait(gap)
        await edit('done')
        await settle()
        expect(events.map(t1Status)).toEqual(['done'])
        expect(w.board()).toBe(events[0])
      }, 30_000)
    }

    test('edits farther apart than the quiet spell give one board each', async () => {
      const { events, edit, wait, settle } = await editWatcher(false)
      await edit('blocked')
      // The quiet spell ends and its rebuild runs before the next write.
      await wait(DEBOUNCE_MS + 50)
      await edit('pending')
      await edit('done')
      await settle()
      expect(events.map(t1Status)).toEqual(['blocked', 'done'])
    }, 30_000)
  })

  test('while gh is not ok, each new gh check time reaches clients', async () => {
    let checks = 0
    const loggedOut: GhReader = { ...gh, status: () => 'logged-out', checkedAt: () => ++checks }
    const svc = createBoardService({ configFile, portsDir, claudeDir, transcriptDays: 30, platform: process.platform, gh: loggedOut })
    watcher = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir, tickMs: 100 })
    await watcher.start()
    const { events } = collect(watcher)
    await until(() => events.length >= 2)
    const times = events.map((b) => b.ghCheckedAt!)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(times).size).toBe(times.length)
    expect(watcher.board().ghCheckedAt).toBe(times.at(-1))
  })

  test('while gh is ok, a new gh check time alone sends nothing', async () => {
    let checks = 0
    const healthy: GhReader = { ...gh, status: () => 'ok', checkedAt: () => ++checks }
    const svc = createBoardService({ configFile, portsDir, claudeDir, transcriptDays: 30, platform: process.platform, gh: healthy })
    watcher = createBoardWatcher({ service: svc, configFile, portsDir, claudeDir, tickMs: 100 })
    await watcher.start()
    const { events } = collect(watcher)
    await sleep(600)
    expect(events).toEqual([])
  })

  test('emits only on change', async () => {
    const repo = copyFixture('chess-web')
    await register(repo)
    watcher = createBoardWatcher({ service: service(), configFile, portsDir, claudeDir })
    await watcher.start()
    const { events, next } = collect(watcher)

    // A rebuild that gives the same board (generatedAt aside) sends nothing.
    await watcher.rebuild()
    await watcher.rebuild()
    // A write that leaves the docs as they were sends nothing either.
    const file = join(repo, 'pod-docs', 'sprints', 'ladder.md')
    await writeFile(file, await readFile(file, 'utf8'))
    await sleep(1000)
    expect(events).toEqual([])

    // A new claim file adds its repo, and the watch list follows it.
    const other = copyFixture('claimed')
    await writeFile(join(portsDir, '3200'), `${other} sparring-ladder\n`)
    const added = await next((b) => b.repos.length === 2)
    expect(added.repos.find((r) => r.name === 'claimed')?.source).toBe('claim')
    expect(events).toHaveLength(1)

    await sleep(500)
    await setT1(other, 'pushed')
    const edited = await next((b) => b.repos.find((r) => r.name === 'claimed') !== undefined)
    const claimed = edited.repos.find((r) => r.name === 'claimed')!
    expect(t1Status({ ...edited, repos: [claimed] })).toBe('pushed')
  })

  test('a repo folder made after start gets watched', async () => {
    const later = join(root, 'repos', 'later')
    await register(later)
    watcher = createBoardWatcher({ service: service(), configFile, portsDir, claudeDir })
    const first = await watcher.start()
    expect(first.repos[0]!.error).toBeTruthy()
    const { next } = collect(watcher)
    cpSync(FIXTURE, later, { recursive: true })
    const fixed = await next((b) => b.repos[0]?.error === undefined)
    expect(fixed.repos[0]!.model.docs.supported).toBe(true)
  })

  test('a failed rebuild keeps the last board and sends nothing', async () => {
    const real = service()
    let fail = false
    const flaky: BoardService = {
      build: () => (fail ? Promise.reject(new Error('boom')) : real.build()),
      refreshGh: real.refreshGh,
    }
    const errors: unknown[] = []
    watcher = createBoardWatcher({ service: flaky, configFile, portsDir, claudeDir, onError: (e) => errors.push(e) })
    const first = await watcher.start()
    const { events } = collect(watcher)
    fail = true
    await watcher.rebuild()
    expect(watcher.board()).toBe(first)
    expect(events).toEqual([])
    // The start-up gh tick may rebuild (and fail) too.
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.every((e) => e instanceof Error && e.message === 'boom')).toBe(true)
  })

  test('a watch that fails to open is logged, and later rebuilds still run', async () => {
    const a = copyFixture('a')
    const b = copyFixture('b')
    await register(a)
    const { watch: fakeWatch } = fakeWatches()
    let failOpen = false
    const watch = ((...args: Parameters<typeof fakeWatch>) => {
      if (failOpen) throw new Error('open failed')
      return fakeWatch(...args)
    }) as typeof fakeWatch
    const errors: unknown[] = []
    watcher = createBoardWatcher({ service: service(), configFile, portsDir, claudeDir, watch, tickMs: 1e9, onError: (e) => errors.push(e) })
    await watcher.start()
    failOpen = true
    await register(a, b)
    await expect(watcher.rebuild()).resolves.toBeUndefined()
    expect(errors.some((e) => e instanceof Error && e.message === 'open failed')).toBe(true)
    failOpen = false
    const { next } = collect(watcher)
    await setT1(a, 'blocked')
    // Waiting first: the event arrives during the rebuild.
    const event = next((b) => t1Status(b) === 'blocked')
    await watcher.rebuild()
    await event
  })

  test('the gh timer refreshes gh and rebuilds', async () => {
    const real = service()
    let refreshes = 0
    const counting: BoardService = {
      build: real.build,
      refreshGh: async (b) => {
        refreshes++
        return real.refreshGh(b)
      },
    }
    watcher = createBoardWatcher({ service: counting, configFile, portsDir, claudeDir, tickMs: 100 })
    await watcher.start()
    // One right after start, then one per tick.
    await until(() => refreshes >= 3)
  })
})
