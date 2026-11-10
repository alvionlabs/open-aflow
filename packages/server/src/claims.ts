import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Claim } from '@openaflow/model'
import { envValue, type Env } from './config.ts'

/** A port claim pod writes while a run is live: `<ports dir>/<port base>` holding `<repo path> <plan>`. */
export type { Claim }

/** `OPENAFLOW_PORTS_DIR`, else `<os temp>/pod-ports`. */
export function portsDir(env: Env, tmp: string): string {
  return envValue(env, 'OPENAFLOW_PORTS_DIR') ?? path.join(tmp, 'pod-ports')
}

/** Absolute in either OS's style, whatever OS reads it: a claim may name a Windows path. */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/

/**
 * Reads one claim file. The name is the port base; the text is the repo path
 * (which may hold spaces) then the plan, as the last whitespace-separated
 * token. Anything else gives `undefined`.
 */
export function parseClaim(fileName: string, text: string): Claim | undefined {
  if (!/^[0-9]+$/.test(fileName)) return undefined
  const portBase = Number(fileName)
  if (portBase < 1 || portBase > 65535) return undefined
  const line = text.trim()
  if (/[\r\n]/.test(line)) return undefined
  const match = /^(.*\S)\s+(\S+)$/.exec(line)
  if (!match) return undefined
  const repoPath = match[1]!.trim()
  if (!ABSOLUTE.test(repoPath)) return undefined
  return { portBase, repoPath, plan: match[2]! }
}

/**
 * Every live claim in `dir`, sorted by port base. A missing folder gives `[]`;
 * unreadable or malformed files, and claims whose repo folder is gone, are left out.
 */
export async function readClaims(dir: string): Promise<Claim[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
  const claims = await Promise.all(names.map((name) => readClaim(dir, name)))
  return claims.filter((c): c is Claim => c !== undefined).sort((a, b) => a.portBase - b.portBase)
}

async function readClaim(dir: string, name: string): Promise<Claim | undefined> {
  if (!/^[0-9]+$/.test(name)) return undefined
  try {
    const claim = parseClaim(name, await readFile(path.join(dir, name), 'utf8'))
    if (!claim) return undefined
    return (await stat(claim.repoPath)).isDirectory() ? claim : undefined
  } catch {
    // A folder named like a port, a file removed mid-read, or a gone repo.
    return undefined
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
