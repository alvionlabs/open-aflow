import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { build } from 'esbuild'
import { BUNDLE_OPTIONS, bundleApp } from './bundle-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'model', 'fixtures', 'chess-web')
const WIN = process.platform === 'win32'
const BOOT_MS = 30_000
const RUN_MS = 60_000
const META = /<meta name="pod-board-token" content="([^"]+)"/

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

const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `pod-board-${name}-`)))

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const exitOf = (c: ChildProcess): Promise<number | null> =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve(c.exitCode)
    : new Promise((resolve) => c.once('exit', (code) => resolve(code)))

/** A small web build, enough to prove the layout and the answers. */
const writeFakeWeb = (dir: string) => {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>fake board</title></head><body></body></html>')
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log("app")')
}

let root: string // the shared build, made once: each run test copies it
let builtDir: string
let externalImports: string[]

beforeAll(async () => {
  root = tempDir('bundle')
  writeFakeWeb(join(root, 'web-dist'))
  builtDir = join(root, 'out')
  ;({ externalImports } = await bundleApp({ webDist: join(root, 'web-dist'), outDir: builtDir }))
}, RUN_MS)

afterAll(async () => {
  await removeWithRetry(root)
})

describe('bundleApp', () => {
  test('the bundle has no outside imports', () => {
    expect(existsSync(join(builtDir, 'server.mjs'))).toBe(true)
    const text = readFileSync(join(builtDir, 'server.mjs'), 'utf8')
    // The reported list is real: the server can't run on nothing. Its Node imports are listed, and so is the banner's.
    expect(externalImports).toContain('node:http')
    expect(externalImports).toContain('node:module')
    expect(externalImports.filter((name) => !isBuiltin(name))).toEqual([])
    // The file's own text agrees, including a require left in place for a CommonJS dependency.
    const named = [
      ...text.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm),
      ...text.matchAll(/\b(?:__require|require|import)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]!)
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((name) => !isBuiltin(name))).toEqual([])
    for (const name of named) expect(externalImports).toContain(name)
  })

  // No dependency needs this today, so the app's own bundle can't prove it: a fake one does.
  test("a CommonJS dependency's require of a builtin works", async () => {
    const dir = tempDir('bundle-cjs')
    try {
      writeFileSync(join(dir, 'dep.cjs'), "module.exports = require('node:os').EOL.length > 0 ? 'cjs ok' : 'no'")
      writeFileSync(join(dir, 'entry.mjs'), "import dep from './dep.cjs'\nconsole.log(dep)\n")
      const outfile = join(dir, 'out.mjs')
      await build({ ...BUNDLE_OPTIONS, entryPoints: [join(dir, 'entry.mjs')], outfile })
      const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8' })
      expect(run.stderr).toBe('')
      expect(run.stdout.trim()).toBe('cjs ok')
    } finally {
      await removeWithRetry(dir)
    }
  }, RUN_MS)

  test('the output layout holds no token', () => {
    expect(existsSync(builtDir)).toBe(true)
    expect(readdirSync(builtDir).sort()).toEqual(['server.mjs', 'web'])
    expect(existsSync(join(builtDir, 'web', 'assets', 'app-abc.js'))).toBe(true)
    const page = readFileSync(join(builtDir, 'web', 'index.html'), 'utf8')
    expect(page).toContain('fake board')
    expect(page).not.toContain('pod-board-token')
  })

  test('a build clears old output', async () => {
    const dir = tempDir('bundle-clear')
    try {
      const webDist = join(dir, 'web-dist')
      const outDir = join(dir, 'out')
      writeFakeWeb(webDist)
      writeFileSync(join(webDist, 'old.txt'), 'old')
      await bundleApp({ webDist, outDir })
      expect(existsSync(join(outDir, 'web', 'old.txt'))).toBe(true)
      writeFileSync(join(outDir, 'stray.txt'), 'stray')

      rmSync(join(webDist, 'old.txt'))
      await bundleApp({ webDist, outDir })
      expect(existsSync(join(outDir, 'server.mjs'))).toBe(true)
      expect(existsSync(join(outDir, 'web', 'old.txt'))).toBe(false)
      expect(existsSync(join(outDir, 'stray.txt'))).toBe(false)
    } finally {
      await removeWithRetry(dir)
    }
  }, RUN_MS)

  test('a missing web build fails', async () => {
    const dir = tempDir('bundle-missing')
    try {
      const webDist = join(dir, 'no-such-build')
      const outDir = join(dir, 'out')
      mkdirSync(outDir)
      writeFileSync(join(outDir, 'server.mjs'), 'earlier build')
      await expect(bundleApp({ webDist, outDir })).rejects.toThrow(webDist)
      // A failed check leaves the earlier build as it was.
      expect(readFileSync(join(outDir, 'server.mjs'), 'utf8')).toBe('earlier build')
    } finally {
      await removeWithRetry(dir)
    }
  })

  test('an output folder that overlaps the web build fails and removes nothing', async () => {
    const dir = tempDir('bundle-overlap')
    try {
      const webDist = join(dir, 'a', 'b')
      writeFakeWeb(webDist)
      for (const outDir of [webDist, join(dir, 'a'), join(webDist, 'app')]) {
        await expect(bundleApp({ webDist, outDir })).rejects.toThrow(webDist)
      }
      expect(existsSync(join(webDist, 'index.html'))).toBe(true)
    } finally {
      await removeWithRetry(dir)
    }
  })
})

