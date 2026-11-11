// SPIKE ONLY. Linux process helpers from /proc.
import { readdirSync, readFileSync } from 'node:fs'

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Every process's parent, from /proc. Linux only. */
export function parents(): Map<number, number> {
  const out = new Map<number, number>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      out.set(Number(name), Number(rest[1]))
    } catch {
      // gone
    }
  }
  return out
}

export function descendants(root: number): number[] {
  const kids = new Map<number, number[]>()
  for (const [pid, ppid] of parents()) kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  const out: number[] = []
  const queue = [root]
  while (queue.length) {
    const p = queue.shift()!
    for (const k of kids.get(p) ?? []) {
      out.push(k)
      queue.push(k)
    }
  }
  return out
}

/** Processes whose env holds OPENAFLOW_RUN=<runId>. Env is inherited unless a child clears it. */
export function markerPids(runId: string): number[] {
  const needle = `OPENAFLOW_RUN=${runId}\0`
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      if (readFileSync(`/proc/${name}/environ`, 'latin1').includes(needle)) out.push(Number(name))
    } catch {
      // another user's process, or gone
    }
  }
  return out
}

