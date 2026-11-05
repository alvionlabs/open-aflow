import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bundleApp } from './bundle-app.ts'

const WIN = process.platform === 'win32'
const META = /<meta name="pod-board-token" content="([^"]+)"/
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** On Windows a killed child's handles close a moment after it's gone, so try the removal again. */
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

describe.runIf(WIN)('the bundle with no terminal', () => {
  let root: string
  let child: ChildProcess | undefined

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'no-terminal-')))
    const web = join(root, 'web-dist')
    mkdirSync(web)
    writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>fake board</title></head><body></body></html>')
    await bundleApp({ webDist: web, outDir: join(root, 'out') })
  }, 60_000)

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child!.once('exit', resolve))
      child.kill()
      await gone
    }
    await removeWithRetry(root)
  })

  test(
    'the bundle finds tools with a stripped Path',
    async () => {
      const fakes = join(root, 'fakes')
      const cfg = join(root, 'cfg')
      mkdirSync(fakes)
      mkdirSync(cfg)
      const files = { git: join(fakes, 'git.exe'), gh: join(fakes, 'gh.exe'), claude: join(fakes, 'claude.cmd') }
      for (const file of Object.values(files)) writeFileSync(file, '')
      writeFileSync(join(cfg, 'tool-paths.json'), JSON.stringify(files))

      const env: NodeJS.ProcessEnv = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('POD_BOARD_') && !['PATH', 'NODE_PATH'].includes(k.toUpperCase())) env[k] = v
      }
      const port = await freePort()
      Object.assign(env, {
        Path: SYS32,
        POD_BOARD_API_PORT: String(port),
        POD_BOARD_CONFIG_DIR: cfg,
        POD_BOARD_PORTS_DIR: join(root, 'ports'),
        POD_BOARD_CLAUDE_DIR: join(root, 'claude'),
      })
      const c = spawn(process.execPath, [join(root, 'out', 'server.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      child = c
      let out = ''
      c.stdout!.on('data', (d) => (out += String(d)))
      c.stderr!.on('data', (d) => (out += String(d)))
      const end = Date.now() + 30_000
      while (!out.includes('listening on')) {
        if (Date.now() > end || c.exitCode !== null) throw new Error(`no listening line: ${out}`)
        await new Promise((r) => setTimeout(r, 50))
      }

      const base = `http://127.0.0.1:${port}`
      const token = META.exec(await (await fetch(`${base}/`)).text())?.[1] ?? ''
      expect(token).not.toBe('')
      const read = async () => {
        const res = await fetch(`${base}/api/tools`, { headers: { 'X-Pod-Board-Token': token } })
        return { status: res.status, text: await res.text() }
      }

      const first = await read()
      expect(first.status).toBe(200)
      expect(JSON.parse(first.text)).toEqual({
        tools: [
          { tool: 'git', state: 'found', path: files.git, source: 'settings' },
          { tool: 'gh', state: 'found', path: files.gh, source: 'settings' },
          { tool: 'claude', state: 'found', path: files.claude, source: 'settings' },
        ],
      })

      rmSync(files.gh)
      const second = await read()
      expect((JSON.parse(second.text) as { tools: unknown[] }).tools[1]).toEqual({ tool: 'gh', state: 'bad-path', path: files.gh, source: 'settings' })
    },
    90_000,
  )
})