describe('the bundle, run alone', () => {
  let tmp: string
  let child: ChildProcess | undefined

  beforeEach(() => {
    tmp = tempDir('bundle-run')
  })

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exitOf(child)
    }
    child = undefined
    await removeWithRetry(tmp)
  })

  /** Copies the build out of the repo and starts it from another folder, with only its own temp settings. */
  const spawnCopy = async (prepare?: (appDir: string) => void) => {
    expect(existsSync(join(builtDir, 'server.mjs'))).toBe(true)
    const appDir = join(tmp, 'app')
    cpSync(builtDir, appDir, { recursive: true })
    prepare?.(appDir)
    const cwd = join(tmp, 'cwd')
    const bin = join(tmp, 'empty-bin') // no gh and no claude: a run reaches nothing outside
    mkdirSync(cwd)
    mkdirSync(bin)
    // The finder also searches the registry and known folders, past the empty PATH. A settings path
    // wins over those searches, and one with no file means the tool isn't used, so this machine's real gh never runs.
    const cfg = join(tmp, 'fresh', 'cfg')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'tool-paths.json'), JSON.stringify({ git: join(tmp, 'missing', 'git.exe'), gh: join(tmp, 'missing', 'gh.exe') }))
    const port = await freePort()
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) {
      if (k.startsWith('POD_BOARD_') || /^(NODE_PATH|PATH)$/i.test(k)) delete env[k]
    }
    Object.assign(env, {
      PATH: bin,
      POD_BOARD_API_PORT: String(port),
      POD_BOARD_CONFIG_DIR: cfg,
      POD_BOARD_PORTS_DIR: join(tmp, 'ports'),
      POD_BOARD_CLAUDE_DIR: join(tmp, 'claude'),
      POD_BOARD_CLAUDE_BIN: join(tmp, 'missing', 'claude'),
    })
    const c = spawn(process.execPath, [join(appDir, 'server.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child = c
    let text = ''
    c.stdout!.on('data', (d) => (text += String(d)))
    c.stderr!.on('data', (d) => (text += String(d)))
    return { c, port, appDir, base: `http://127.0.0.1:${port}`, out: () => text }
  }

  /** Starts a copy and resolves once it logs its listening line. */
  const runCopy = async () => {
    const run = await spawnCopy()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line in ${BOOT_MS} ms:\n${run.out()}`)), BOOT_MS)
      const check = () => {
        if (!run.out().includes(`pod-board API listening on http://127.0.0.1:${run.port}`)) return
        clearTimeout(timer)
        resolve()
      }
      run.c.stdout!.on('data', check)
      run.c.stderr!.on('data', check)
      run.c.once('exit', () => {
        clearTimeout(timer)
        reject(new Error(`exited before listening:\n${run.out()}`))
      })
    })
    return run
  }

  const tokenOf = async (base: string) => {
    const token = META.exec(await (await fetch(`${base}/`)).text())?.[1]
    expect(token).toBeTruthy()
    return token!
  }

  const post = (base: string, path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        ...(token ? { 'X-Pod-Board-Token': token } : {}),
      },
      body: JSON.stringify(body),
    })

  test('runs alone outside the repo', async () => {
    const { base } = await runCopy()
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    const text = await page.text()
    expect(text).toMatch(META)
    expect(text).toContain('fake board')

    const route = await fetch(`${base}/some/page`)
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('fake board')

    const asset = await fetch(`${base}/assets/app-abc.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('console.log')

    for (const path of ['/sw.js', '/api/nope']) {
      const missing = await fetch(`${base}${path}`)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: 'not found' })
    }
  }, RUN_MS)

  test("the page's token works in the bundle", async () => {
    const { base } = await runCopy()
    const body = { repoId: 'x', number: 1 }

    const noToken = await post(base, '/api/actions/merge-preview', body)
    expect(noToken.status).toBe(403)
    expect(await noToken.json()).toEqual({ error: 'bad token' })

    const ok = await post(base, '/api/actions/merge-preview', body, await tokenOf(base))
    expect(ok.status).toBe(404)
    expect(await ok.json()).toEqual({ error: 'not waiting on you' })
  }, RUN_MS)

  test('a repo reaches the Board and live updates', async () => {
    const repo = join(tmp, 'chess-web')
    cpSync(FIXTURE, repo, { recursive: true })
    const { base } = await runCopy()
    const token = await tokenOf(base)

    const added = await post(base, '/api/repos', { path: repo }, token)
    expect(added.status).toBe(201)

    type Board = { repos: { model: { plans: { title: string }[] } | null }[] }
    const planTitles = (board: Board) => board.repos.flatMap((r) => r.model?.plans.map((p) => p.title) ?? [])

    const controller = new AbortController()
    try {
      const events = await fetch(`${base}/api/events`, { signal: controller.signal })
      expect(events.status).toBe(200)
      const reader = events.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      /** Reads board events until one passes `wanted`. The watcher sends within seconds, and the test's time limit ends a wait. */
      const nextBoard = async (wanted: (b: Board) => boolean): Promise<Board> => {
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (/^event: board$/m.test(block) && data) {
              const board = JSON.parse(data) as Board
              if (wanted(board)) return board
            }
            continue
          }
          const { done, value } = await reader.read()
          if (done) throw new Error('the event stream ended')
          buffer += decoder.decode(value, { stream: true })
        }
      }

      // The model parsed the copy's docs, so the bundled model works.
      const first = await nextBoard((b) => planTitles(b).length > 0)
      expect(planTitles(first)).toContain('Animated clock')

      // A new plan on disk reaches the stream, so the bundled chokidar works.
      writeFileSync(join(repo, 'pod-docs', 'plans', 'live-edit.md'), '# Plan: Live edit marker\n\n_Generated: 2026-11-02 · Status: active_\n')
      const second = await nextBoard((b) => planTitles(b).includes('Live edit marker'))
      expect(planTitles(second)).toContain('Live edit marker')
    } finally {
      controller.abort()
    }

    const board = (await (await fetch(`${base}/api/board`)).json()) as Board
    expect(planTitles(board)).toContain('Live edit marker')
  }, RUN_MS)

  test('the bundle writes no token file', async () => {
    const { base } = await runCopy()
    await tokenOf(base)
    // start-server.test.ts › production makes the config folder covers a folder that doesn't exist yet.
    expect(existsSync(join(tmp, 'fresh', 'cfg', 'session-token'))).toBe(false)
  }, RUN_MS)

  test('a missing web folder stops the bundle', async () => {
    const run = await spawnCopy((appDir) => rmSync(join(appDir, 'web'), { recursive: true }))
    const code = await new Promise<number | null>((resolve) => run.c.once('close', (n) => resolve(n)))
    expect(code).toBe(1)
    expect(run.out()).toContain('pod-board: ')
    expect(run.out()).toContain(join(run.appDir, 'web'))
    expect(run.out()).not.toContain('listening')
  }, RUN_MS)

  test.skipIf(WIN)('the bundle exits 0 on SIGTERM', async () => {
    const { c } = await runCopy()
    c.kill('SIGTERM')
    expect(await exitOf(c)).toBe(0)
  }, RUN_MS)
})
