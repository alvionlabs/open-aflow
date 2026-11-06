import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { startServer, type Production, type Started } from './start-server.ts'

// Pass-through spies: the real watcher and check run, and the tests see whether they started.
const spies = vi.hoisted(() => ({
  watcherStarts: 0,
  watcherCloses: 0,
  autoStarts: 0,
  watcherStartsAtFirstCheck: undefined as number | undefined,
}))

vi.mock('./watcher.ts', async (original) => {
  const real = await original<typeof import('./watcher.ts')>()
  return {
    ...real,
    createBoardWatcher: (o: Parameters<typeof real.createBoardWatcher>[0]) => {
      const w = real.createBoardWatcher(o)
      const { start, close } = w
      w.start = () => {
        spies.watcherStarts++
        return start()
      }
      w.close = () => {
        spies.watcherCloses++
        return close()
      }
      return w
    },
  }
})

vi.mock('./auto-continue.ts', async (original) => {
  const real = await original<typeof import('./auto-continue.ts')>()
  return {
    ...real,
    createAutoContinue: (...args: Parameters<typeof real.createAutoContinue>) => {
      const a = real.createAutoContinue(...args)
      const { start } = a
      a.start = () => {
        spies.autoStarts++
        start()
      }
      return a
    },
  }
})

vi.mock('./tool-finder.ts', async (original) => {
  const real = await original<typeof import('./tool-finder.ts')>()
  return {
    ...real,
    createToolFinder: (...args: Parameters<typeof real.createToolFinder>) => {
      const finder = real.createToolFinder(...args)
      const { check } = finder
      finder.check = () => {
        spies.watcherStartsAtFirstCheck ??= spies.watcherStarts
        return check()
      }
      return finder
    },
  }
})

const META = /<meta name="open-aflow-token" content="([^"]+)">/
const INDEX = '<!doctype html><html><head><title>Board</title></head><body>page body</body></html>'

let tmp: string
let cfg: string
let webDir: string
let logs: string[]
const running: Array<{ started: Started; exited: Promise<number> }> = []
const holders: Server[] = []

/** Removes a folder, trying again while Windows still holds it. */
const removeWithRetry = async (path: string) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 40 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** Binds a port on 127.0.0.1 and keeps it until teardown. Port 0 asks the OS for one. */
const holdPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      holders.push(server)
      resolve((server.address() as { port: number }).port)
    })
  })

const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** Asks the OS for a free port and gives it back. */
const freePort = async (): Promise<number> => {
  const port = await holdPort()
  await closeServer(holders.pop()!)
  return port
}

/** A real request, so the `Host` header is the test's own. */
const send = (
  port: number,
  path: string,
  o: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: o.method ?? 'GET',
        agent: false,
        headers: { Host: o.host ?? `127.0.0.1:${port}`, ...o.headers },
      },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += String(d)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.once('error', reject)
    req.end(o.body)
  })

/** Temp folders for everything the server reads and writes. Never the real config or claims. */
const envFor = (over: Record<string, string> = {}): Record<string, string> => ({
  OPEN_AFLOW_CONFIG_DIR: cfg,
  OPEN_AFLOW_PORTS_DIR: join(tmp, 'ports'),
  OPEN_AFLOW_CLAUDE_DIR: join(tmp, 'claude'),
  OPEN_AFLOW_CLAUDE_BIN: join(tmp, 'missing', 'claude'),
  ...over,
})

/** Starts a server with a fake exit, and keeps it for teardown. */
const start = async (env: Record<string, string>, production?: Production) => {
  let exit = (_code: number) => {}
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const started = await startServer(env, { exit: (code) => exit(code), ...(production ? { production } : {}) })
  const entry = { started, exited }
  running.push(entry)
  return entry
}

/** A production server on a port the test owns. */
const startProduction = async (over: Record<string, string> = {}) => {
  const port = await freePort()
  return start(envFor({ OPEN_AFLOW_API_PORT: String(port), ...over }), { webDir })
}

const pageToken = async (port: number): Promise<string> => {
  const { status, text } = await send(port, '/')
  expect(status).toBe(200)
  const token = META.exec(text)?.[1]
  expect(token).toBeTruthy()
  return token!
}

