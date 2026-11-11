// SPIKE ONLY. Runs the terminal-host spike checks against the real Electron app with Playwright's _electron.
// `node spike/checks.mjs [check ...]` after `npx tsx spike/bundle.ts` and `pnpm build`. Prints PASS/FAIL per
// check and writes results to $SPIKE_OUT/results.json. Every kill is by a PID this script or the app recorded,
// or by the unique marker of a process this script started.

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const ELECTRON = process.env.SPIKE_ELECTRON ?? join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron')
const MAIN = process.env.SPIKE_MAIN ?? join(DESKTOP, 'dist-spike', 'spike-main.cjs')
const PACKAGED = process.env.SPIKE_PACKAGED === '1'
const ROOT = process.env.SPIKE_TMP ?? tmpdir()
const OUT = process.env.SPIKE_OUT ?? mkdtempSync(join(ROOT, 'spike-out-'))
const REAL_CLAUDE = process.env.SPIKE_REAL_CLAUDE ?? join(homedir(), '.local', 'bin', 'claude')
const REAL_ARGS = JSON.parse(process.env.SPIKE_REAL_ARGS ?? '["--model","haiku"]')
const PLUGIN = join(here, 'plugin')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = existsSync(join(OUT, 'results.json')) ? JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')) : {}
const note = (check, key, value) => {
  results[check] = results[check] ?? { pass: null, notes: {} }
  results[check].notes[key] = value
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`  [${check}] ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}
const verdict = (check, pass, why) => {
  results[check] = results[check] ?? { pass: null, notes: {} }
  results[check].pass = pass
  results[check].why = why
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`${pass ? 'PASS' : 'FAIL'} ${check}: ${why}`)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const kill = (pid, sig = 'SIGKILL') => {
  try {
    process.kill(pid, sig)
  } catch {}
}
const pgrep = (marker) => {
  const r = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' })
  return r.stdout.split('\n').filter(Boolean).map(Number)
}
const portOpen = (port) =>
  new Promise((r) => {
    const s = createConnection({ port, host: '127.0.0.1' })
    s.once('connect', () => (s.destroy(), r(true)))
    s.once('error', () => r(false))
  })
const ssListening = (port) => spawnSync('ss', ['-ltnp'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`:${port} `))
const waitFor = async (fn, ms, step = 250) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  return await fn()
}
let portSeq = 47000 + Math.floor(Math.random() * 2000)

/** A fresh temp world: config, data, ports, claude dir, a scratch git repo, and a fake `claude` wrapper. */
function world(name, o = {}) {
  const T = mkdtempSync(join(ROOT, `spike-${name}-`))
  for (const d of ['config', 'data', 'ports', 'claude', 'hooks', 'bin']) mkdirSync(join(T, d), { recursive: true })
  const repo = o.repo ?? join(T, 'repo')
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', repo])
  }
  const fake = join(T, 'bin', 'claude')
  writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${join(here, 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 })
  return { T, repo, fake, record: join(T, 'fake-record.jsonl'), hooks: join(T, 'hooks') }
}

const baseEnv = () => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (/^(CLAUDE|ANTHROPIC_)/i.test(k)) delete e[k]
  return e
}

async function launch(w, extra = {}) {
  const env = {
    ...baseEnv(),
    OPENAFLOW_TEST: '1',
    OPENAFLOW_CONFIG_DIR: join(w.T, 'config'),
    OPENAFLOW_DESKTOP_DATA_DIR: join(w.T, 'data'),
    OPENAFLOW_PORTS_DIR: join(w.T, 'ports'),
    OPENAFLOW_CLAUDE_DIR: join(w.T, 'claude'),
    OPENAFLOW_SPIKE_REPO: w.repo,
    OPENAFLOW_SPIKE_CLAUDE: w.fake,
    OPENAFLOW_SPIKE_HOOKLOG: w.hooks,
    FAKE_RECORD: w.record,
    ...extra,
  }
  const app = await _electron.launch({ executablePath: ELECTRON, args: PACKAGED ? [] : [MAIN], env, timeout: 60_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  const pid = app.process().pid
  const exited = new Promise((r) => app.process().once('exit', (code, sig) => r({ code, sig })))
  return { app, page, pid, exited }
}
const sp = (a, name, ...args) => a.app.evaluate(async (_e, [n, xs]) => await globalThis.__spike[n](...xs), [name, args])
const pageLines = (page) => page.evaluate(() => window.__bufferLines())

/** Numbers from `line N` rows: pass when they are 1..max, each once, in order. */
function contiguity(lines) {
  const nums = lines.map((l) => /^line (\d+)$/.exec(l.trim())?.[1]).filter(Boolean).map(Number)
  const bad = []
  for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) bad.push({ at: i, got: nums[i], want: i + 1 })
  return { count: nums.length, max: nums[nums.length - 1] ?? 0, ok: nums.length > 0 && bad.length === 0, bad: bad.slice(0, 5) }
}

async function close(a) {
  try {
    await a.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await a.app.evaluate(({ app }) => app.quit())
  } catch {}
  await Promise.race([a.exited, sleep(15_000)])
  if (alive(a.pid)) kill(a.pid)
}

// ---------------------------------------------------------------- checks

const checks = {}

checks['2-window-life'] = async () => {
  const c = '2-window-life'
  const w = world('c2')
  const a = await launch(w, { FAKE_INTERVAL_MS: '200' })
  try {
    const run = await sp(a, 'startRun')
    await sleep(3000)
    const steps = {}
    await sp(a, 'hideWindow')
    await sleep(10_000)
    await sp(a, 'showWindow')
    await sleep(1500)
    steps.reopen = contiguity(await pageLines(a.page))
    await sp(a, 'reloadWindow')
    await a.page.waitForLoadState('domcontentloaded')
    await sleep(2500)
    steps.reload = contiguity(await pageLines(a.page))
    await sp(a, 'destroyWindow')
    await sleep(3000)
    const next = a.app.waitForEvent('window')
    await sp(a, 'showWindow')
    const page2 = await next
    await page2.waitForLoadState('domcontentloaded')
    await sleep(2500)
    steps.recreate = contiguity(await pageLines(page2))
    steps.host = contiguity(await sp(a, 'hostBuffer', run.termId))
    steps.replays = await page2.evaluate(() => window.__state().replayed)
    note(c, 'steps', steps)
    const ok = ['reopen', 'reload', 'recreate', 'host'].every((k) => steps[k].ok)
    verdict(c, ok, ok ? `every number once and in order after reopen, reload, and a new window (last ${steps.recreate.max})` : 'gap or duplicate, see notes')
  } finally {
    await close(a)
  }
}

checks['3-server-life'] = async () => {
  const c = '3-server-life'
  const w = world('c3')
  const a = await launch(w, { FAKE_INTERVAL_MS: '200' })
  try {
    const run = await sp(a, 'startRun')
    await sleep(2000)
    const s0 = await waitFor(async () => {
      const s = await sp(a, 'status')
      return s.serverPort ? s : null
    }, 30_000)
    const health0 = await fetch(`http://127.0.0.1:${s0.serverPort}/api/health`).then((r) => r.status).catch((e) => String(e))
    note(c, 'before', { serverPid: s0.serverPids.at(-1), port: s0.serverPort, health: health0 })
    const before = contiguity(await pageLines(a.page))
    kill(s0.serverPids.at(-1))
    const s1 = await waitFor(async () => {
      const s = await sp(a, 'status')
      return s.serverPids.length > 1 && s.serverPort ? s : null
    }, 60_000)
    await sleep(2000)
    const after = contiguity(await pageLines(a.page))
    const health1 = s1 ? await fetch(`http://127.0.0.1:${s1.serverPort}/api/health`).then((r) => r.status).catch((e) => String(e)) : 'no restart'
    note(c, 'after', { serverPid: s1?.serverPids.at(-1), port: s1?.serverPort, health: health1, before, after })
    const ok = after.ok && after.max > before.max + 5 && health1 === 200
    verdict(c, ok, ok ? `server restarted (new pid, health 200); terminal kept going ${before.max} -> ${after.max} with no gap` : 'see notes')
  } finally {
    await close(a)
  }
}

