import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { projectDirName } from '../../server/src/transcript-files.ts'
import { bundleDesktop } from './bundle-desktop.ts'

// The real exit proof: Electron's own exe, the real server bundle, a real resume through the route, and
// fake-claude.mjs behind a claude.cmd. Temp folders only. Every kill here is by a process ID this test recorded,
// and each is one process: never a tree, and never a name. `pnpm test:electron` runs this after `pnpm build`.

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const SERVER_BUNDLE = join(DESKTOP, '..', 'server', 'dist', 'app', 'server.mjs')
const FAKE = join(DESKTOP, '..', 'server', 'test', 'fake-claude.mjs')
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const RUN_MS = 180_000
const BOOT_MS = 60_000
const SESSION = 'sess-1'
const OWNER = 'auto-continue-owner.json'
const META = /<meta name="openaflow-token" content="([^"]+)"/

type Status = {
  mainPid: number
  servers: number[]
  readyPorts: number[]
  failed?: string
  showWindow: number
  lockLost?: boolean
  reporter?: { execPath: string; parentPort: boolean; runAsNode: string | null }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Ends one process by its recorded ID. */
const killPid = (pid: number) => {
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
}

/** `taskkill /F` on one process, with no `/T`: it never reaches a child. */
const taskkill = (pid: number) => {
  const r = spawnSync(join(SYS32, 'taskkill.exe'), ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true })
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
}

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

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** Chromium's helpers let go of the data folder a moment after the main process ends. */
const removeWithRetry = async (path: string) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 200 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await sleep(50)
    }
  }
}

const tempDir = (name: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `openaflow-${name}-`)))

