import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { projectDirName } from '../../server/src/transcript-files.ts'
import { EXE_NAME } from './build-config.ts'
import { finishProof, launch, machineState, proofLastLine, proofPlace, refuseRealInstall, silentInstall, stateDiff, waitForHealth, withInstallLock, type MachineState, type ProofPlace } from './install-check.ts'
import { APP_ID } from './shell-config.ts'
import { TEST_ENV_FILE } from './update-feed.ts'

// The update proof: two `--test-feed` builds in a temp folder, a real per-user install of the older one, and the newer
// one served from a local static server. Nothing is published. `pnpm test:install` runs it; `pnpm verify` skips it. The
// tests run in order and share one install.

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const ROOT = join(DESKTOP, '..', '..')
/** The mock repo to copy. Its path is local to the maintainer's machine, so it comes from the env. */
const MOCK = process.env.OPENAFLOW_MOCK_REPO ?? ''
const FAKE = join(DESKTOP, '..', 'server', 'test', 'fake-claude.mjs')
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const POWERSHELL = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const PROGRAMS = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const PORT = Number(process.env.OPENAFLOW_PROOF_PORT ?? 3110)
const FEED_PORT = Number(process.env.OPENAFLOW_PROOF_FEED_PORT ?? 3111)
const FEED_URL = `http://127.0.0.1:${FEED_PORT}/`
const OLDER = '0.1.0'
const NEWER = '0.1.1'
const RUN_MS = 300_000
const BUILDS_MS = 15 * 60_000
const LOCK_MS = 40 * 60_000
const META = /<meta name="openaflow-token" content="([^"]+)"/
/** Set it to a file path to save a picture of the real box. */
const BOX_PICTURE = process.env.OPENAFLOW_PROOF_BOX_PICTURE

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 60_000, extra: () => string = () => '') => {
  const end = Date.now() + ms
  for (;;) {
    if (await ok()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${extra()}`)
    await sleep(200)
  }
}
const powershell = (command: string) => spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).stdout.trim()

type FeedMode = 'ok' | '500' | 'bad-yml' | 'cut'

/** A small static server for the newer build. It takes no query string into account: the updater adds `?noCache=`. */
function startFeed(folder: string) {
  let mode: FeedMode = 'ok'
  let held: Promise<void> = Promise.resolve()
  let release: () => void = () => {}
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', FEED_URL).pathname.slice(1)
    requests.push(name)
    void (async () => {
      if (name === 'latest.yml') await held
      if (mode === '500') {
        res.writeHead(500).end('no')
      } else if (mode === 'bad-yml' && name === 'latest.yml') {
        res.writeHead(200).end(': [ not yaml')
      } else if (!/^(latest\.yml|openaflow-setup-[\d.]+\.exe(\.blockmap)?)$/.test(name) || !existsSync(join(folder, name))) {
        res.writeHead(404).end()
      } else {
        const bytes = readFileSync(join(folder, name))
        if (mode === 'cut' && name.endsWith('.exe')) {
          res.writeHead(200, { 'Content-Length': bytes.length })
          res.write(bytes.subarray(0, Math.floor(bytes.length / 4)), () => res.destroy())
        } else {
          res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes)
        }
      }
    })()
  })
  return {
    listen: () => new Promise<void>((resolve, reject) => server.once('error', reject).listen(FEED_PORT, '127.0.0.1', resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        release()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
    setMode: (next: FeedMode) => void (mode = next),
    /** Holds each `latest.yml` until `open`, so a test decides when the app sees the update. */
    hold: () => void (held = new Promise((r) => (release = r))),
    open: () => release(),
    exeRequests: () => requests.filter((name) => name.endsWith('.exe')).length,
  }
}

const planDoc = ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | done | — |', '| two | goal | planned | — |', ''].join('\n')
const sprintDoc = ['# Sprint: one', '', '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-11-01_', '', '## Status board', '', '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', '|---|---|---|---|---|---|---|---|', '| 1 | A1 | a | one-A1 | merged | done | high | — |', ''].join('\n')

describe.runIf(process.env.OPENAFLOW_REAL_INSTALL === '1' && MOCK !== '' && process.platform === 'win32')('the update proof', () => {
  let freeLock: () => void = () => {}
  let lockDone: Promise<void> = Promise.resolve()
  let before: MachineState | undefined
  let startMenuBefore = ''
  let place: ProofPlace
  let feed: ReturnType<typeof startFeed> | undefined
  let builds: string
  let repo: string
  let pidsFile: string
  let finished = false
  let appPid = 0
  let appOutput: () => string = () => ''
  let oldApps: number[] = []
  let fake = 0
  let configBefore = ''
  let toolPathsBefore = ''
  let runBefore: string | null = null

  const base = () => `http://127.0.0.1:${place.port}`
  const exe = () => join(place.installDir, EXE_NAME)
  const configDir = () => place.env.OPENAFLOW_CONFIG_DIR!
  const fakePids = () => (pidsFile && existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  const tokenOf = async () => META.exec(await (await fetch(`${base()}/`)).text())![1]!
  // Windows keeps four parts: 0.1.0.0.
  const exeVersion = () => powershell(`(Get-Item -LiteralPath '${exe()}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion`).replace(/\.0$/, '')
  const packagedVersion = () => (JSON.parse(extractFile(join(place.installDir, 'resources', 'app.asar'), 'package.json').toString('utf8')) as { version: string }).version
  const installerFor = (version: string) => join(builds, version, `openaflow-setup-${version}.exe`)

  const pack = (args: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD']) delete env[name]
    const run = spawnSync(`pnpm package ${args}`, { cwd: ROOT, env, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    if (run.status !== 0) throw new Error(`pnpm package ${args} failed:\n${run.stdout}\n${run.stderr}`)
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/\b(publishing|uploading|uploaded)\b/i)
  }

  /** A start with the answer in the env. The file carries the same env to the app the installer starts after an update. */
  const startApp = async (answer: 'restart' | 'later' | null, delayMs = 1000) => {
    Object.assign(place.env, { OPENAFLOW_UPDATE_TEST_FEED: FEED_URL, OPENAFLOW_UPDATE_TEST_DELAY_MS: String(delayMs) })
    if (answer === null) delete place.env.OPENAFLOW_UPDATE_TEST_ANSWER
    else place.env.OPENAFLOW_UPDATE_TEST_ANSWER = answer
    writeFileSync(join(place.root, TEST_ENV_FILE), JSON.stringify(place.env))
    const app = await launch(place)
    appPid = app.pid
    appOutput = app.output
    await waitForHealth(place)
  }

  const stopApp = async () => {
    if (appPid === 0) return
    if (alive(appPid)) process.kill(appPid)
    await until('the app to end', async () => !alive(appPid) && (await machineState()).apps.length === 0)
    appPid = 0
  }

  const stopFakes = async () => {
    const pids = fakePids()
    for (const pid of pids) {
      if (alive(pid)) process.kill(pid)
    }
    await until('the fakes to end', () => pids.every((pid) => !alive(pid)))
  }

  /** A copy of the mock repo with one more plan, whose sprint stopped with an ended engineer, quiet for two hours. */
  const writeFixture = () => {
    repo = join(place.root, 'repos', 'mock-copy')
    cpSync(MOCK, repo, { recursive: true, filter: (from) => !from.endsWith('.board') })
    writeFileSync(join(repo, 'pod-docs', 'plans', 'alpha.md'), planDoc)
    writeFileSync(join(repo, 'pod-docs', 'sprints', 'one.md'), sprintDoc)

    const project = join(place.env.OPENAFLOW_CLAUDE_DIR!, 'projects', projectDirName(repo))
    const sub = join(project, 'sess-1', 'subagents')
    mkdirSync(sub, { recursive: true })
    const old = new Date(Date.now() - 7_200_000)
    const at = old.toISOString()
    const mainFile = join(project, 'sess-1.jsonl')
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
    for (const p of [mainFile, meta, agent, sub, join(project, 'sess-1')]) utimesSync(p, old, old)

    // A shim whose node.exe sits beside it, so the fake is the shim's own process and never a real claude.
    const bin = join(place.root, 'bin')
    mkdirSync(bin)
    copyFileSync(process.execPath, join(bin, 'node.exe'))
    copyFileSync(FAKE, join(bin, 'fake-claude.mjs'))
    writeFileSync(join(bin, 'claude.cmd'), ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\fake-claude.mjs" %*', ''].join('\r\n'))
    for (const name of ['git.exe', 'gh.exe']) writeFileSync(join(bin, name), '')
    writeFileSync(join(configDir(), 'tool-paths.json'), JSON.stringify({ git: join(bin, 'git.exe'), gh: join(bin, 'gh.exe') }))
    pidsFile = join(place.root, 'fake-pids.txt')
    Object.assign(place.env, { OPENAFLOW_CLAUDE_BIN: join(bin, 'claude.cmd'), FAKE_CLAUDE_MODE: 'wait:600000', FAKE_CLAUDE_PIDS: pidsFile })
  }

  beforeAll(async () => {
    await new Promise<void>((held) => {
      lockDone = withInstallLock(
        () =>
          new Promise<void>((free) => {
            freeLock = free
            held()
          }),
      )
      // A lock that can't be had reaches the first test as its failure.
      lockDone.catch(() => held())
    })
    before = await machineState()
    startMenuBefore = JSON.stringify(before.startMenu)
    refuseRealInstall(before)
    place = proofPlace(PORT)
    writeFixture()
    builds = join(place.root, 'builds')
    for (const version of [OLDER, NEWER]) pack(`--version=${version} --output=${join(builds, version)} --test-feed`)
    feed = startFeed(join(builds, NEWER))
    await feed.listen()
  }, LOCK_MS + BUILDS_MS)

  // A failed test must not leave its app for the next start: that start would be a second instance.
  afterEach(() => stopApp(), RUN_MS)

  afterAll(async () => {
    try {
      await stopFakes()
      await feed?.close()
      if (before && place && !finished) console.log(proofLastLine(await finishProof(place, before)))
    } finally {
      freeLock()
      await lockDone.catch(() => {})
    }
  }, RUN_MS)

  test(
    'a bad feed changes nothing',
    async () => {
      await silentInstall(installerFor(OLDER), place)
      expect(exeVersion()).toBe(OLDER)
      expect(packagedVersion()).toBe(OLDER)

      for (const mode of ['500', 'bad-yml', 'cut'] as const) {
        feed!.setMode(mode)
        const exeBefore = feed!.exeRequests()
        await startApp('restart')
        await until(`the failure line on ${mode}`, () => appOutput().includes('update check failed'), 120_000, appOutput)
        await sleep(2000)
        expect(appOutput().split('update check failed').length - 1, appOutput()).toBe(1)
        expect(appOutput()).not.toContain('ready, asking')
        // No URL and no token in the app's log.
        expect(appOutput()).not.toContain(`127.0.0.1:${FEED_PORT}`)
        expect(appOutput()).not.toMatch(/github\.com|token/i)
        if (mode === 'cut') expect(feed!.exeRequests()).toBeGreaterThan(exeBefore)
        else expect(feed!.exeRequests()).toBe(exeBefore)

        // It still runs on its version.
        expect(alive(appPid)).toBe(true)
        expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true })
        expect(exeVersion()).toBe(OLDER)
        await stopApp()
      }
      feed!.setMode('ok')
    },
    RUN_MS,
  )

  test(
    'later keeps the version',
    async () => {
      const exeBefore = feed!.exeRequests()
      await startApp('later')
      await until('the ask', () => appOutput().includes(`update ${NEWER} ready, asking`), 180_000, appOutput)
      await until('the later', () => appOutput().includes(`update ${NEWER}: later`), 10_000, appOutput)
      expect(feed!.exeRequests()).toBeGreaterThan(exeBefore)
      await sleep(3000)
      expect(alive(appPid)).toBe(true)
      expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true })
      expect(exeVersion()).toBe(OLDER)
      await stopApp()
      expect(exeVersion()).toBe(OLDER)

      // The next launch asks again, from its cache.
      const exeAfter = feed!.exeRequests()
      await startApp('later')
      await until('the second ask', () => appOutput().includes(`update ${NEWER} ready, asking`), 60_000, appOutput)
      await until('the second later', () => appOutput().includes(`update ${NEWER}: later`), 10_000, appOutput)
      expect(feed!.exeRequests()).toBe(exeAfter)
      expect(exeVersion()).toBe(OLDER)
      await stopApp()
    },
    RUN_MS,
  )

  test.runIf(BOX_PICTURE !== undefined)(
    'a picture of the box',
    async () => {
      await startApp(null)
      await until('the ask', () => appOutput().includes(`update ${NEWER} ready, asking`), 60_000, appOutput)
      await sleep(2000)
      const script = [
        `Add-Type -AssemblyName System.Drawing`,
        `Add-Type 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr d,uint f);public struct R{public int L,T,Ri,B;}}'`,
        `$h=[W]::FindWindow('#32770','OpenAFlow')`,
        `$r=New-Object W+R;[void][W]::GetWindowRect($h,[ref]$r)`,
        `$b=New-Object Drawing.Bitmap(($r.Ri-$r.L),($r.B-$r.T))`,
        `$g=[Drawing.Graphics]::FromImage($b);$d=$g.GetHdc();[void][W]::PrintWindow($h,$d,2);$g.ReleaseHdc($d)`,
        `$b.Save('${BOX_PICTURE}');"$h"`,
      ].join('\n')
      expect(powershell(script)).not.toBe('0')
      expect(existsSync(BOX_PICTURE!)).toBe(true)
      expect(appOutput()).not.toContain(`update ${NEWER}: `)
      expect(exeVersion()).toBe(OLDER)
      await stopApp()
    },
    RUN_MS,
  )

  test(
    'older finds, asks, installs newer',
    async () => {
      // The feed holds its answer until the app has a run and a login value to keep.
      feed!.hold()
      await startApp('restart')

      const headers = async () => ({ Origin: base(), 'Content-Type': 'application/json', 'X-OpenAFlow-Token': await tokenOf() })
      const added = await fetch(`${base()}/api/repos`, { method: 'POST', headers: await headers(), body: JSON.stringify({ path: repo }) })
      expect(added.status, await added.clone().text()).toBe(201)
      configBefore = readFileSync(join(configDir(), 'config.json'), 'utf8')
      toolPathsBefore = readFileSync(join(configDir(), 'tool-paths.json'), 'utf8')

      spawnSync(join(SYS32, 'reg.exe'), ['add', RUN_KEY, '/v', APP_ID, '/t', 'REG_SZ', '/d', `"${exe()}" --hidden`, '/f'], { windowsHide: true })
      runBefore = (await machineState()).runValue
      expect(runBefore).toContain('--hidden')

      // A real resume through the route, from the running older app.
      await until('the session on the Board', async () => {
        const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: { agents: { session: string }[] }[] }
        return board.repos.some((r) => r.agents.some((a) => a.session === 'sess-1'))
      })
      const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: { id: string }[] }
      const res = await fetch(`${base()}/api/actions/resume`, { method: 'POST', headers: await headers(), body: JSON.stringify({ repoId: board.repos[0]!.id, run: 'alpha', reply: 'continue' }) })
      expect(await res.json()).toMatchObject({ outcome: 'started' })
      fake = fakePids()[0]!
      expect(alive(fake)).toBe(true)
      appendFileSync(join(configDir(), 'keep-me.txt'), 'a file the update must leave\n')

      oldApps = (await machineState()).apps
      expect(oldApps).toContain(appPid)
      expect(oldApps.length).toBeGreaterThan(1)
      const oldPid = appPid
      const oldOutput = appOutput

      feed!.open()
      await until('the ask', () => oldOutput().includes(`update ${NEWER} ready, asking`), 180_000, oldOutput)
      await until('the restart', () => oldOutput().includes(`update ${NEWER}: restart`), 10_000, oldOutput)
      await until('the older app to end', () => !alive(oldPid), 120_000, oldOutput)
      appPid = 0

      await until('the newer version', () => exeVersion() === NEWER, RUN_MS - 120_000, oldOutput)
      expect(packagedVersion()).toBe(NEWER)

      // The installer starts the new app. Its env file gives it the temp folders and this port.
      await waitForHealth(place, 120_000)
      expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true })
      const owner = JSON.parse(readFileSync(join(configDir(), 'auto-continue-owner.json'), 'utf8')) as { pid: number }
      expect(alive(owner.pid)).toBe(true)
      expect(oldApps).not.toContain(owner.pid)
      expect(oldOutput()).not.toContain('update install failed')
    },
    RUN_MS + 120_000,
  )

  test('an update never stops a run', async () => {
    expect(fake).toBeGreaterThan(0)
    expect(alive(fake)).toBe(true)
    const listed = spawnSync(join(SYS32, 'tasklist.exe'), ['/FI', `PID eq ${fake}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    expect(listed.stdout.toLowerCase()).toContain('node.exe')

    // No old app process stays, and the new one runs.
    const now = (await machineState()).apps
    expect(now.length).toBeGreaterThan(0)
    expect(now.filter((pid) => oldApps.includes(pid))).toEqual([])
  })

  test('an update keeps config and login', async () => {
    expect(readFileSync(join(configDir(), 'config.json'), 'utf8')).toBe(configBefore)
    expect(readFileSync(join(configDir(), 'tool-paths.json'), 'utf8')).toBe(toolPathsBefore)
    expect(readFileSync(join(configDir(), 'keep-me.txt'), 'utf8')).toContain('a file the update must leave')
    expect((await machineState()).runValue).toBe(runBefore)
    expect((await machineState()).startMenu).toHaveLength(1)
  })

  test(
    'shipped update file',
    () => {
      const shipped = join(place.root, 'shipped')
      pack(`--output=${shipped}`)
      const resources = join(shipped, 'win-unpacked', 'resources')
      const update = parse(readFileSync(join(resources, 'app-update.yml'), 'utf8')) as Record<string, unknown>
      expect(update).toMatchObject({ provider: 'github', owner: 'alvionlabs', repo: 'openaflow' })
      // The signature check is off: the field that turns it on is absent.
      expect(update.publisherName).toBeUndefined()
      expect(update.updaterCacheDirName).toBe('openaflow-updater')

      // A shipped build can't use the test feed, and a test build does hold it.
      expect(extractFile(join(resources, 'app.asar'), 'dist/main.cjs').toString('utf8')).not.toContain('OPENAFLOW_UPDATE_TEST')
      expect(extractFile(join(builds, NEWER, 'win-unpacked', 'resources', 'app.asar'), 'dist/main.cjs').toString('utf8')).toContain('OPENAFLOW_UPDATE_TEST')
      // pnpm package leaves a default bundle behind in every case.
      expect(readFileSync(join(DESKTOP, 'dist', 'main.cjs'), 'utf8')).not.toContain('OPENAFLOW_UPDATE_TEST')
    },
    RUN_MS,
  )

  test(
    'leaves nothing behind',
    async () => {
      await stopFakes()
      await feed!.close()
      feed = undefined
      const diff = await finishProof(place, before!)
      finished = true
      expect(stateDiff(before!, await machineState())).toEqual([])
      expect(JSON.stringify((await machineState()).startMenu)).toBe(startMenuBefore)
      expect(existsSync(join(PROGRAMS, 'OpenAFlow.lnk'))).toBe(false)
      expect(diff).toEqual([])
      console.log(proofLastLine(diff))
    },
    RUN_MS,
  )
})