async function quitCase(mode, extra = {}) {
  const c = '4-clean-quit'
  const w = world(`c4-${mode}`)
  const port = portSeq++
  const marker = `openaflow-spike-child-${mode}-${port}`
  const a = await launch(w, { FAKE_CHILD_PORT: String(port), FAKE_CHILD_MODE: mode, FAKE_MARKER: marker, ...extra })
  const r = {}
  try {
    const run = await sp(a, 'startRun')
    r.childUp = await waitFor(() => portOpen(port), 10_000)
    const st = await sp(a, 'status')
    const fakePid = st.runs[0].pid
    r.childPids = pgrep(marker)
    // Cancel first: the app and the run must live.
    await a.app.evaluate(({ dialog }) => {
      globalThis.__dialogCalls = []
      dialog.showMessageBox = async (...args) => {
        globalThis.__dialogCalls.push(args.at(-1))
        return { response: 1, checkboxChecked: false }
      }
    })
    await a.app.evaluate(({ app }) => app.quit())
    await sleep(2000)
    const calls = await a.app.evaluate(() => globalThis.__dialogCalls)
    r.dialog = calls[0] ? { message: calls[0].message, buttons: calls[0].buttons, defaultId: calls[0].defaultId, cancelId: calls[0].cancelId } : null
    r.afterCancel = { appAlive: alive(a.pid), fakeAlive: alive(fakePid), childUp: await portOpen(port), runLive: (await sp(a, 'status')).runs[0].stopReason === null }
    // Then quit and end runs.
    await a.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    const killedP = a.app.evaluate(({ app }) => app.quit()).catch(() => {})
    await Promise.race([a.exited, sleep(20_000)])
    await killedP
    await sleep(500)
    r.afterQuit = { appAlive: alive(a.pid), fakeAlive: alive(fakePid), pgrep: pgrep(marker), ss: ssListening(port), childUp: await portOpen(port) }
    const store = JSON.parse(readFileSync(join(w.T, 'config', 'spike', 'runs.json'), 'utf8'))
    r.stopReason = store.runs[0].stopReason
    r.mainLog = readFileSync(join(w.T, 'config', 'spike', 'main.log'), 'utf8').split('\n').filter((l) => l.includes('killAll'))
    const cancelOk = r.afterCancel.appAlive && r.afterCancel.fakeAlive && r.afterCancel.childUp && r.afterCancel.runLive
    const quitOk = !r.afterQuit.appAlive && !r.afterQuit.fakeAlive && r.afterQuit.pgrep.length === 0 && r.afterQuit.ss.length === 0
    r.pass = cancelOk && quitOk
    return r
  } finally {
    if (alive(a.pid)) await close(a)
    for (const pid of pgrep(marker)) kill(pid) // clean up a survivor we started
  }
}