const mergePreview = (port: number, token?: string) =>
  send(port, '/api/actions/merge-preview', {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      ...(token ? { 'X-Open-AFlow-Token': token } : {}),
    },
    body: JSON.stringify({ repoId: 'x', number: 1 }),
  })

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'open-aflow-start-')))
  cfg = join(tmp, 'cfg')
  webDir = join(tmp, 'web')
  await mkdir(webDir)
  await writeFile(join(webDir, 'index.html'), INDEX)
  logs = []
  const keep = (...args: unknown[]) => void logs.push(args.join(' '))
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  spies.watcherStarts = 0
  spies.watcherCloses = 0
  spies.autoStarts = 0
  spies.watcherStartsAtFirstCheck = undefined
})

afterEach(async () => {
  for (const { started, exited } of running.splice(0)) {
    started.stop()
    await exited
  }
  await Promise.all(holders.splice(0).map(closeServer))
  vi.restoreAllMocks()
  await removeWithRetry(tmp)
})

describe('dev', () => {
  test('dev keeps the token file and both ports', async () => {
    const api = await freePort()
    const web = await freePort()
    const { started } = await start(envFor({ OPEN_AFLOW_API_PORT: String(api), OPEN_AFLOW_WEB_PORT: String(web) }))
    expect(started.port).toBe(api)

    const token = (await readFile(join(cfg, 'session-token'), 'utf8')).trim()
    expect(token).toHaveLength(43)

    expect((await send(api, '/api/health')).status).toBe(200)
    expect((await send(api, '/api/health', { host: `127.0.0.1:${web}` })).status).toBe(200)
    expect((await send(api, '/api/health', { host: 'localhost:1' })).status).toBe(403)
    // The dev API serves no page.
    expect((await send(api, '/')).status).toBe(404)

    expect(logs).toContain(`open-aflow API listening on http://127.0.0.1:${api}`)
    expect(logs.join('\n')).not.toContain(token)
  })

  test('dev defaults its web port to 3001', async () => {
    const api = await freePort()
    await start(envFor({ OPEN_AFLOW_API_PORT: String(api) }))
    expect((await send(api, '/api/health', { host: '127.0.0.1:3001' })).status).toBe(200)
  })

  test('a bad setting rejects, naming the variable', async () => {
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: 'abc' }))).rejects.toThrow(/OPEN_AFLOW_API_PORT/)
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(await freePort()), OPEN_AFLOW_WEB_PORT: 'abc' }))).rejects.toThrow(/OPEN_AFLOW_WEB_PORT/)
    expect(spies.watcherStarts).toBe(0)
  })

  test('a failed token write rejects before anything watches', async () => {
    await writeFile(cfg, 'a file, not a folder')
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(await freePort()) }))).rejects.toThrow(/session token file/)
    expect(spies.watcherStarts).toBe(0)
  })

  test('a busy API port rejects, sends nothing, and closes the watcher', async () => {
    const busy = await holdPort()
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(busy) }))).rejects.toThrow(new RegExp(`OPEN_AFLOW_API_PORT.*${busy}`))
    expect(spies.watcherCloses).toBe(spies.watcherStarts)
    expect(spies.autoStarts).toBe(0)
  })
})

