// SPIKE ONLY. The pty host: a second Electron utilityProcess. It owns every pty and a headless xterm
// buffer per terminal. Main sends ops over parentPort; each window gets its own MessagePort per terminal.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { alive, descendants, markerPids } from './proc.ts'
import type { IPty } from '@lydell/node-pty'
// Packaged: main names node-pty's folder in resources/native, outside the asar. Unpackaged: normal lookup.
const { spawn: ptySpawn } = require(process.env.OPENAFLOW_PTY_PATH ?? '@lydell/node-pty') as typeof import('@lydell/node-pty')
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'

const SCROLLBACK = Number(process.env.OPENAFLOW_SPIKE_SCROLLBACK ?? 5000)
const HEARTBEAT_MS = 5000
const SCOPE = process.platform === 'linux' && process.env.OPENAFLOW_SPIKE_SCOPE === '1'
const KILL_WAIT_MS = 3000

type PortMain = {
  on(ev: 'message', fn: (e: { data: any }) => void): void
  on(ev: 'close', fn: () => void): void
  start(): void
  postMessage(m: unknown): void
  close(): void
}

type Term = {
  id: string
  runId: string
  pty: IPty
  pid: number
  head: Terminal
  ser: SerializeAddon
  ports: Set<PortMain>
  unit: string | undefined
  exited?: { exitCode: number; signal?: number }
}

const parent = (process as any).parentPort as {
  on(ev: 'message', fn: (e: { data: any; ports: PortMain[] }) => void): void
  postMessage(m: unknown): void
}
const terms = new Map<string, Term>()
const send = (m: unknown) => parent.postMessage(m)

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch {
    // gone
  }
}

/** Ends a terminal's process tree: snapshot first (tree + env marker), then SIGTERM, wait, SIGKILL. */
async function killTree(t: Term) {
  const byTree = descendants(t.pid)
  const byMarker = markerPids(t.runId)
  const byScope = t.unit ? scopePids(t.unit) : []
  const all = [...new Set([t.pid, ...byTree, ...byMarker, ...byScope])]
  // `systemctl stop` sends SIGTERM to every process in the cgroup, then SIGKILL after its timeout.
  if (t.unit) spawnSync('systemctl', ['--user', 'stop', t.unit], { timeout: KILL_WAIT_MS + 2000 })
  signal(-t.pid, 'SIGTERM') // the pty's session leader heads its own process group
  for (const pid of all) signal(pid, 'SIGTERM')
  const end = Date.now() + KILL_WAIT_MS
  while (Date.now() < end && all.some(alive)) await new Promise((r) => setTimeout(r, 100))
  const forced = all.filter(alive)
  for (const pid of forced) signal(pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  try {
    t.pty.kill()
  } catch {
    // closed
  }
  return { pid: t.pid, byTree, byMarker, byScope, forced, survivors: all.filter(alive) }
}

function scopePids(unit: string): number[] {
  const r = spawnSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', unit], { encoding: 'utf8' })
  const cg = r.stdout.trim()
  if (!cg) return []
  try {
    const uid = process.getuid?.()
    const base = readFileSync('/proc/self/cgroup', 'utf8').includes('0::') ? '/sys/fs/cgroup' : `/sys/fs/cgroup/unified`
    return readFileSync(`${base}${cg}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number).filter((x) => x !== uid)
  } catch {
    return []
  }
}

function bufferLines(head: Terminal): string[] {
  const b = head.buffer.active
  const out: string[] = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/** Waits until the headless parser has taken every chunk written so far. */
const flushed = (head: Terminal) => new Promise<void>((r) => head.write('', () => r()))

function create(m: { id: string; runId: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }) {
  const head = new Terminal({ cols: m.cols, rows: m.rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const ser = new SerializeAddon()
  head.loadAddon(ser as any)
  // Optional on Linux: each run in its own systemd user scope (a cgroup), so a quit can end every process in it.
  const unit = SCOPE ? `openaflow-run-${m.id}.scope` : undefined
  const [file, args] = unit ? ['systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`, m.file, ...m.args]] : [m.file, m.args]
  const p = ptySpawn(file, args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env })
  const t: Term = { id: m.id, runId: m.runId, unit, pty: p, pid: p.pid, head, ser, ports: new Set() }
  terms.set(m.id, t)
  p.onData((d) => {
    head.write(d)
    for (const port of t.ports) port.postMessage({ op: 'data', data: d })
  })
  p.onExit((e) => {
    t.exited = e
    for (const port of t.ports) port.postMessage({ op: 'exit', ...e })
    send({ op: 'exit', id: m.id, ...e })
  })
  send({ op: 'created', id: m.id, pid: p.pid })
}

function attach(id: string, port: PortMain) {
  const t = terms.get(id)
  if (!t) {
    port.postMessage({ op: 'gone' })
    port.close()
    return
  }
  port.on('message', (e) => {
    const d = e.data
    if (d?.op === 'write' && typeof d.data === 'string') {
      t.pty.write(d.data)
      send({ op: 'input', id, at: Date.now(), enter: d.data.includes('\r') })
    } else if (d?.op === 'resize') {
      t.pty.resize(d.cols, d.rows)
      t.head.resize(d.cols, d.rows)
    }
  })
  port.on('close', () => t.ports.delete(port))
  port.start()
  // Serialize and join in one tick after the flush: a chunk is either in the replay or sent live, never both.
  void flushed(t.head).then(() => {
    port.postMessage({ op: 'replay', data: t.ser.serialize(), exited: t.exited ?? null })
    t.ports.add(port)
  })
}

function vmRss(): number | undefined {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))
    return m ? Number(m[1]) : undefined
  } catch {
    return undefined
  }
}

async function call(m: any): Promise<unknown> {
  const t = m.id ? terms.get(m.id) : undefined
  switch (m.op) {
    case 'list':
      return [...terms.values()].map((x) => ({ id: x.id, runId: x.runId, pid: x.pid, exited: x.exited ?? null }))
    case 'buffer':
      if (!t) return null
      await flushed(t.head)
      return bufferLines(t.head)
    case 'serialize':
      if (!t) return null
      await flushed(t.head)
      return t.ser.serialize()
    case 'kill':
      return t ? await killTree(t) : null
    case 'killAll':
      return await Promise.all([...terms.values()].filter((x) => !x.exited).map(killTree))
    case 'stats':
      return { pid: process.pid, vmRssKb: vmRss(), heapUsed: process.memoryUsage().heapUsed, terms: terms.size }
    case 'markers':
      return markerPids(m.runId)
    default:
      return { error: `unknown op ${m.op}` }
  }
}

parent.on('message', (e) => {
  const m = e.data
  if (m?.op === 'create') create(m)
  else if (m?.op === 'write') terms.get(m.id)?.pty.write(m.data)
  else if (m?.op === 'resize') terms.get(m.id)?.pty.resize(m.cols, m.rows)
  else if (m?.op === 'attach' && e.ports[0]) attach(m.id, e.ports[0])
  else if (m?.reqId !== undefined)
    void call(m).then(
      (value) => send({ op: 'reply', reqId: m.reqId, value }),
      (err) => send({ op: 'reply', reqId: m.reqId, value: { error: String(err) } }),
    )
})

setInterval(() => send({ op: 'heartbeat', at: Date.now() }), HEARTBEAT_MS)
send({ op: 'ready', pid: process.pid })
