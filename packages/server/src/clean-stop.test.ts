import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createAutoContinueStore } from './auto-continue-store.ts'
import { bundleApp } from './bundle-app.ts'
import { projectDirName } from './transcript-files.ts'

// The real bundle, with fake-claude.mjs behind OPENAFLOW_CLAUDE_BIN and temp folders for everything.
// Never a real claude, a real repo, or the real config. Each fake is killed in teardown by its recorded process ID.

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, '..', 'test', 'fake-claude.mjs')
const WIN = process.platform === 'win32'
const CASELESS = WIN || process.platform === 'darwin'
const RUN_MS = 90_000
const BOOT_MS = 30_000
const SESSION = 'sess-1'
const STOP = { type: 'openaflow:stop' }
const META = /<meta name="openaflow-token" content="([^"]+)"/
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const OWNER = 'auto-continue-owner.json'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const removeWithRetry = async (path: string) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 40 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await sleep(50)
    }
  }
}

const tempDir = (name: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `openaflow-${name}-`)))

const holdPort = (): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
const portOf = (server: Server) => (server.address() as { port: number }).port
const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))
const freePort = async () => {
  const server = await holdPort()
  const port = portOf(server)
  await closeServer(server)
  return port
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const killPid = (pid: number) => {
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
}

/** Polls until `ok` holds. On a timeout, throws with `what` and the extra text. */
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = BOOT_MS, extra: () => string = () => '') => {
  const end = Date.now() + ms
  for (;;) {
    if (await ok()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${extra()}`)
    await sleep(100)
  }
}

const exitOf = (c: ChildProcess): Promise<number | null> =>
  c.exitCode !== null || c.signalCode !== null ? Promise.resolve(c.exitCode) : new Promise((resolve) => c.once('exit', (code) => resolve(code)))

const plan = (rows: string[]) => ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', ...rows, ''].join('\n')
const sprint = (row: string) =>
  ['# Sprint: one', '', '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-11-01_', '', '## Status board', '', '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', '|---|---|---|---|---|---|---|---|', row, ''].join('\n')

/** An npm-style shim the runner reads and runs directly. */
const npmShim = (rel: string) => ['@ECHO off', 'SET dp0=%~dp0', `"%dp0%\\${rel}" %*`, ''].join('\r\n')

describe.runIf(WIN)('the bundle stops cleanly', () => {
  let built: string
  let root: string

  beforeAll(async () => {
    root = tempDir('clean-stop')
    const web = join(root, 'web-dist')
    mkdirSync(web)
    writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>fake board</title></head><body></body></html>')
    built = join(root, 'out', 'server.mjs')
    await bundleApp({ webDist: web, outDir: join(root, 'out') })
  }, RUN_MS)

  afterAll(async () => {
    await removeWithRetry(root)
  })

  let tmp: string
  let cfg: string
  let repo: string
  let pidsFile: string
  let children: ChildProcess[]
  let otherPids: number[]

  const ownerFile = () => join(cfg, OWNER)
  const fakePids = () => (existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : [])

  /** Sprint one stopped: `continue` is sendable. */
  const writeStopped = () => {
    writeFileSync(join(repo, 'pod-docs', 'sprints', 'one.md'), sprint('| 1 | A1 | a | one-A1 | merged | done | high | — |'))
    writeFileSync(join(repo, 'pod-docs', 'plans', 'alpha.md'), plan(['| one | goal | done | — |', '| two | goal | planned | — |']))
  }
  /** Sprint one still at work: nothing is sendable. */
  const writeWorking = () => {
    writeFileSync(join(repo, 'pod-docs', 'sprints', 'one.md'), sprint('| 1 | A1 | a | one-A1 | — | in progress | — | — |'))
    writeFileSync(join(repo, 'pod-docs', 'plans', 'alpha.md'), plan(['| one | goal | active | — |', '| two | goal | planned | — |']))
  }

  /** A registered repo, and one ended engineer of its session, quiet for two hours. */
  const writeFixture = (stopped: boolean) => {
    repo = join(tmp, 'repos', 'alpha-repo')
    mkdirSync(join(repo, 'pod-docs', 'plans'), { recursive: true })
    mkdirSync(join(repo, 'pod-docs', 'sprints'), { recursive: true })
    writeFileSync(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
    writeFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
    if (stopped) writeStopped()
    else writeWorking()
    writeFileSync(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))

    const project = join(tmp, 'claude', 'projects', projectDirName(repo))
    const sub = join(project, SESSION, 'subagents')
    mkdirSync(sub, { recursive: true })
    const old = new Date(Date.now() - 7_200_000)
    const at = old.toISOString()
    const mainFile = join(project, `${SESSION}.jsonl`)
    writeFileSync(mainFile, JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'go' } }) + '\n')
    const meta = join(sub, 'agent-eng1.meta.json')
    writeFileSync(meta, JSON.stringify({ agentType: 'pod:engineer', description: 'Build A1' }))
    const agent = join(sub, 'agent-eng1.jsonl')
    writeFileSync(
      agent,
      [
        { type: 'user', cwd: repo, timestamp: at, message: { role: 'user', content: '- **sprint slug:** one\n- **slice code:** A1\n- **branch name:** one-A1\n' } },
        { type: 'assistant', cwd: repo, timestamp: at, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.ts' } }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    )
    for (const p of [mainFile, meta, agent, sub, join(project, SESSION)]) utimesSync(p, old, old)
  }

  const toggleOn = async () => {
    const key = CASELESS ? repo.toLowerCase() : repo
    await createAutoContinueStore({ file: join(cfg, 'auto-continue.json') }).set(key, 'alpha', true)
  }

  /** The bundle's env: a stripped Path, tool-paths.json naming fakes, and a fake claude that waits. */
  const bundleEnv = (port: number, over: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('OPENAFLOW_') && !k.toUpperCase().startsWith('CLAUDE') && !['PATH', 'NODE_PATH'].includes(k.toUpperCase())) env[k] = v
    }
    return {
      ...env,
      Path: SYS32,
      OPENAFLOW_API_PORT: String(port),
      OPENAFLOW_CONFIG_DIR: cfg,
      OPENAFLOW_PORTS_DIR: join(tmp, 'ports'),
      OPENAFLOW_CLAUDE_DIR: join(tmp, 'claude'),
      OPENAFLOW_CLAUDE_BIN: join(tmp, 'bin', 'claude.cmd'),
      FAKE_CLAUDE_MODE: 'wait:600000',
      FAKE_CLAUDE_PIDS: pidsFile,
      ...over,
    }
  }

  type Run = { c: ChildProcess; port: number; base: string; out(): string; messages: unknown[] }

  /** Starts the bundle, with an IPC channel unless `ipc` is false. Doesn't wait for it. */
  const startBundle = async (o: { port?: number; env?: Record<string, string>; ipc?: boolean } = {}): Promise<Run> => {
    const port = o.port ?? (await freePort())
    const stdio = o.ipc === false ? (['ignore', 'pipe', 'pipe'] as const) : (['ignore', 'pipe', 'pipe', 'ipc'] as const)
    const c = spawn(process.execPath, [built], { cwd: tmp, env: bundleEnv(port, o.env), stdio: [...stdio], windowsHide: true })
    children.push(c)
    let text = ''
    c.stdout!.on('data', (d) => (text += String(d)))
    c.stderr!.on('data', (d) => (text += String(d)))
    const messages: unknown[] = []
    if (o.ipc !== false) c.on('message', (m) => messages.push(m))
    return { c, port, base: `http://127.0.0.1:${port}`, out: () => text, messages }
  }

  const listening = (r: Run) => until(`the listening line on ${r.port}`, () => r.out().includes(`openaflow API listening on http://127.0.0.1:${r.port}`), BOOT_MS, r.out)

  const running = async (o: Parameters<typeof startBundle>[0] = {}) => {
    const r = await startBundle(o)
    await listening(r)
    return r
  }

  const healthy = async (base: string) => {
    const res = await fetch(`${base}/api/health`)
    return res.status === 200 && ((await res.json()) as { ok: boolean }).ok
  }

  /** The Board has the repo with its session, so a new stop can be sent on. */
  const boardKnowsSession = (r: Run) =>
    until(
      'the session on the Board',
      async () => {
        const board = (await (await fetch(`${r.base}/api/board`)).json()) as { repos: { agents: { session: string }[] }[] }
        return board.repos.some((x) => x.agents.some((a) => a.session === SESSION))
      },
      BOOT_MS,
      r.out,
    )

  const actionLog = () => {
    const file = join(cfg, 'actions.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  /**
   * Starts a helper parent: `watch` spawns the bundle with piped output and the helper's own process ID; `plain`
   * spawns it with no variable and exits. Both detach it: on Windows, libuv puts a plain child in a job that ends
   * it with its parent, so a Node parent's death would end the server before any of its code ran.
   */
  const startHelper = (mode: 'watch' | 'plain', port: number) => {
    const helper = join(tmp, 'helper.mjs')
    const serverPidFile = join(tmp, 'server.pid')
    writeFileSync(
      helper,
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        'const [server, mode, pidFile] = process.argv.slice(2)',
        "const env = { ...process.env, ...(mode === 'watch' ? { OPENAFLOW_PARENT_PID: String(process.pid) } : {}) }",
        "const c = mode === 'watch' ? spawn(process.execPath, [server], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) : spawn(process.execPath, [server], { env, detached: true, stdio: 'ignore', windowsHide: true })",
        'writeFileSync(pidFile, String(c.pid))',
        "if (mode === 'watch') setInterval(() => {}, 1000)",
        'else { c.unref(); process.exit(0) }',
        '',
      ].join('\n'),
    )
    const c = spawn(process.execPath, [helper, built, mode, serverPidFile], { cwd: tmp, env: bundleEnv(port), stdio: 'ignore', windowsHide: true })
    children.push(c)
    return { c, serverPid: async () => {
      await until('the server process ID', () => existsSync(serverPidFile) && readFileSync(serverPidFile, 'utf8') !== '')
      const pid = Number(readFileSync(serverPidFile, 'utf8'))
      otherPids.push(pid)
      return pid
    } }
  }

  beforeEach(() => {
    tmp = tempDir('clean-stop-run')
    cfg = join(tmp, 'cfg')
    mkdirSync(cfg)
    mkdirSync(join(tmp, 'ports'))
    mkdirSync(join(tmp, 'bin'))
    pidsFile = join(tmp, 'fake-pids.txt')
    children = []
    otherPids = []
    copyFileSync(FAKE, join(tmp, 'bin', 'fake-claude.mjs'))
    writeFileSync(join(tmp, 'bin', 'claude.cmd'), npmShim('fake-claude.mjs'))
    // Files that exist, so all three read found. Nothing here reaches this machine's real tools.
    for (const name of ['git.exe', 'gh.exe']) writeFileSync(join(tmp, 'bin', name), '')
    writeFileSync(join(cfg, 'tool-paths.json'), JSON.stringify({ git: join(tmp, 'bin', 'git.exe'), gh: join(tmp, 'bin', 'gh.exe') }))
  })

  afterEach(async () => {
    for (const pid of fakePids()) killPid(pid)
    for (const pid of otherPids) killPid(pid)
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill()
        await exitOf(c)
      }
    }
    await until('the fakes to end', () => [...fakePids(), ...otherPids].every((pid) => !alive(pid)), 10_000)
    await removeWithRetry(tmp)
  })

  test(
    'stops by message',
    async () => {
      const r = await running()
      await until('the ready message', () => r.messages.length > 0, BOOT_MS, r.out)
      const line = /openaflow API listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(r.out())
      expect(r.messages).toEqual([{ type: 'openaflow:ready', port: Number(line![1]) }])
      expect(JSON.parse(readFileSync(ownerFile(), 'utf8'))).toMatchObject({ pid: r.c.pid })

      // Anything else is ignored.
      for (const m of ['stop', { type: 'other' }, { type: 'openaflow:stop', extra: 1 }]) r.c.send(m)
      await sleep(500)
      expect(await healthy(r.base)).toBe(true)

      r.c.send(STOP)
      expect(await exitOf(r.c)).toBe(0)
      expect(existsSync(ownerFile())).toBe(false)
      expect(r.messages).toHaveLength(1)
    },
    RUN_MS,
  )

  test(
    'a stop sent during the start runs once the start ends',
    async () => {
      const r = await startBundle()
      r.c.send(STOP)
      expect(await exitOf(r.c)).toBe(0)
      expect(r.out()).toContain('openaflow API listening')
      expect(r.messages).toHaveLength(1)
    },
    RUN_MS,
  )

  test(
    'a failed start exits 1 with no ready message',
    async () => {
      const busy = await holdPort()
      try {
        const r = await startBundle({ port: portOf(busy) })
        expect(await exitOf(r.c)).toBe(1)
        expect(r.messages).toEqual([])
        expect(existsSync(ownerFile())).toBe(false)
      } finally {
        await closeServer(busy)
      }
    },
    RUN_MS,
  )

  test(
    'a stop leaves a resumed run alive',
    async () => {
      writeFixture(true)
      await toggleOn()
      const r = await running()
      await until('the fake to start', () => fakePids().length === 1, 30_000, r.out)
      const [fake] = fakePids()

      // During the send: the drain waits for its log line, and then the server exits.
      r.c.send(STOP)
      expect(await exitOf(r.c)).toBe(0)
      expect(actionLog()).toContain('"result":"started"')
      expect(existsSync(ownerFile())).toBe(false)
      await sleep(1000)
      expect(alive(fake!)).toBe(true)
    },
    RUN_MS,
  )

  test(
    'a dead parent stops the server and leaves the run',
    async () => {
      writeFixture(true)
      const port = await freePort()
      const helper = startHelper('watch', port)
      const server = await helper.serverPid()
      const base = `http://127.0.0.1:${port}`
      await until('health', async () => healthy(base).catch(() => false))
      const page = await (await fetch(`${base}/`)).text()
      const token = META.exec(page)![1]!
      await until('the session on the Board', async () => {
        const board = (await (await fetch(`${base}/api/board`)).json()) as { repos: { agents: { session: string }[] }[] }
        return board.repos.some((x) => x.agents.some((a) => a.session === SESSION))
      })
      const board = (await (await fetch(`${base}/api/board`)).json()) as { repos: { id: string }[] }
      expect(existsSync(ownerFile())).toBe(true)

      // A press: the request is still running when the parent dies, so the drain has something to wait for,
      // and it writes its "waiting" line into the dead pipe.
      void fetch(`${base}/api/actions/resume`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
        body: JSON.stringify({ repoId: board.repos[0]!.id, run: 'alpha', reply: 'continue' }),
      }).catch(() => {})
      await until('the fake to start', () => fakePids().length === 1, 30_000)
      const [fake] = fakePids()

      const killedAt = Date.now()
      helper.c.kill()
      await exitOf(helper.c)
      await until('the server to exit', () => !alive(server), 15_000)
      expect(Date.now() - killedAt).toBeLessThanOrEqual(15_000)
      // The drain finished: a forced or crashed end leaves the file behind.
      expect(existsSync(ownerFile())).toBe(false)
      expect(actionLog()).toContain('"result":"started"')
      expect(alive(fake!)).toBe(true)
    },
    RUN_MS,
  )

  test(
    'a parent gone at start',
    async () => {
      const gone = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid
      const r = await startBundle({ ipc: false, env: { OPENAFLOW_PARENT_PID: String(gone) } })
      expect(await exitOf(r.c)).toBe(0)
      expect(r.out()).toContain('openaflow API listening')
      expect(existsSync(ownerFile())).toBe(false)

      const bad = await startBundle({ ipc: false, env: { OPENAFLOW_PARENT_PID: 'abc' } })
      await new Promise((resolve) => bad.c.once('close', resolve))
      expect(bad.c.exitCode).toBe(1)
      expect(bad.out()).toContain('OPENAFLOW_PARENT_PID')
      expect(bad.out()).not.toContain('listening')
    },
    RUN_MS,
  )

  test(
    'a plain start has no watch',
    async () => {
      const port = await freePort()
      const helper = startHelper('plain', port)
      const server = await helper.serverPid()
      expect(await exitOf(helper.c)).toBe(0)
      const base = `http://127.0.0.1:${port}`
      await until('health', async () => healthy(base).catch(() => false))
      // Past two polls of a watch, if one had started.
      await sleep(5000)
      expect(alive(server)).toBe(true)
      expect(await healthy(base)).toBe(true)
    },
    RUN_MS,
  )

  test(
    'one auto-continue owner',
    async () => {
      writeFixture(false)
      await toggleOn()
      const first = await running()
      const second = await running()
      // The line follows the listening line.
      await until("the holder's line", () => second.out().includes(`process ${first.c.pid}`), BOOT_MS, second.out)
      expect(second.out()).toContain(cfg)
      expect(first.out()).not.toContain(String(second.c.pid))
      expect(fakePids()).toEqual([])
      await boardKnowsSession(first)
      await boardKnowsSession(second)

      // Both see the same stop at the same moment, and both toggles are on: only the owner sends.
      writeStopped()
      await until('the fake to start', () => fakePids().length > 0, 30_000, first.out)
      // Long enough for the other one's check on its new Board, and for its own 15 s tick.
      await sleep(16_000)
      expect(fakePids()).toHaveLength(1)
      expect(await healthy(second.base)).toBe(true)
      expect(JSON.parse(readFileSync(ownerFile(), 'utf8'))).toMatchObject({ pid: first.c.pid })
    },
    RUN_MS,
  )

  test(
    'the second stays off until restart',
    async () => {
      writeFixture(false)
      await toggleOn()
      const first = await running()
      const second = await running()
      await boardKnowsSession(second)

      first.c.send(STOP)
      expect(await exitOf(first.c)).toBe(0)
      expect(existsSync(ownerFile())).toBe(false)
      expect(await healthy(second.base)).toBe(true)

      // A stop is due now, with no owner running. The second looked only at its start.
      writeStopped()
      await sleep(17_000)
      expect(fakePids()).toEqual([])
      expect(existsSync(ownerFile())).toBe(false)
      expect(await healthy(second.base)).toBe(true)

      second.c.send(STOP)
      expect(await exitOf(second.c)).toBe(0)

      const third = await running()
      await until('the fake to start', () => fakePids().length === 1, 30_000, third.out)
      expect(JSON.parse(readFileSync(ownerFile(), 'utf8'))).toMatchObject({ pid: third.c.pid })
    },
    RUN_MS,
  )
})