checks['4-clean-quit'] = async () => {
  const c = '4-clean-quit'
  const out = {}
  for (const mode of ['detached', 'orphan', 'orphan-clean-env']) {
    out[mode] = await quitCase(mode)
    note(c, mode, out[mode])
  }
  out.scoped = await quitCase('orphan-clean-env', { OPENAFLOW_SPIKE_SCOPE: '1' })
  note(c, 'orphan-clean-env with a systemd scope', out.scoped)
  const ok = out.detached.pass && out.orphan.pass
  verdict(c, ok, `scope fix for the cleared env: ${out.scoped.pass ? 'clean' : 'LEFT'}; ` + `detached: ${out.detached.pass ? 'clean' : 'LEFT'}; orphan: ${out.orphan.pass ? 'clean' : 'LEFT'}; orphan with env cleared: ${out['orphan-clean-env'].pass ? 'clean' : 'LEFT (known gap)'}`)
}

checks['6-host-crash'] = async () => {
  const c = '6-host-crash'
  const w = world('c6')
  const a = await launch(w, { FAKE_INTERVAL_MS: '500' })
  try {
    const run = await sp(a, 'startRun')
    await sleep(11_500) // one screen save
    const s0 = await sp(a, 'status')
    const fakePid = s0.runs[0].pid
    kill(s0.hostPid)
    const s1 = await waitFor(async () => {
      const s = await sp(a, 'status')
      return s.hostStarts >= 2 && s.hostPid !== s0.hostPid && s.runs[0].stopReason ? s : null
    }, 15_000)
    await sleep(1000)
    const fakeAlive = alive(fakePid)
    note(c, 'after kill', { oldHost: s0.hostPid, newHost: s1?.hostPid, hostStarts: s1?.hostStarts, stopReason: s1?.runs[0].stopReason, fakeAlive })
    const screen = await pageLines(a.page)
    note(c, 'stopped screen tail', screen.slice(-2))
    const recBefore = readFileSync(w.record, 'utf8').trim().split('\n').length
    await sleep(3000)
    const recIdle = readFileSync(w.record, 'utf8').trim().split('\n').length
    await a.page.click(`button[data-resume="${run.runId}"]`)
    const resumed = await waitFor(() => {
      const lines = readFileSync(w.record, 'utf8').trim().split('\n')
      return lines.length > recIdle ? JSON.parse(lines.at(-1)) : null
    }, 10_000)
    await sleep(1500)
    const live = contiguity(await pageLines(a.page))
    note(c, 'resume', { argv: resumed?.argv, noAutoStart: recBefore === recIdle, liveAfterResume: live })
    const ok = s1 && s1.runs[0].stopReason === 'host crashed' && !fakeAlive && recBefore === recIdle && resumed?.argv[0] === '--resume' && resumed.argv[1] === run.sessionId && live.count > 0
    verdict(c, !!ok, ok ? 'host restarted; run read "host crashed"; claude ended; Resume started claude --resume <uuid>' : 'see notes')
  } finally {
    await close(a)
  }
}

