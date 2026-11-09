import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { projectDirName } from '../../server/src/transcript-files.ts'
import { EXE_NAME } from './build-config.ts'
import { finishProof, launch, machineState, proofLastLine, proofPlace, refuseRealInstall, silentInstall, silentUninstall, stateDiff, waitForHealth, withInstallLock, type MachineState, type ProofPlace } from './install-check.ts'
import { APP_ID, APP_NAME } from './shell-config.ts'

// The install proof: the real `pnpm package`, a real per-user install in a temp folder, the installed exe, and a
// real uninstall. `pnpm test:install` runs it; `pnpm verify` skips it. The tests run in order and share one install.

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const ROOT = join(DESKTOP, '..', '..')
const RELEASE = join(DESKTOP, 'release')
/** The mock repo to copy. Its path is local to the maintainer's machine, so it comes from the env. */
const MOCK = process.env.OPEN_AFLOW_MOCK_REPO ?? ''
const FAKE = join(DESKTOP, '..', 'server', 'test', 'fake-claude.mjs')
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const POWERSHELL = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PROGRAMS = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
/** An unpackaged Electron's first toast leaves this shortcut, with the same AppID. Get-StartApps then lists its name. */
const DEV_SHORTCUT = join(PROGRAMS, 'Electron.lnk')
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const PORT = Number(process.env.OPEN_AFLOW_PROOF_PORT ?? 3100)
const RUN_MS = 300_000
const LOCK_MS = 40 * 60_000
const TOAST_LINE = 'open-aflow desktop: toast sent'
const META = /<meta name="open-aflow-token" content="([^"]+)"/

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
const mainWindow = (pid: number) => powershell(`(Get-Process -Id ${pid}).MainWindowHandle`)
const version = () => (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { version: string }).version

const planDoc = ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | done | — |', '| two | goal | planned | — |', ''].join('\n')
const sprintDoc = ['# Sprint: one', '', '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-11-01_', '', '## Status board', '', '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', '|---|---|---|---|---|---|---|---|', '| 1 | A1 | a | one-A1 | merged | done | high | — |', ''].join('\n')