const planDoc = ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | done | — |', '| two | goal | planned | — |', ''].join('\n')
const sprintDoc = ['# Sprint: one', '', '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-11-01_', '', '## Status board', '', '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', '|---|---|---|---|---|---|---|---|', '| 1 | A1 | a | one-A1 | merged | done | high | — |', ''].join('\n')

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && process.platform === 'win32')('the real exit', () => {
  let root: string
  let exe: string
  let probe: string
  let bin: string

  beforeAll(async () => {
    if (!existsSync(SERVER_BUNDLE)) throw new Error(`no server bundle at ${SERVER_BUNDLE}: run pnpm build first`)
    // Resolved here and only here: under Node, the package downloads its binary when it's loaded.
    exe = createRequire(join(DESKTOP, 'package.json'))('electron') as string
    root = tempDir('real-exit')
    probe = join(root, 'probe.cjs')
    await bundleDesktop({ entry: join(DESKTOP, 'test', 'probe-main.ts'), outfile: probe })
    // The shim's own node.exe: with no node at all, a shim under Electron has nothing safe to run.
    bin = join(root, 'bin')
    mkdirSync(bin)
    copyFileSync(process.execPath, join(bin, 'node.exe'))
    copyFileSync(FAKE, join(bin, 'fake-claude.mjs'))
    writeFileSync(join(bin, 'claude.cmd'), ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\fake-claude.mjs" %*', ''].join('\r\n'))
    for (const name of ['git.exe', 'gh.exe']) writeFileSync(join(bin, name), '')
  }, RUN_MS)

  afterAll(async () => {
    if (root) await removeWithRetry(root)
  })

  let tmp: string
  let cfg: string
  let repo: string
  let port: number
  let pidsFile: string
  let children: ChildProcess[]
  let recorded: number[]

  const fakePids = () => (existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  const ownerFile = () => join(cfg, OWNER)

  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      const u = k.toUpperCase()
      if (!u.startsWith('OPENAFLOW_') && !u.startsWith('CLAUDE') && !u.startsWith('ELECTRON_') && !['PATH', 'NODE_PATH', 'NODE_OPTIONS'].includes(u) && !u.startsWith('VITEST')) env[k] = v
    }
    return {
      ...env,
      Path: SYS32,
      OPENAFLOW_API_PORT: String(port),
      OPENAFLOW_CONFIG_DIR: cfg,
      OPENAFLOW_PORTS_DIR: join(tmp, 'ports'),
      OPENAFLOW_CLAUDE_DIR: join(tmp, 'claude'),
      OPENAFLOW_CLAUDE_BIN: join(bin, 'claude.cmd'),
      FAKE_CLAUDE_MODE: 'wait:600000',
      FAKE_CLAUDE_PIDS: pidsFile,
    }
  }

  /** A registered repo whose sprint stopped, with one ended engineer of its session, quiet for two hours. */
  const writeFixture = () => {
    repo = join(tmp, 'repos', 'alpha-repo')
    mkdirSync(join(repo, 'pod-docs', 'plans'), { recursive: true })
    mkdirSync(join(repo, 'pod-docs', 'sprints'), { recursive: true })
    writeFileSync(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
    writeFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
    writeFileSync(join(repo, 'pod-docs', 'sprints', 'one.md'), sprintDoc)
    writeFileSync(join(repo, 'pod-docs', 'plans', 'alpha.md'), planDoc)
    writeFileSync(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    writeFileSync(join(cfg, 'tool-paths.json'), JSON.stringify({ git: join(bin, 'git.exe'), gh: join(bin, 'gh.exe') }))

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

  type Shell = { c: ChildProcess; statusFile: string; quitFile: string; out(): string; status(): Status | undefined }

  /** Starts Electron's exe itself, so `c.pid` is the main process and not a launcher's. */
  const startProbe = (name: string, over: Record<string, string> = {}): Shell => {
    const statusFile = join(tmp, `${name}-status.json`)
    const quitFile = join(tmp, `${name}-quit`)
    const c = spawn(exe, [probe], {
      cwd: tmp,
      env: {
        ...baseEnv(),
        OPENAFLOW_DESKTOP_DATA_DIR: join(tmp, 'shell'),
        OPENAFLOW_PROBE_APP_PATH: DESKTOP,
        OPENAFLOW_PROBE_STATUS: statusFile,
        OPENAFLOW_PROBE_QUIT: quitFile,
        ...over,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(c)
    if (c.pid) recorded.push(c.pid)
    let text = ''
    c.stdout!.on('data', (d) => (text += String(d)))
    c.stderr!.on('data', (d) => (text += String(d)))
    return {
      c,
      statusFile,
      quitFile,
      out: () => text,
      status: () => {
        try {
          const s = JSON.parse(readFileSync(statusFile, 'utf8')) as Status
          for (const pid of s.servers) if (!recorded.includes(pid)) recorded.push(pid)
          return s
        } catch {
          return undefined // not written yet, or caught during a write
        }
      },
    }
  }

  const readyCount = (s: Shell) => s.status()?.readyPorts.length ?? 0
  const details = (s: Shell) => () => `status: ${JSON.stringify(s.status())}\noutput: ${s.out()}`
  const waitReady = async (s: Shell, count = 1) => {
    await until(`ready ${count}`, () => readyCount(s) >= count, BOOT_MS, details(s))
    return s.status()!
  }

  const base = () => `http://127.0.0.1:${port}`

  /** A real resume through the route. The fake is the shim's own node.exe, or the proof proves nothing. */
  const resumeRun = async (s: Shell) => {
    await until(
      'the session on the Board',
      async () => {
        const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: { agents: { session: string }[] }[] }
        return board.repos.some((x) => x.agents.some((a) => a.session === SESSION))
      },
      BOOT_MS,
      details(s),
    )
    const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: { id: string }[] }
    const token = META.exec(await (await fetch(`${base()}/`)).text())![1]!
    const res = await fetch(`${base()}/api/actions/resume`, {
      method: 'POST',
      headers: { Origin: base(), 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ repoId: board.repos[0]!.id, run: 'alpha', reply: 'continue' }),
    })
    expect(await res.json()).toMatchObject({ outcome: 'started' })
    expect(fakePids()).toHaveLength(1)
    const fake = fakePids()[0]!
    const listed = spawnSync(join(SYS32, 'tasklist.exe'), ['/FI', `PID eq ${fake}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    expect(listed.stdout.toLowerCase()).toContain('node.exe')
    return fake
  }

  beforeEach(async () => {
    tmp = tempDir('real-exit-run')
    cfg = join(tmp, 'cfg')
    mkdirSync(cfg)
    mkdirSync(join(tmp, 'ports'))
    pidsFile = join(tmp, 'fake-pids.txt')
    children = []
    recorded = []
    port = await freePort()
    writeFixture()
  })

  afterEach(async () => {
    const all = [...fakePids(), ...recorded]
    for (const pid of all) killPid(pid)
    await until('every recorded process to end', () => all.every((pid) => !alive(pid)), 15_000)
    await Promise.all(children.map(exitOf))
    await removeWithRetry(tmp)
  })

  test(
    'real parentPort carries ready',
    async () => {
      const reporter = join(tmp, 'reporter.mjs')
      writeFileSync(
        reporter,
        'process.parentPort?.postMessage({ execPath: process.execPath, parentPort: Boolean(process.parentPort), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null })\n' +
          'setTimeout(() => process.exit(0), 200)\n',
      )
      const s = startProbe('main', { OPENAFLOW_PROBE_REPORTER: reporter })
      const status = await waitReady(s)
      await until('the reporter', () => s.status()?.reporter !== undefined, BOOT_MS, details(s))

      const seen = s.status()!.reporter!
      expect(realpathSync.native(seen.execPath)).toBe(realpathSync.native(exe))
      expect(seen.parentPort).toBe(true)
      expect(seen.runAsNode).toBeNull()

      expect(status.mainPid).toBe(s.c.pid)
      expect(status.readyPorts).toEqual([port])
      expect(s.out()).toContain(`openaflow API listening on http://127.0.0.1:${port}`)
      expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true })
      expect(JSON.parse(readFileSync(ownerFile(), 'utf8'))).toMatchObject({ pid: status.servers[0] })
    },
    RUN_MS,
  )

  test(
    'a normal quit stops the server and leaves the run',
    async () => {
      const s = startProbe('main')
      const status = await waitReady(s)
      const server = status.servers[0]!
      const fake = await resumeRun(s)

      const askedAt = Date.now()
      writeFileSync(s.quitFile, 'quit')
      expect(await exitOf(s.c)).toBe(0)
      await until('the server to end', () => !alive(server), 30_000)
      expect(Date.now() - askedAt).toBeLessThanOrEqual(30_000)

      expect(existsSync(ownerFile())).toBe(false)
      expect(s.status()!.failed).toBeUndefined()
      await sleep(2000)
      expect(alive(fake)).toBe(true)
    },
    RUN_MS,
  )

  test(
    'a killed main process leaves no server and leaves the run',
    async () => {
      const s = startProbe('main')
      const status = await waitReady(s)
      const server = status.servers[0]!
      const fake = await resumeRun(s)

      taskkill(s.c.pid!)
      await exitOf(s.c)
      await until('the server to end', () => !alive(server), 15_000)
      console.info(`openaflow proof: owner file after a killed main process: ${existsSync(ownerFile()) ? 'left behind' : 'removed'}`)
      await sleep(2000)
      expect(alive(fake)).toBe(true)

      // With either outcome, the next start owns auto-continue.
      const nextPort = await freePort()
      const next = spawn(process.execPath, [SERVER_BUNDLE], {
        cwd: tmp,
        env: { ...baseEnv(), OPENAFLOW_API_PORT: String(nextPort) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      })
      children.push(next)
      if (next.pid) recorded.push(next.pid)
      let text = ''
      next.stdout!.on('data', (d) => (text += String(d)))
      next.stderr!.on('data', (d) => (text += String(d)))
      await until('the next start', () => text.includes(`openaflow API listening on http://127.0.0.1:${nextPort}`), BOOT_MS, () => text)
      await until('the owner file', () => existsSync(ownerFile()), 10_000, () => text)
      expect(JSON.parse(readFileSync(ownerFile(), 'utf8'))).toMatchObject({ pid: next.pid })
      expect(text).not.toContain("won't auto-continue")
      expect(alive(fake)).toBe(true)

      next.send({ type: 'openaflow:stop' })
      expect(await exitOf(next)).toBe(0)
    },
    RUN_MS,
  )

  test(
    'a killed server restarts once, then fails, and leaves the run',
    async () => {
      const s = startProbe('main')
      const first = await waitReady(s)
      const fake = await resumeRun(s)

      taskkill(first.servers[0]!)
      const second = await (async () => {
        await until('a new ready', () => readyCount(s) >= 2, 30_000, details(s))
        return s.status()!
      })()
      expect(second.servers).toHaveLength(2)
      expect(second.servers[1]).not.toBe(first.servers[0])
      expect(second.readyPorts[1]).toBe(port)
      expect(alive(fake)).toBe(true)
      expect(s.status()!.failed).toBeUndefined()

      taskkill(second.servers[1]!)
      await until('the failed report', () => s.status()?.failed !== undefined, 30_000, details(s))
      expect(await exitOf(s.c)).toBe(0)
      await sleep(2000)

      const last = s.status()!
      expect(last.servers).toHaveLength(2)
      for (const pid of last.servers) expect(alive(pid)).toBe(false)
      expect(alive(fake)).toBe(true)
      expect(fakePids()).toEqual([fake])
    },
    RUN_MS,
  )

  test(
    'a second launch starts no server',
    async () => {
      const s = startProbe('main')
      const status = await waitReady(s)

      const second = startProbe('second')
      const code = await Promise.race([exitOf(second.c), sleep(15_000).then(() => 'still running' as const)])
      expect(code).toBe(0)
      expect(second.status()?.lockLost).toBe(true)
      expect(second.status()?.servers).toEqual([])

      await until('the first to hear the second launch', () => s.status()?.showWindow === 1, 10_000, details(s))
      expect(s.status()!.servers).toEqual(status.servers)
      expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true })

      writeFileSync(s.quitFile, 'quit')
      expect(await exitOf(s.c)).toBe(0)
    },
    RUN_MS,
  )
})