checks['7-app-crash'] = async () => {
  const c = '7-app-crash'
  const w = world('c7')
  const port = portSeq++
  const marker = `openaflow-spike-child-crash-${port}`
  let a = await launch(w, { FAKE_INTERVAL_MS: '500', FAKE_CHILD_PORT: String(port), FAKE_CHILD_MODE: 'detached', FAKE_MARKER: marker })
  try {
    const run = await sp(a, 'startRun')
    await sleep(11_500)
    const s0 = await sp(a, 'status')
    const fakePid = s0.runs[0].pid
    kill(a.pid) // SIGKILL the Electron main process
    await Promise.race([a.exited, sleep(5000)])
    await sleep(3000)
    const leftAfterCrash = { host: alive(s0.hostPid), server: alive(s0.serverPids.at(-1)), fake: alive(fakePid), child: pgrep(marker) }
    note(c, 'left 3 s after SIGKILL of main', leftAfterCrash)
    const recBefore = readFileSync(w.record, 'utf8').trim().split('\n').length
    a = await launch(w, { FAKE_INTERVAL_MS: '500' })
    await sleep(4000)
    const s1 = await sp(a, 'status')
    const lines = await pageLines(a.page)
    const recAfter = readFileSync(w.record, 'utf8').trim().split('\n').length
    const after = { stopReason: s1.runs[0].stopReason, startupLeftovers: s1.startupLeftovers, savedScreenRows: lines.length, lastRow: lines.at(-1), fakeAlive: alive(fakePid), child: pgrep(marker), newClaudeStarted: recAfter !== recBefore }
    note(c, 'next start', after)
    const ok = after.stopReason === 'app closed' && !after.fakeAlive && after.child.length === 0 && !after.newClaudeStarted && after.savedScreenRows > 0
    verdict(c, ok, ok ? `run read "app closed" with its saved screen; nothing left running${leftAfterCrash.fake || leftAfterCrash.child.length ? ' (after the start sweep)' : ''}; nothing started by itself` : 'see notes')
  } finally {
    await close(a)
    for (const pid of pgrep(marker)) kill(pid)
  }
}

checks['8-memory'] = async () => {
  const c = '8-memory'
  const w = world('c8')
  const a = await launch(w, { FAKE_INTERVAL_MS: '0', FAKE_BURST: '6000' })
  try {
    const s0 = await sp(a, 'hostStats')
    const run = await sp(a, 'startRun')
    await waitFor(async () => (await sp(a, 'hostBuffer', run.termId))?.some((l) => l.startsWith('burst 6000')), 30_000)
    await sleep(2000)
    const buf = await sp(a, 'hostBuffer', run.termId)
    const s1 = await sp(a, 'hostStats')
    note(c, 'host memory', { idleVmRssKb: s0.vmRssKb, withRunVmRssKb: s1.vmRssKb, heapUsed: s1.heapUsed, bufferRows: buf.length, firstRow: buf[0]?.slice(0, 20) })
    verdict(c, true, `host VmRSS ${s0.vmRssKb} kB idle, ${s1.vmRssKb} kB holding ${buf.length} rows (scrollback 5,000 + screen)`)
  } finally {
    await close(a)
  }
}