describe('production', () => {
  test('tool routes are production only', async () => {
    const { started } = await startProduction()
    const token = await pageToken(started.port)
    const headers = { 'X-Open-AFlow-Token': token }
    const res = await send(started.port, '/api/tools', { headers })
    expect(res.status).toBe(200)
    expect((JSON.parse(res.text) as { tools: { tool: string }[] }).tools.map((t) => t.tool)).toEqual(['git', 'gh', 'claude'])
    expect((await send(started.port, '/api/tools')).status).toBe(403)
    // The first check ran before the watcher started.
    expect(spies.watcherStartsAtFirstCheck).toBe(0)

    const saved = await send(started.port, '/api/actions/tool-path', {
      method: 'POST',
      headers: { ...headers, Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'gh', path: null }),
    })
    expect(saved.status).toBe(200)
    expect(existsSync(join(cfg, 'tool-paths.json'))).toBe(true)

    // Dev has neither route, even with the right token, and it writes no file.
    const devCfg = join(tmp, 'dev-cfg')
    const apiPort = await freePort()
    const dev = await start(envFor({ OPEN_AFLOW_CONFIG_DIR: devCfg, OPEN_AFLOW_API_PORT: String(apiPort), OPEN_AFLOW_WEB_PORT: String(await freePort()) }))
    const devToken = (await readFile(join(devCfg, 'session-token'), 'utf8')).trim()
    const devHeaders = { 'X-Open-AFlow-Token': devToken }
    expect((await send(dev.started.port, '/api/tools', { headers: devHeaders })).status).toBe(404)
    const devSave = await send(dev.started.port, '/api/actions/tool-path', {
      method: 'POST',
      headers: { ...devHeaders, Origin: `http://127.0.0.1:${apiPort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'gh', path: null }),
    })
    expect(devSave.status).toBe(404)
    expect(existsSync(join(devCfg, 'tool-paths.json'))).toBe(false)
  })

  test('production never touches the token file', async () => {
    // With no file, none appears.
    const first = await startProduction()
    await pageToken(first.started.port)
    expect(existsSync(join(cfg, 'session-token'))).toBe(false)
    expect((await readdir(cfg)).filter((f) => f.startsWith('session-token'))).toEqual([])
    first.started.stop()
    await first.exited
    running.splice(0)

    // An existing file stays byte for byte, and its mtime stays too.
    const bytes = 'token-of-a-dev-page\r\n'
    const file = join(cfg, 'session-token')
    await writeFile(file, bytes)
    const before = await stat(file)
    const second = await startProduction()
    const token = await pageToken(second.started.port)
    expect(token).not.toBe(bytes.trim())
    expect(await readFile(file, 'utf8')).toBe(bytes)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    expect(logs.join('\n')).not.toContain(token)
  })

  test('production makes the config folder', async () => {
    const nested = join(tmp, 'deep', 'er', 'cfg')
    const { started } = await startProduction({ OPEN_AFLOW_CONFIG_DIR: nested })
    expect((await stat(nested)).isDirectory()).toBe(true)
    expect((await send(started.port, '/api/board')).status).toBe(200)
  })

  test('production stops, naming the folder, when it cannot make the config folder', async () => {
    await writeFile(cfg, 'a file, not a folder')
    const port = await freePort()
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(port) }), { webDir })).rejects.toThrow(cfg)
    expect(spies.watcherStarts).toBe(0)
    expect(logs.join('\n')).not.toContain('listening')
  })

  test("the page's token works for actions", async () => {
    const { started } = await startProduction()
    const token = await pageToken(started.port)

    const ok = await mergePreview(started.port, token)
    expect(ok.status).toBe(404)
    expect(JSON.parse(ok.text)).toEqual({ error: 'not waiting on you' })

    const none = await mergePreview(started.port)
    expect(none.status).toBe(403)
    expect(JSON.parse(none.text)).toEqual({ error: 'bad token' })

    const wrong = await mergePreview(started.port, 'x'.repeat(43))
    expect(wrong.status).toBe(403)
  })

  test('a new token per start', async () => {
    const one = await startProduction()
    const first = await pageToken(one.started.port)
    expect(await pageToken(one.started.port)).toBe(first)

    const two = await startProduction()
    const second = await pageToken(two.started.port)
    expect(second).not.toBe(first)
    // Each server takes only its own.
    expect((await mergePreview(two.started.port, first)).status).toBe(403)
  })

  test('production ignores the web port', async () => {
    const web = await freePort()
    const good = await startProduction({ OPEN_AFLOW_WEB_PORT: String(web) })
    expect((await send(good.started.port, '/')).status).toBe(200)
    const refused = await send(good.started.port, '/', { host: `127.0.0.1:${web}` })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.text)).toEqual({ error: 'forbidden host' })
    // The default dev web port is no exception.
    expect((await send(good.started.port, '/', { host: '127.0.0.1:3001' })).status).toBe(403)

    const bad = await startProduction({ OPEN_AFLOW_WEB_PORT: 'not a port' })
    expect((await send(bad.started.port, '/')).status).toBe(200)
  })

  test('the Host check uses the real port', async () => {
    const busy = await holdPort()
    const { started } = await start(envFor(), { webDir, preferredPort: busy })
    expect(started.port).not.toBe(busy)
    expect(started.port).toBeGreaterThan(0)

    expect((await send(started.port, '/')).status).toBe(200)
    const atPreferred = await send(started.port, '/', { host: `127.0.0.1:${busy}` })
    expect(atPreferred.status).toBe(403)
    expect(atPreferred.text).not.toMatch(META)

    expect(logs).toContain(`open-aflow: port ${busy} is busy; using ${started.port} for this launch`)
    expect(logs).toContain(`open-aflow API listening on http://127.0.0.1:${started.port}`)
  })

  test('a free preferred port is used, with no busy line', async () => {
    const port = await freePort()
    const { started } = await start(envFor(), { webDir, preferredPort: port })
    expect(started.port).toBe(port)
    expect(logs.join('\n')).not.toContain('is busy')
    expect(logs).toContain(`open-aflow API listening on http://127.0.0.1:${port}`)
  })

  test('an empty OPEN_AFLOW_API_PORT counts as unset', async () => {
    const port = await freePort()
    const { started } = await start(envFor({ OPEN_AFLOW_API_PORT: '' }), { webDir, preferredPort: port })
    expect(started.port).toBe(port)
  })

  test('an explicit busy port stops the start', async () => {
    const busy = await holdPort()
    const preferred = await freePort()
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(busy) }), { webDir, preferredPort: preferred })).rejects.toThrow(
      new RegExp(`OPEN_AFLOW_API_PORT.*${busy}`),
    )
    expect(logs.join('\n')).not.toContain('listening')
    expect(spies.watcherCloses).toBe(spies.watcherStarts)
    expect(spies.autoStarts).toBe(0)
  })

  test('a bad OPEN_AFLOW_API_PORT stops the start', async () => {
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: 'abc' }), { webDir })).rejects.toThrow(/OPEN_AFLOW_API_PORT/)
    expect(spies.watcherStarts).toBe(0)
  })

  test('a bad web folder stops the start', async () => {
    const missing = join(tmp, 'no-web')
    const port = await freePort()
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(port) }), { webDir: missing })).rejects.toThrow(missing)

    expect(spies.watcherStarts).toBe(0)
    expect(spies.autoStarts).toBe(0)
    expect(logs.join('\n')).not.toContain('listening')
    // Nothing took the port.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  })

  test('the web app answers with the API on one port', async () => {
    const { started } = await startProduction()
    expect(JSON.parse((await send(started.port, '/api/health')).text)).toEqual({ ok: true })
    expect((await send(started.port, '/some/page')).text).toContain('page body')
    expect((await send(started.port, '/sw.js')).status).toBe(404)
    expect(JSON.parse((await send(started.port, '/api/nope')).text)).toEqual({ error: 'not found' })
  })
})

