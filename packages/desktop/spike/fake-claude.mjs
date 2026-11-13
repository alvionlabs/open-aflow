#!/usr/bin/env node
// SPIKE ONLY. A fake `claude`: records argv, prints numbered lines, and can start a child HTTP server
// that tries to outlive it. Env: FAKE_RECORD (jsonl file), FAKE_INTERVAL_MS, FAKE_BURST (lines at start),
// FAKE_CHILD_PORT, FAKE_CHILD_MODE = detached | orphan | orphan-clean-env, FAKE_MARKER.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env
if (env.FAKE_RECORD) appendFileSync(env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, run: env.OPENAFLOW_RUN ?? null, at: Date.now() }) + '\n')
process.stdout.write(`fake-claude pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))}\r\n`)

const burst = Number(env.FAKE_BURST ?? 0)
for (let i = 1; i <= burst; i++) process.stdout.write(`burst ${i} ${'x'.repeat(60)}\r\n`)

if (env.FAKE_CHILD_PORT) {
  const server = join(dirname(fileURLToPath(import.meta.url)), 'fake-child-server.mjs')
  const marker = env.FAKE_MARKER ?? 'openaflow-spike-child'
  const mode = env.FAKE_CHILD_MODE ?? 'detached'
  const args = [server, env.FAKE_CHILD_PORT, marker]
  if (mode === 'detached') {
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else if (process.platform === 'win32') {
    if (mode === 'orphan') {
      // A detached go-between starts the server detached and exits: the server's parent ID then names a dead process.
      const js = `require('child_process').spawn(process.execPath, ${JSON.stringify(args)}, { detached: true, stdio: 'ignore', windowsHide: true }).unref()`
      spawn(process.execPath, ['-e', js], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (mode === 'new-console') {
      // `start` gives the server its own console window (minimized), as a user's `start npm run dev` would.
      spawn('cmd.exe', ['/d', '/c', 'start', '"dev"', '/min', process.execPath, ...args], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: false })
    } else if (mode === 'wmi') {
      // The escape case, like `env -i` on Linux: WMI starts the process. Its parent is WmiPrvSE, outside the job and the tree.
      const cmd = `"${process.execPath}" "${server}" ${env.FAKE_CHILD_PORT} ${marker}`.replace(/'/g, "''")
      const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmd}'; ProcessStartupInformation=$si} | Out-Null`
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
    }
  } else {
    // The shell starts the server in its own session and exits: the server is reparented away from us.
    const cmd = `${mode === 'orphan-clean-env' ? `env -i PATH=/usr/bin:/bin ` : ''}setsid '${process.execPath}' '${server}' ${env.FAKE_CHILD_PORT} ${marker} >/dev/null 2>&1 < /dev/null &`
    spawn('/bin/sh', ['-c', cmd], { stdio: 'ignore' })
  }
  process.stdout.write(`child server mode=${mode} port=${env.FAKE_CHILD_PORT}\r\n`)
}

let n = 0
const interval = Number(env.FAKE_INTERVAL_MS ?? 1000)
if (interval > 0) setInterval(() => process.stdout.write(`line ${++n}\r\n`), interval)
process.stdin.on('data', () => {})