checks['8-package'] = async () => {
  // Run with SPIKE_PACKAGED=1 SPIKE_ELECTRON=<packaged exe>: checks 1 (fake echo) and 4 on the packaged app.
  const c = '8-package'
  const w = world('c8p')
  const a = await launch(w, { FAKE_INTERVAL_MS: '300' })
  try {
    const run = await sp(a, 'startRun')
    await sleep(3000)
    const lines = await pageLines(a.page)
    note(c, 'packaged start', { rows: lines.length, first: lines[0], ptyHostOk: lines.some((l) => l.startsWith('fake-claude')) })
    verdict(c, lines.some((l) => l.startsWith('fake-claude')), 'node-pty loaded in the packaged app and the window shows the run')
  } finally {
    await close(a)
  }
  const q = await quitCase('detached')
  note(c, 'packaged quit', q)
}

// ---- real claude ----

const projectDir = (repo) => join(homedir(), '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
const transcript = (repo, id) => join(projectDir(repo), `${id}.jsonl`)
const userTurns = (file) => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'user' && typeof e.message?.content === 'string')
      .map((e) => e.message.content)
  } catch {
    return []
  }
}
const REAL_REPO = join(ROOT, 'spike-real-repo')

async function realLaunch(name, extra = {}) {
  const w = world(name, { repo: REAL_REPO })
  const a = await launch(w, { OPENAFLOW_SPIKE_CLAUDE: REAL_CLAUDE, ...extra })
  return { w, a }
}
const screenText = async (a, termId) => ((await sp(a, 'hostBuffer', termId)) ?? []).join('\n')
/** Waits for the input box; answers the folder-trust prompt once if it shows. */
async function waitReady(a, termId, c) {
  let trusted = false
  const ok = await waitFor(async () => {
    const t = await screenText(a, termId)
    if (!trusted && /trust/i.test(t) && /folder|files/i.test(t)) {
      note(c, 'trust prompt', t.split('\n').filter((l) => /trust|proceed|yes|no/i.test(l)).slice(0, 6))
      trusted = true
      await sp(a, 'write', termId, '\r')
      return false
    }
    return /❯|>\s*$|\? for shortcuts|bypass|accept edits|auto mode/i.test(t) && !/trust the files/i.test(t)
  }, 60_000, 1000)
  return ok
}
const typeLine = async (a, termId, text) => {
  await sp(a, 'write', termId, text)
  await sleep(500)
  await sp(a, 'write', termId, '\r')
}

checks['1-real-start'] = async () => {
  const c = '1-real-start'
  const { w, a } = await realLaunch('c1')
  try {
    const run = await sp(a, 'startRun', { extraArgs: REAL_ARGS })
    note(c, 'run', run)
    note(c, 'ready', await waitReady(a, run.termId, c))
    await typeLine(a, run.termId, 'Reply with the word PONG and nothing else.')
    const got = await waitFor(async () => /\bPONG\b/.test((await screenText(a, run.termId)).split('Reply with the word')[1] ?? ''), 90_000, 1000)
    const pageHas = (await pageLines(a.page)).some((l) => /\bPONG\b/.test(l) && !/Reply with/.test(l))
    note(c, 'transcript', { file: transcript(w.repo, run.sessionId), exists: existsSync(transcript(w.repo, run.sessionId)) })
    verdict(c, got && pageHas, got ? 'claude answered PONG in the hosted terminal (host buffer and window)' : 'no PONG')
  } finally {
    await close(a)
  }
}

