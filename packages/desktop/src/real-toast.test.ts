import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bundleDesktop } from './bundle-desktop.ts'
import { LOG_FILE } from './shell-log.ts'
import { APP_ID } from './shell-config.ts'

// A click on a toast in the notification center, as Windows makes it: COM by the app's activator CLSID, then
// INotificationActivationCallback.Activate. No toast shows on the desktop. Temp folders only. The one registry
// key Electron writes for this run is deleted at the end. `pnpm test:electron` runs this after `pnpm build`.

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const SERVER_BUNDLE = join(DESKTOP, '..', 'server', 'dist', 'app', 'server.mjs')
const WINDIR = process.env.SystemRoot ?? 'C:\\Windows'
const CSC = join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const START_MENU = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const BOOT_MS = 60_000

const CLIENT = `
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotificationActivationCallback {
  [PreserveSig] int Activate([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, IntPtr data, uint count);
}
class P {
  [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid c, IntPtr o, uint ctx, ref Guid i, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  [STAThread] static int Main(string[] a) {
    Guid c = new Guid(a[0]); Guid i = typeof(INotificationActivationCallback).GUID; object o;
    int hr = CoCreateInstance(ref c, IntPtr.Zero, 4, ref i, out o);
    if (hr != 0) return 1;
    return ((INotificationActivationCallback)o).Activate(a[1], a[2], IntPtr.Zero, 0) == 0 ? 0 : 2;
  }
}`

type Status = { readyPorts: number[]; hashes: (string | null)[]; clsid?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (what: string, ok: () => boolean, ms: number, extra: () => string) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${extra()}`)
    await sleep(100)
  }
}
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
const removeWithRetry = async (path: string) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      if (tries >= 200 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      await sleep(50)
    }
  }
}
const POWERSHELL = join(WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const mainWindow = (pid: number) => spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).MainWindowHandle`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
const INSTALLED_LNK = join(START_MENU, 'Open AFlow.lnk')
const DEV_LNK = join(START_MENU, 'Electron.lnk')
const stamp = (file: string) => (existsSync(file) ? statSync(file).mtimeMs : 'none')

describe.runIf(process.env.POD_BOARD_REAL_ELECTRON === '1' && process.platform === 'win32')('a toast click from the notification center', () => {
  let tmp: string
  let client: string
  let shell: ChildProcess | undefined
  let text = ''
  const statusFile = () => join(tmp, 'status.json')
  const status = (): Status | undefined => {
    try {
      return JSON.parse(readFileSync(statusFile(), 'utf8')) as Status
    } catch {
      return undefined
    }
  }
  const details = () => `status: ${JSON.stringify(status())}\noutput: ${text}`
  const activate = (clsid: string, args: string) =>
    new Promise<number | null>((resolve) => {
      const c = spawn(client, [clsid, APP_ID, args], { stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => c.kill(), 20_000)
      c.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })

  beforeAll(async () => {
    if (!existsSync(SERVER_BUNDLE)) throw new Error(`no server bundle at ${SERVER_BUNDLE}: run pnpm build first`)
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-real-toast-')))
    writeFileSync(join(tmp, 'activate.cs'), CLIENT)
    client = join(tmp, 'activate.exe')
    const built = spawnSync(CSC, ['-nologo', `-out:${client}`, join(tmp, 'activate.cs')], { encoding: 'utf8', windowsHide: true })
    if (built.status !== 0) throw new Error(`csc failed: ${built.stdout}`)
    await bundleDesktop({ entry: join(DESKTOP, 'test', 'probe-main.ts'), outfile: join(tmp, 'probe.cjs') })
  }, 120_000)

  afterAll(async () => {
    if (tmp) await removeWithRetry(tmp)
  })

  test('opens the window on the run, also with the toast long gone', async () => {
    const installedBefore = stamp(INSTALLED_LNK)
    const devLnkBefore = existsSync(DEV_LNK)
    const exe = createRequire(join(DESKTOP, 'package.json'))('electron') as string
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      const u = k.toUpperCase()
      if (!u.startsWith('POD_BOARD_') && !u.startsWith('CLAUDE') && !u.startsWith('ELECTRON_') && !u.startsWith('VITEST') && !['NODE_PATH', 'NODE_OPTIONS'].includes(u)) env[k] = v
    }
    mkdirSync(join(tmp, 'cfg'))
    const data = join(tmp, 'shell')
    shell = spawn(exe, [join(tmp, 'probe.cjs')], {
      cwd: tmp,
      env: {
        ...env,
        POD_BOARD_API_PORT: String(await freePort()),
        POD_BOARD_CONFIG_DIR: join(tmp, 'cfg'),
        POD_BOARD_PORTS_DIR: join(tmp, 'ports'),
        POD_BOARD_CLAUDE_DIR: join(tmp, 'claude'),
        POD_BOARD_CLAUDE_BIN: join(tmp, 'missing', 'claude'),
        POD_BOARD_DESKTOP_DATA_DIR: data,
        POD_BOARD_PROBE_APP_PATH: DESKTOP,
        POD_BOARD_PROBE_ACTIVATOR: '1',
        POD_BOARD_PROBE_STATUS: statusFile(),
        POD_BOARD_PROBE_QUIT: join(tmp, 'quit'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Not hidden: SW_HIDE would swallow the window's first show.
      windowsHide: false,
    })
    shell.stdout!.on('data', (d) => (text += String(d)))
    shell.stderr!.on('data', (d) => (text += String(d)))
    let clsid: string | undefined
    try {
      await until('ready', () => (status()?.readyPorts.length ?? 0) >= 1 && status()?.clsid !== undefined, BOOT_MS, details)
      clsid = status()!.clsid!

      // An activator registered at the start must leave the normal start alone: the window comes up.
      const pid = shell.pid!
      await until('the window', () => !['', '0'].includes(mainWindow(pid)), 30_000, details)

      // No toast ever showed in this run, as after a restart with old toasts still in the center.
      expect(await activate(clsid, 'pod-board-toast:#/repo%20x/fix-a')).toBe(0)
      await until('the run from the toast', () => status()?.hashes.includes('#/repo%20x/fix-a') === true, 15_000, details)

      // A toast from a version before this one has no run in it: the window still opens.
      expect(await activate(clsid, '')).toBe(0)
      await until('the window with no run', () => status()?.hashes.includes(null) === true, 15_000, details)
      expect(status()!.hashes.length).toBe(2)

      writeFileSync(join(tmp, 'quit'), '')
      const c = shell
      await new Promise<void>((resolve) => (c.exitCode !== null ? resolve() : c.once('exit', () => resolve())))

      // The log file sits in the temp data folder, and holds no token.
      const log = readFileSync(join(data, LOG_FILE), 'utf8')
      expect(log).toContain('pod-board API listening on http://127.0.0.1:')
      expect(log).not.toMatch(/token/i)
      // Its config line names a temp folder under the home folder.
      expect(log).toMatch(/pod-board config: ~[\\/]/)
      expect(log.toLowerCase()).not.toContain(homedir().toLowerCase())
      // A dev run never touches a real install's shortcut, which holds its activator.
      expect(stamp(INSTALLED_LNK)).toBe(installedBefore)
    } finally {
      if (shell && shell.exitCode === null) shell.kill()
      if (clsid) spawnSync('reg', ['delete', `HKCU\\Software\\Classes\\CLSID\\${clsid}`, '/f'], { windowsHide: true })
      // Electron's shortcut for this dev run. Two shortcuts with one AppID would confuse Windows.
      if (!devLnkBefore) rmSync(DEV_LNK, { force: true })
    }
  }, 180_000)
})