describe('the owner file', () => {
  const ownerFile = () => join(cfg, 'auto-continue-owner.json')

  test('a failed start holds nothing', async () => {
    const busy = await holdPort()
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(busy) }))).rejects.toThrow(/OPEN_AFLOW_API_PORT/)
    expect(existsSync(ownerFile())).toBe(false)
    await expect(start(envFor({ OPEN_AFLOW_API_PORT: String(busy) }), { webDir })).rejects.toThrow(/OPEN_AFLOW_API_PORT/)
    expect(existsSync(ownerFile())).toBe(false)
    expect(spies.autoStarts).toBe(0)
  })

  test('both modes use the owner file', async () => {
    // Dev first: it takes the file and starts the check.
    const dev = await start(envFor({ OPEN_AFLOW_API_PORT: String(await freePort()), OPEN_AFLOW_WEB_PORT: String(await freePort()) }))
    const held = JSON.parse(await readFile(ownerFile(), 'utf8')) as { pid: number; id: string }
    expect(held.pid).toBe(process.pid)
    expect(spies.autoStarts).toBe(1)
    expect(logs.join('\n')).not.toContain('auto-continue')

    // Production on the same folder keeps serving, and starts no check.
    const prod = await startProduction()
    expect(spies.autoStarts).toBe(1)
    expect(JSON.parse(await readFile(ownerFile(), 'utf8'))).toEqual(expect.objectContaining({ id: held.id }))
    expect(logs.filter((l) => l.includes(String(process.pid)) && l.includes(cfg))).toHaveLength(1)
    expect((await send(prod.started.port, '/api/health')).status).toBe(200)

    // The second's stop leaves the first's file; the first's stop removes it.
    prod.started.stop()
    expect(await prod.exited).toBe(0)
    expect(existsSync(ownerFile())).toBe(true)
    dev.started.stop()
    expect(await dev.exited).toBe(0)
    expect(existsSync(ownerFile())).toBe(false)
    running.splice(0)

    // Production alone takes it too.
    const again = await startProduction()
    expect(existsSync(ownerFile())).toBe(true)
    expect(spies.autoStarts).toBe(2)
    again.started.stop()
    expect(await again.exited).toBe(0)
    expect(existsSync(ownerFile())).toBe(false)
    running.splice(0)
  })
})

describe('stop', () => {
  test('stop uses the shared shutdown', async () => {
    const entry = await startProduction()
    expect(spies.autoStarts).toBe(1)
    const { port } = entry.started
    entry.started.stop()
    expect(await entry.exited).toBe(0)
    expect(spies.watcherCloses).toBe(1)
    await expect(send(port, '/api/health')).rejects.toThrow()
  })
})