describe.runIf(process.env.OPEN_AFLOW_REAL_INSTALL === '1' && MOCK !== '' && process.platform === 'win32')('the install proof', () => {
  let freeLock: () => void = () => {}
  let lockDone: Promise<void> = Promise.resolve()
  let before: MachineState | undefined
  let startMenuBefore: string[] = []
  let place: ProofPlace
  let repo: string
  let bin: string
  let pidsFile: string
  let finished = false
  let appPid = 0
  let appOutput: () => string = () => ''

  const base = () => `http://127.0.0.1:${place.port}`
  const exe = () => join(place.installDir, EXE_NAME)
  const installer = () => join(RELEASE, `open-aflow-setup-${version()}.exe`)
  const configDir = () => place.env.OPEN_AFLOW_CONFIG_DIR!
  const fakePids = () => (existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  const runValue = async () => (await machineState()).runValue

  const stopFakes = async () => {
    const pids = pidsFile ? fakePids() : []
    for (const pid of pids) {
      if (alive(pid)) process.kill(pid)
    }
    await until('the fakes to end', () => pids.every((pid) => !alive(pid)))
  }

  const stopApp = async () => {
    if (appPid === 0) return
    process.kill(appPid)
    await until('the app to end', async () => !alive(appPid) && (await machineState()).apps.length === 0)
    appPid = 0
  }

  const tokenOf = async () => META.exec(await (await fetch(`${base()}/`)).text())![1]!

  /** A copy of the mock repo with one more plan, whose sprint stopped with an ended engineer, quiet for two hours. */
  const writeFixture = () => {
    repo = join(place.root, 'repos', 'mock-copy')
    cpSync(MOCK, repo, { recursive: true, filter: (from) => !from.endsWith('.board') })
    writeFileSync(join(repo, 'pod-docs', 'plans', 'alpha.md'), planDoc)
    writeFileSync(join(repo, 'pod-docs', 'sprints', 'one.md'), sprintDoc)

    const project = join(place.env.OPEN_AFLOW_CLAUDE_DIR!, 'projects', projectDirName(repo))
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
    bin = join(place.root, 'bin')
    mkdirSync(bin)
    copyFileSync(process.execPath, join(bin, 'node.exe'))
    copyFileSync(FAKE, join(bin, 'fake-claude.mjs'))
    writeFileSync(join(bin, 'claude.cmd'), ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\fake-claude.mjs" %*', ''].join('\r\n'))
    for (const name of ['git.exe', 'gh.exe']) writeFileSync(join(bin, name), '')
    writeFileSync(join(configDir(), 'tool-paths.json'), JSON.stringify({ git: join(bin, 'git.exe'), gh: join(bin, 'gh.exe') }))
    pidsFile = join(place.root, 'fake-pids.txt')
    Object.assign(place.env, { OPEN_AFLOW_CLAUDE_BIN: join(bin, 'claude.cmd'), FAKE_CLAUDE_MODE: 'wait:600000', FAKE_CLAUDE_PIDS: pidsFile })
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
    startMenuBefore = readdirSync(PROGRAMS)
    refuseRealInstall(before)
    place = proofPlace(PORT)
    writeFixture()
  }, LOCK_MS)

  afterAll(async () => {
    try {
      await stopFakes()
      if (before && place && !finished) console.log(proofLastLine(await finishProof(place, before)))
    } finally {
      freeLock()
      await lockDone.catch(() => {})
    }
  }, RUN_MS)

  test(
    'package gives the three files',
    () => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD']) delete env[name]
      const run = spawnSync('pnpm package', { cwd: ROOT, env, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/\b(publishing|uploading|uploaded)\b/i)

      const name = `open-aflow-setup-${version()}.exe`
      expect(existsSync(join(RELEASE, name))).toBe(true)
      expect(existsSync(join(RELEASE, `${name}.blockmap`))).toBe(true)
      const update = parse(readFileSync(join(RELEASE, 'latest.yml'), 'utf8')) as { version: string; path: string; sha512: string }
      expect(update.version).toBe(version())
      expect(update.path).toBe(name)
      expect(update.sha512).toBe(createHash('sha512').update(readFileSync(join(RELEASE, name))).digest('base64'))
      for (const file of [name, `${name}.blockmap`, 'latest.yml']) expect(file).not.toMatch(/\s/)
    },
    RUN_MS,
  )

  test('packaged contents', () => {
    const resources = join(RELEASE, 'win-unpacked', 'resources')
    const asar = join(resources, 'app.asar')
    const inside = listPackage(asar, { isPack: false }).map((f) => f.replaceAll('\\', '/'))
    expect(inside).toContain('/dist/main.cjs')
    expect(inside).toContain('/package.json')
    expect(inside).toContain('/assets/icon.ico')
    expect(inside).toContain('/assets/tray.png')
    expect(inside.filter((f) => f.includes('node_modules'))).toEqual([])
    expect(inside.filter((f) => f.includes('.meta.json'))).toEqual([])
    const manifest = JSON.parse(extractFile(asar, 'package.json').toString('utf8')) as { version: string; main: string }
    expect(manifest.version).toBe(version())
    expect(manifest.main).toBe('dist/main.cjs')

    expect(existsSync(join(resources, 'server', 'server.mjs'))).toBe(true)
    expect(existsSync(join(resources, 'server', 'web', 'index.html'))).toBe(true)
    expect(existsSync(join(resources, 'app'))).toBe(false)
    const notices = readFileSync(join(resources, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    for (const name of [/^hono \d/m, /^chokidar \d/m, /^react \d/m, /^Geist\b/m, /^Geist Mono\b/m]) expect(notices).toMatch(name)
  })

  test(
    "per-user install with the app's identity",
    async () => {
      await silentInstall(installer(), place)
      expect(existsSync(exe())).toBe(true)

      const state = await machineState()
      expect(state.uninstallKeys.filter((k) => k.startsWith('HKEY_LOCAL_MACHINE'))).toEqual([])
      expect(state.uninstallKeys.filter((k) => k.startsWith('HKEY_CURRENT_USER'))).toHaveLength(1)
      expect(state.apps).toEqual([])
      expect(state.startMenu.map((p) => p.split('\\').pop())).toEqual([`${APP_NAME}.lnk`])
      expect(state.runValue).toBeNull()
      expect(existsSync(join(homedir(), 'Desktop', `${APP_NAME}.lnk`))).toBe(false)

      // The shortcut's own AppID, and then what the Start menu's index lists for that AppID.
      expect(powershell(`(New-Object -ComObject Shell.Application).Namespace('${PROGRAMS}').ParseName('${APP_NAME}.lnk').ExtendedProperty('System.AppUserModel.ID')`)).toBe(APP_ID)
      let listed = ''
      await until(
        'the Start-menu entry in Get-StartApps',
        () => {
          listed = powershell(`(Get-StartApps | Where-Object AppID -eq '${APP_ID}').Name`)
          return listed !== ''
        },
        60_000,
      )
      if (existsSync(DEV_SHORTCUT)) console.log(`${DEV_SHORTCUT} has this AppID too, so Get-StartApps lists: ${listed}`)
      else expect(listed).toBe(APP_NAME)
    },
    RUN_MS,
  )

  test(
    'an install over an install keeps the login item',
    async () => {
      spawnSync(join(SYS32, 'reg.exe'), ['add', RUN_KEY, '/v', APP_ID, '/t', 'REG_SZ', '/d', `"${exe()}" --hidden`, '/f'], { windowsHide: true })
      expect(await runValue()).toContain('--hidden')
      await silentInstall(installer(), place)
      expect(existsSync(exe())).toBe(true)
      expect(await runValue()).toContain('--hidden')
      expect((await machineState()).startMenu).toHaveLength(1)
    },
    RUN_MS,
  )

  test(
    'installed app runs',
    async () => {
      const app = await launch(place)
      appPid = app.pid
      appOutput = app.output
      await waitForHealth(place)

      const page = await fetch(`${base()}/`)
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('<title>')
      expect(html).toMatch(META)
      expect(await (await fetch(`${base()}/api/health`)).json()).toEqual({ ok: true })
      await until('the window', () => !['', '0'].includes(mainWindow(app.pid)), 30_000, app.output)

      // Add repo, as the page does. The file lands in the temp folder.
      const added = await fetch(`${base()}/api/repos`, {
        method: 'POST',
        headers: { Origin: base(), 'Content-Type': 'application/json', 'X-Open-AFlow-Token': await tokenOf() },
        body: JSON.stringify({ path: repo }),
      })
      expect(added.status, await added.clone().text()).toBe(201)
      const config = JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) as { repos: { path: string }[] }
      expect(config.repos.map((r) => r.path)).toEqual([repo])
      expect(readdirSync(place.env.OPEN_AFLOW_DESKTOP_DATA_DIR!).length).toBeGreaterThan(0)

      await stopApp()
    },
    RUN_MS,
  )

  test(
    'login start stays in the tray',
    async () => {
      const app = await launch(place, ['--hidden'])
      appPid = app.pid
      appOutput = app.output
      await waitForHealth(place)
      // The first ready opens a window on a normal start, within the time the test above allows it.
      for (let i = 0; i < 5; i++) {
        await sleep(1000)
        expect(mainWindow(app.pid)).toBe('0')
      }
    },
    RUN_MS,
  )

  test(
    'installed app sends a toast',
    async () => {
      // The hidden app keeps running. Its first Board is the baseline, so wait for the board before the new line.
      await until('the repo on the Board', async () => {
        const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: unknown[] }
        return board.repos.length === 1
      })
      await sleep(5000)
      const sent = () => appOutput().split(TOAST_LINE).length - 1
      const start = sent()
      appendFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '- `[2026-11-03 · BLOCKED · orchestrator → human · plan: three-sprints]` gate 1 (blocked-concern): a new line from the install proof. **Resolution:** pending\n')
      await until('one toast', () => sent() > start, 60_000, appOutput)
      await sleep(3000)
      expect(sent() - start).toBe(1)
      expect(appOutput()).not.toContain('a new line from the install proof')
    },
    RUN_MS,
  )

  test(
    'uninstall keeps config and runs',
    async () => {
      // A real resume through the route, from the running installed app.
      await until('the session on the Board', async () => {
        const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: { agents: { session: string }[] }[] }
        return board.repos.some((r) => r.agents.some((a) => a.session === 'sess-1'))
      })
      const board = (await (await fetch(`${base()}/api/board`)).json()) as { repos: { id: string }[] }
      const res = await fetch(`${base()}/api/actions/resume`, {
        method: 'POST',
        headers: { Origin: base(), 'Content-Type': 'application/json', 'X-Open-AFlow-Token': await tokenOf() },
        body: JSON.stringify({ repoId: board.repos[0]!.id, run: 'alpha', reply: 'continue' }),
      })
      expect(await res.json()).toMatchObject({ outcome: 'started' })
      expect(fakePids()).toHaveLength(1)
      const fake = fakePids()[0]!
      const listed = spawnSync(join(SYS32, 'tasklist.exe'), ['/FI', `PID eq ${fake}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      expect(listed.stdout.toLowerCase()).toContain('node.exe')

      const running = await machineState()
      expect(running.apps).toContain(appPid)
      expect(running.apps.length).toBeGreaterThan(1)
      const registryKey = running.uninstallKeys[0]!.split('\\').pop()!

      await silentUninstall(place)

      const after = await machineState()
      expect(after.apps).toEqual([])
      expect(alive(appPid)).toBe(false)
      appPid = 0
      expect(existsSync(place.installDir)).toBe(false)
      expect(after.uninstallKeys).toEqual([])
      expect(after.startMenu).toEqual([])
      expect(spawnSync(join(SYS32, 'reg.exe'), ['query', `HKCU\\Software\\${registryKey}`], { windowsHide: true }).status).not.toBe(0)
      await expect(fetch(`${base()}/api/health`)).rejects.toThrow()

      // The run lives through it, and so do the config and the shell's data.
      expect(alive(fake)).toBe(true)
      expect(existsSync(join(configDir(), 'config.json'))).toBe(true)
      expect(existsSync(join(configDir(), 'tool-paths.json'))).toBe(true)
      // The uninstaller ends the server by force, so its drain never ran. The next start's stale check takes this over.
      expect(existsSync(join(configDir(), 'auto-continue-owner.json'))).toBe(true)
      expect(readdirSync(place.env.OPEN_AFLOW_DESKTOP_DATA_DIR!).length).toBeGreaterThan(0)

      process.kill(fake)
      await until('the fake to end', () => !alive(fake))
    },
    RUN_MS,
  )

  test('uninstall removes the login item', async () => {
    expect(await runValue()).toBeNull()
  })

  test(
    'leaves nothing behind',
    async () => {
      await stopFakes()
      const diff = await finishProof(place, before!)
      finished = true
      expect(stateDiff(before!, await machineState())).toEqual([])
      expect(readdirSync(PROGRAMS)).toEqual(startMenuBefore)
      expect(diff).toEqual([])
      console.log(proofLastLine(diff))
    },
    RUN_MS,
  )
})
