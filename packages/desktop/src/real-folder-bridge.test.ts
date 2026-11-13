import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bundleDesktop } from './bundle-desktop.ts'

// The folder bridge in real Electron: the real window, preload, and IPC. Only the native dialog is a stand-in
// (test/bridge-probe-main.ts), because automation can't answer it. Temp folders only. `pnpm test:electron` runs
// this after `pnpm build`.

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const SERVER_BUNDLE = join(DESKTOP, '..', 'server', 'dist', 'app', 'server.mjs')
const BOOT_MS = 60_000

type Status = {
  readyPorts: number[]
  failed?: string
  error?: string
  page?: {
    look: Record<string, unknown>
    picked: unknown
    two: unknown
    failed: unknown
    after: unknown
    subframe: unknown
    url: string
  }
  dialogCalls: { parentIsWindow: boolean; options: unknown }[]
}

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

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && process.platform === 'win32')('the folder bridge in real Electron', () => {
  let tmp: string
  let shell: ChildProcess | undefined
  let text = ''
  const status = (): Status | undefined => {
    try {
      return JSON.parse(readFileSync(join(tmp, 'status.json'), 'utf8')) as Status
    } catch {
      return undefined
    }
  }
  const details = () => `status: ${JSON.stringify(status())}\noutput: ${text}`

  beforeAll(async () => {
    if (!existsSync(SERVER_BUNDLE)) throw new Error(`no server bundle at ${SERVER_BUNDLE}: run pnpm build first`)
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-real-bridge-')))
    // window-main.ts looks for the preload beside the main bundle.
    await bundleDesktop({ entry: join(DESKTOP, 'test', 'bridge-probe-main.ts'), outfile: join(tmp, 'probe.cjs') })
    await bundleDesktop({ entry: join(DESKTOP, 'src', 'preload-main.ts'), outfile: join(tmp, 'preload.cjs') })
  }, 120_000)

  afterAll(async () => {
    if (shell && shell.exitCode === null) shell.kill()
    if (tmp) await removeWithRetry(tmp)
  })

  test('the page sees only pickFolder', async () => {
    const exe = createRequire(join(DESKTOP, 'package.json'))('electron') as string
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      const u = k.toUpperCase()
      if (!u.startsWith('OPENAFLOW_') && !u.startsWith('CLAUDE') && !u.startsWith('ELECTRON_') && !u.startsWith('VITEST') && !['NODE_PATH', 'NODE_OPTIONS'].includes(u)) env[k] = v
    }
    mkdirSync(join(tmp, 'cfg'))
    shell = spawn(exe, [join(tmp, 'probe.cjs')], {
      cwd: tmp,
      env: {
        ...env,
        OPENAFLOW_API_PORT: String(await freePort()),
        OPENAFLOW_CONFIG_DIR: join(tmp, 'cfg'),
        OPENAFLOW_PORTS_DIR: join(tmp, 'ports'),
        OPENAFLOW_CLAUDE_DIR: join(tmp, 'claude'),
        OPENAFLOW_CLAUDE_BIN: join(tmp, 'missing', 'claude'),
        OPENAFLOW_DESKTOP_DATA_DIR: join(tmp, 'shell'),
        OPENAFLOW_PROBE_APP_PATH: DESKTOP,
        OPENAFLOW_PROBE_STATUS: join(tmp, 'status.json'),
        OPENAFLOW_PROBE_QUIT: join(tmp, 'quit'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Not hidden: SW_HIDE would swallow the window's first show.
      windowsHide: false,
    })
    shell.stdout!.on('data', (d) => (text += String(d)))
    shell.stderr!.on('data', (d) => (text += String(d)))
    try {
      await until('the page checks', () => status()?.page !== undefined || status()?.error !== undefined || status()?.failed !== undefined, BOOT_MS, details)
      const s = status()!
      expect(s.error, details()).toBeUndefined()
      expect(s.failed, details()).toBeUndefined()
      const page = s.page!
      expect(new URL(page.url).origin).toBe(`http://127.0.0.1:${s.readyPorts[0]}`)

      // Exactly one function on the bridge, and no Node or Electron in the page.
      expect(page.look).toEqual({
        openaflow: 'object',
        keys: ['pickFolder'],
        pickFolder: 'function',
        require: 'undefined',
        process: 'undefined',
        module: 'undefined',
        electron: 'undefined',
        ipcRenderer: 'undefined',
      })

      // The real IPC path: the app window is the dialog's parent, with the contract's options.
      expect(page.picked).toBe('C:\\probe\\repo')
      expect(s.dialogCalls[0]).toEqual({ parentIsWindow: true, options: { title: 'Add repo', properties: ['openDirectory'] } })
      // Two calls at once: one dialog, and the second call gets null.
      expect(page.two).toEqual(['C:\\probe\\repo', null])
      expect(page.failed).toBe('dialog failed')
      expect(page.after).toBe('C:\\probe\\repo')
      // path, the two at once (one dialog), the error, and the call after it.
      expect(s.dialogCalls.length).toBe(4)
      expect(s.dialogCalls.every((c) => c.parentIsWindow)).toBe(true)
      // An about:blank subframe gets no preload.
      expect(page.subframe).toBe('undefined')

      writeFileSync(join(tmp, 'quit'), '')
      const c = shell
      await new Promise<void>((resolve) => (c.exitCode !== null ? resolve() : c.once('exit', () => resolve())))
      // The dialog error reached the log.
      expect(text).toContain('the folder dialog failed: probe dialog error')
    } finally {
      if (shell && shell.exitCode === null) shell.kill()
    }
  }, 180_000)
})