checks['5-auto-continue'] = async () => {
  const c = '5-auto-continue'
  const { w, a } = await realLaunch('c5', { OPENAFLOW_SPIKE_TYPING_WAIT_MS: '8000' })
  try {
    const run = await sp(a, 'startRun', { extraArgs: [...REAL_ARGS, '--plugin-dir', PLUGIN, '--permission-mode', 'default'] })
    await waitReady(a, run.termId, c)
    note(c, 'gate before any turn', await sp(a, 'sendGate', run.runId))
    // a) A turn, then idle, then an automatic send.
    await typeLine(a, run.termId, 'Reply with the word READY and nothing else.')
    await waitFor(async () => (await sp(a, 'sendGate', run.runId)).lastEvent?.event === 'Stop', 90_000, 1000)
    note(c, 'gate after the turn (typing wait running)', await sp(a, 'sendGate', run.runId))
    const sa = await sp(a, 'requestSend', run.runId)
    note(c, 'a) request right after typing', sa)
    const sent = await waitFor(async () => userTurns(transcript(w.repo, run.sessionId)).includes('continue'), 60_000, 1000)
    note(c, 'a) transcript user turns', userTurns(transcript(w.repo, run.sessionId)))
    await waitFor(async () => (await sp(a, 'sendGate', run.runId)).lastEvent?.event === 'Stop', 90_000, 1000)
    // b) Text typed in the window with no Enter: the send must wait.
    await a.page.click('#term')
    await a.page.keyboard.type('half typed')
    const sb = await sp(a, 'requestSend', run.runId)
    await sleep(3000)
    const turnsB = userTurns(transcript(w.repo, run.sessionId))
    note(c, 'b) request with text in the box', { request: sb, sentWhileTyping: turnsB.filter((t) => t.includes('half typed')).length > 0 })
    await sleep(7000) // past the 8 s typing wait
    const gateB = await sp(a, 'sendGate', run.runId)
    note(c, 'b) gate after the typing wait, text still in the box', gateB)
    await sp(a, 'cancelSend', run.runId)
    const boxB = (await screenText(a, run.termId)).split('\n').filter((l) => l.includes('half typed'))
    note(c, 'b) screen line holding the text', boxB)
    // clear the box: Ctrl+U
    await sp(a, 'write', run.termId, '\u0015')
    await sleep(1000)
    // c) A permission dialog, left open more than 60 s.
    const evStart = (await sp(a, 'hookEvents')).length
    await typeLine(a, run.termId, 'Use the Bash tool to run exactly: touch spike-permission-test.txt')
    const dlg = await waitFor(async () => /Do you want|proceed\?|Yes, and don't ask/i.test(await screenText(a, run.termId)), 90_000, 1000)
    note(c, 'c) permission dialog on screen', dlg)
    await sp(a, 'requestSend', run.runId)
    await sleep(65_000)
    const evs = (await sp(a, 'hookEvents')).slice(evStart)
    const gateC = await sp(a, 'sendGate', run.runId)
    const turnsC = userTurns(transcript(w.repo, run.sessionId))
    const fileMade = existsSync(join(w.repo, 'spike-permission-test.txt'))
    note(c, 'c) hook events since the request', evs.map((e) => ({ event: e.event, tool: e.tool_name, type: e.notification_type, message: e.message })))
    note(c, 'c) after 65 s', { gate: gateC, sentDuringDialog: turnsC.filter((t) => t === 'continue').length > 1, fileMade })
    await sp(a, 'cancelSend', run.runId)
    await sp(a, 'write', run.termId, '\u001b') // Esc: decline
    await sleep(2000)
    const okA = sent
    const okB = !turnsB.some((t) => t.includes('half typed')) && sb.sent === false
    const okC = dlg && !gateC.ok && !fileMade && turnsC.filter((t) => t === 'continue').length === 1
    note(c, 'parts', { a: okA, b: okB, c: okC })
    verdict(c, okA && okB && okC, `a) send became a user turn: ${okA}; b) send waited while typing: ${okB}; c) no send during the permission dialog: ${okC}`)
  } finally {
    await close(a)
  }
}

checks['9-session-drift'] = async () => {
  const c = '9-session-drift'
  const { w, a } = await realLaunch('c9')
  try {
    const run = await sp(a, 'startRun', { extraArgs: [...REAL_ARGS, '--plugin-dir', PLUGIN] })
    await waitReady(a, run.termId, c)
    const filesBefore = new Set(existsSync(projectDir(w.repo)) ? readdirSync(projectDir(w.repo)) : [])
    await typeLine(a, run.termId, 'Reply with the word ALPHA and nothing else.')
    await waitFor(async () => (await sp(a, 'hookEvents')).some((e) => e.event === 'Stop' && e.session_id === run.sessionId), 90_000, 1000)
    const step1 = { started: run.sessionId, alphaIn: userTurns(transcript(w.repo, run.sessionId)).some((t) => t.includes('ALPHA')) }
    await typeLine(a, run.termId, '/clear')
    await sleep(4000)
    await typeLine(a, run.termId, 'Reply with the word BRAVO and nothing else.')
    await waitFor(async () => (await sp(a, 'hookEvents')).filter((e) => e.event === 'Stop').length >= 2, 90_000, 1000)
    const evs = await sp(a, 'hookEvents')
    const files = readdirSync(projectDir(w.repo)).filter((f) => f.endsWith('.jsonl'))
    const bravoFile = files.find((f) => userTurns(join(projectDir(w.repo), f)).some((t) => t.includes('BRAVO')))
    const step2 = { bravoFile, sameAsStart: bravoFile === `${run.sessionId}.jsonl`, sessionStarts: evs.filter((e) => e.event === 'SessionStart').map((e) => ({ id: e.session_id, source: e.source })) }
    await typeLine(a, run.termId, `/resume ${run.sessionId}`)
    await sleep(5000)
    const afterResumeScreen = (await screenText(a, run.termId)).split('\n').slice(-8)
    await typeLine(a, run.termId, 'Reply with the word CHARLIE and nothing else.')
    await waitFor(async () => (await sp(a, 'hookEvents')).filter((e) => e.event === 'Stop').length >= 3, 90_000, 1000)
    const evs3 = await sp(a, 'hookEvents')
    const files3 = readdirSync(projectDir(w.repo)).filter((f) => f.endsWith('.jsonl'))
    const charlieFile = files3.find((f) => userTurns(join(projectDir(w.repo), f)).some((t) => t.includes('CHARLIE')))
    const step3 = { charlieFile, backToStart: charlieFile === `${run.sessionId}.jsonl`, sessionStarts: evs3.filter((e) => e.event === 'SessionStart').map((e) => ({ id: e.session_id, source: e.source })), afterResumeScreen }
    note(c, 'steps', { step1, step2, step3, newFiles: files3.filter((f) => !filesBefore.has(f)) })
    note(c, 'hook events', evs3.map((e) => ({ event: e.event, id: e.session_id?.slice(0, 8), source: e.source })))
    verdict(c, true, `finding: /clear -> ${step2.sameAsStart ? 'same file' : 'new session file'}; /resume <id> -> ${step3.backToStart ? 'back to the first file' : 'another file'}; SessionStart hook carries the new id: ${step2.sessionStarts.length > 1}`)
  } finally {
    await close(a)
  }
}

checks['11-plugin'] = async () => {
  const c = '11-plugin'
  const { w, a } = await realLaunch('c11')
  try {
    const run = await sp(a, 'startRun', { extraArgs: [...REAL_ARGS, '--plugin-dir', PLUGIN] })
    await waitReady(a, run.termId, c)
    await typeLine(a, run.termId, '/openaflow-spike:hello')
    const inApp = await waitFor(async () => /SPIKE-SKILL-OK-7731/.test(await screenText(a, run.termId)), 90_000, 1000)
    note(c, 'in app', inApp)
  } finally {
    await close(a)
  }
  // Outside: plain claude in a pty of our own, same repo. No model turn: an unknown slash command answers locally.
  const pty = (await import('@lydell/node-pty')).default ?? (await import('@lydell/node-pty'))
  const env = baseEnv()
  const p = pty.spawn(REAL_CLAUDE, REAL_ARGS, { cwd: REAL_REPO, cols: 120, rows: 32, env, name: 'xterm-256color' })
  let out = ''
  p.onData((d) => (out += d))
  await waitFor(() => /for shortcuts|❯/.test(out), 30_000)
  p.write('/openaflow-spike:hello')
  await sleep(1500)
  const menu = out.slice(-2000)
  p.write('\r')
  await sleep(4000)
  const tail = out.slice(-3000).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  p.kill()
  const outside = { unknown: /unknown (skill|command)|not found|no such/i.test(tail), ranSkill: /SPIKE-SKILL-OK-7731/.test(tail), tail: tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6) }
  note(c, 'outside', outside)
  const inApp = results[c].notes['in app']
  verdict(c, inApp && !outside.ranSkill, `skill ran in the app: ${inApp}; outside: ${outside.ranSkill ? 'RAN (bad)' : 'absent'}`)
}

// ---------------------------------------------------------------- main

const wanted = process.argv.slice(2)
for (const name of wanted.length ? wanted : ['2-window-life', '3-server-life', '4-clean-quit', '6-host-crash', '7-app-crash', '8-memory']) {
  if (!checks[name]) {
    console.log(`unknown check ${name}`)
    continue
  }
  console.log(`--- ${name}`)
  const t = Date.now()
  try {
    await checks[name]()
  } catch (e) {
    verdict(name, false, `threw: ${e?.stack ?? e}`)
  }
  note(name, 'seconds', Math.round((Date.now() - t) / 1000))
}
console.log(`results: ${join(OUT, 'results.json')}`)
process.exit(0)
