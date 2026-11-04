import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

/** The env value of `name`, matched in any case (Windows env names ignore case). */
export const envKey = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

export const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return isFile(file)
  } catch {
    return false
  }
}

/** On Windows, a drive path (`C:\x`); `\x` and `C:x` hang off the current drive or folder. */
export const isAbsoluteFor = (p: string, win: boolean): boolean => (win ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) : path.posix.isAbsolute(p))

/**
 * `env` made safe for a child started in a repo folder: PATH keeps only its absolute
 * entries, in order and under the key as spelled (Windows uses `Path`), so nothing the
 * child starts by a bare name resolves against the repo. On Windows it also sets
 * `NoDefaultCurrentDirectoryInExePath=1`, so cmd.exe and the child's own lookups skip the
 * current folder. Returns a new object; `env` is left alone.
 */
export function safeChildEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const win = platform === 'win32'
  const sep = win ? ';' : ':'
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() !== 'PATH') continue
    out[key] = (out[key] ?? '')
      .split(sep)
      .filter((dir) => dir !== '' && isAbsoluteFor(dir, win))
      .join(sep)
  }
  if (win) {
    const noCwd = Object.keys(out).find((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') ?? 'NoDefaultCurrentDirectoryInExePath'
    out[noCwd] = '1'
  }
  return out
}

/**
 * The absolute path of the file `bin` names. A bare name is looked up on the env's PATH,
 * in absolute entries only: an empty or relative entry (`.`, `bin`) would resolve against
 * a child's working folder, which is a repo the board doesn't control. The current folder
 * is never searched. A name with a folder in it resolves against the board's own folder.
 * On Windows only files with a PATHEXT extension count (or `opts.exts`), so npm's
 * extensionless sh shim is skipped for its `.cmd` twin.
 */
export function resolveBin(
  bin: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  opts: { exts?: readonly string[] } = {},
): string | undefined {
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  const exts = win
    ? (opts.exts ?? (envKey(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')).filter(Boolean).map((e) => e.toLowerCase())
    : []
  const hasExt = exts.includes(p.extname(bin).toLowerCase())
  const named = (base: string): string[] => (win ? [...(hasExt ? [base] : []), ...exts.map((e) => base + e)] : [base])
  const ok = win ? isFile : isExecutable

  const hasDir = bin.includes('/') || (win && bin.includes('\\'))
  if (hasDir) return named(p.resolve(bin)).find(ok)
  const dirs = (envKey(env, 'PATH') ?? '').split(win ? ';' : ':').filter((dir) => dir !== '' && isAbsoluteFor(dir, win))
  for (const dir of dirs) {
    const hit = named(p.join(dir, bin)).find(ok)
    if (hit) return hit
  }
  return undefined
}
