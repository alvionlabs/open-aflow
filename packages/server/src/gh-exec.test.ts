import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createFoundGhExec, createGhExec, createGhReader, ghBin } from './gh.ts'
import { createToolFinder } from './tool-finder.ts'

const WIN = process.platform === 'win32'
const SEP = WIN ? ';' : ':'
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

let tmp: string
const home = process.cwd()
let repo: string
let pathDir: string
let emptyDir: string

/**
 * A harmless stand-in for `gh` in `dir`. On Windows a copy of a system tool (`hostname.exe`
 * for the planted one, `whoami.exe` for the one on PATH); on POSIX a script that prints `says`.
 */
function plantGh(dir: string, says: 'planted' | 'from-path'): void {
  mkdirSync(dir, { recursive: true })
  if (WIN) {
    copyFileSync(join(SYS32, says === 'planted' ? 'hostname.exe' : 'whoami.exe'), join(dir, 'gh.exe'))
  } else {
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho ${says}\n`)
    chmodSync(join(dir, 'gh'), 0o755)
  }
}

/** What the PATH stand-in prints when it runs. */
const fromPathOutput = () => (WIN ? execFileSync(join(SYS32, 'whoami.exe'), { encoding: 'utf8' }).trim() : 'from-path')

/** The 8.3 short form of `file`, or `file` itself when the volume keeps no short name for it. */
const shortName = (file: string): string =>
  spawnSync(join(SYS32, 'cmd.exe'), ['/d', '/s', '/c', `for %I in ("${file}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()

/** The test process's env with PATH replaced (SystemRoot kept, which Windows tools need). */
const envWithPath = (...dirs: string[]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v
  return { ...env, PATH: dirs.join(SEP) }
}

beforeEach(() => {
  // The native form, because the temp folder can be an 8.3 short name (CI's is) and only it expands one.
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'gh-exec-')))
  repo = join(tmp, 'repo')
  pathDir = join(tmp, 'bin')
  emptyDir = join(tmp, 'empty')
  mkdirSync(emptyDir)
  // A cloned repo with its own gh at its root.
  plantGh(repo, 'planted')
  // Run from the temp folder, so a relative path to it is truly relative (not another drive).
  process.chdir(tmp)
})

afterEach(() => {
  process.chdir(home)
  rmSync(tmp, { recursive: true, force: true })
})

describe('gh exec', () => {
  test('a gh in the repo folder never runs, even with `.` or an empty entry on PATH', async () => {
    const exec = createGhExec(envWithPath('.', '', emptyDir))
    const r = await exec([], repo)
    expect(r.status).toBe('not-found')
  })

  test('runs the gh found on PATH, not the one in the repo folder', async () => {
    plantGh(pathDir, 'from-path')
    const exec = createGhExec(envWithPath('.', pathDir))
    const r = await exec([], repo)
    expect(r.status).toBe('ok')
    expect(r.stdout.trim()).toBe(fromPathOutput())
  })

  test('a gh installed after a not-found is picked up on the next call', async () => {
    const exec = createGhExec(envWithPath(pathDir))
    expect((await exec([], repo)).status).toBe('not-found')
    plantGh(pathDir, 'from-path')
    expect((await exec([], repo)).status).toBe('ok')
  })

  test('ghBin is an absolute path from an absolute PATH entry', () => {
    plantGh(pathDir, 'from-path')
    const rel = path.relative(process.cwd(), repo)
    expect(path.isAbsolute(rel)).toBe(false)
    expect(ghBin(envWithPath('.', rel, emptyDir))).toBeUndefined()
    const bin = ghBin(envWithPath('.', rel, pathDir))
    expect(bin).toBeDefined()
    expect(path.isAbsolute(bin!)).toBe(true)
    expect(path.dirname(bin!)).toBe(pathDir)
  })

  test("gh's own children get a PATH with no relative entries, and on Windows no current-folder search", async () => {
    // A stand-in that prints its env: a copy of cmd.exe (`/d /c set`), or a script running `env`.
    mkdirSync(pathDir)
    if (WIN) copyFileSync(join(SYS32, 'cmd.exe'), join(pathDir, 'gh.exe'))
    else {
      writeFileSync(join(pathDir, 'gh'), '#!/bin/sh\nenv\n')
      chmodSync(join(pathDir, 'gh'), 0o755)
    }
    const env = envWithPath('.', '', pathDir, 'rel-bin', SYS32)
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete env[k]
    const r = await createGhExec(env)(WIN ? ['/d', '/c', 'set'] : [], repo)
    expect(r.status).toBe('ok')
    const lines = r.stdout.split(/\r?\n/)
    const pathLine = lines.find((l) => /^PATH=/i.test(l))
    expect(pathLine?.slice(5)).toBe(WIN ? [pathDir, SYS32].join(SEP) : pathDir + SEP + SYS32)
    if (WIN) expect(lines).toContain('NoDefaultCurrentDirectoryInExePath=1')
  })

  test.runIf(WIN)('on Windows only gh.exe or gh.com count, as the old bare-name lookup did', () => {
    mkdirSync(pathDir)
    writeFileSync(join(pathDir, 'gh.bat'), '@echo off\r\n')
    writeFileSync(join(pathDir, 'gh.cmd'), '@echo off\r\n')
    expect(ghBin(envWithPath(pathDir))).toBeUndefined()
  })
})

describe.runIf(WIN)('gh from the finder', () => {
  /** A finder with an empty inherited Path, whose only way to anything is the fake registry. */
  const finderWith = (...regDirs: string[]) =>
    createToolFinder({
      env: { Path: '', SystemRoot: process.env.SystemRoot },
      platform: 'win32',
      settingsFile: join(tmp, 'tool-paths.json'),
      readRegistryPath: async (hive) => (hive === 'HKLM' ? `\r\nHKEY\r\n    Path    REG_SZ    ${regDirs.join(';')}\r\n` : ''),
    })

  test('gh runs from the finder with the merged Path', async () => {
    // A copy of where.exe as gh.exe finds a file through the child's Path, so it shows the registry folder got there.
    const toolDir = join(tmp, 'tool')
    const markerDir = join(tmp, 'markers')
    mkdirSync(toolDir)
    mkdirSync(markerDir)
    copyFileSync(join(SYS32, 'where.exe'), join(toolDir, 'gh.exe'))
    writeFileSync(join(markerDir, 'marker-file.txt'), '')
    const finder = finderWith(toolDir, markerDir)
    await finder.check()
    const r = await createFoundGhExec(finder)(['marker-file.txt'], emptyDir)
    expect(r.status).toBe('ok')
    expect(r.stdout.trim().toLowerCase()).toBe(join(markerDir, 'marker-file.txt').toLowerCase())
  })

  test.for(['path', 'registry'] as const)('a short-name folder from the %s still finds and runs gh', async (source, { skip }) => {
    const toolDir = join(tmp, 'tool-folder-with-a-long-name')
    const markerDir = join(tmp, 'marker-folder-with-a-long-name')
    mkdirSync(toolDir)
    mkdirSync(markerDir)
    copyFileSync(join(SYS32, 'where.exe'), join(toolDir, 'gh.exe'))
    writeFileSync(join(markerDir, 'marker-file.txt'), '')
    const shortTool = shortName(toolDir)
    const shortMarker = shortName(markerDir)
    if (shortTool === toolDir || shortMarker === markerDir) return skip('this volume keeps no 8.3 names')

    const finder = createToolFinder({
      env: { Path: source === 'path' ? [shortTool, shortMarker].join(SEP) : '', SystemRoot: process.env.SystemRoot },
      platform: 'win32',
      settingsFile: join(tmp, 'tool-paths.json'),
      readRegistryPath: async (hive) => (hive === 'HKLM' && source === 'registry' ? `
HKEY
    Path    REG_SZ    ${shortTool};${shortMarker}
` : ''),
    })
    await finder.check()
    expect(finder.states().find((s) => s.tool === 'gh')).toEqual({ tool: 'gh', state: 'found', path: join(shortTool, 'gh.exe'), source })

    const r = await createFoundGhExec(finder)(['marker-file.txt'], emptyDir)
    expect(r.status).toBe('ok')
    expect(realpathSync.native(r.stdout.trim())).toBe(join(markerDir, 'marker-file.txt'))
  })

  test('gh follows a recheck', async () => {
    mkdirSync(pathDir)
    const finder = finderWith(pathDir)
    await finder.check()
    const exec = createFoundGhExec(finder)
    expect((await exec([], emptyDir)).status).toBe('not-found')

    // Installed later: the file alone changes nothing until a check sees it, and no restart is needed.
    plantGh(pathDir, 'from-path')
    expect((await exec([], emptyDir)).status).toBe('not-found')
    await finder.check()
    const r = await exec([], emptyDir)
    expect(r.status).toBe('ok')
    expect(r.stdout.trim()).toBe(fromPathOutput())

    // Gone with no check in between: not-found, and no throw.
    rmSync(join(pathDir, 'gh.exe'))
    expect((await exec([], emptyDir)).status).toBe('not-found')
  })

  test('a recheck that finds gh ends a missing status with no 60 s wait', async () => {
    mkdirSync(pathDir)
    const finder = finderWith(pathDir)
    await finder.check()
    const now = 1000 // the clock stands still, so the 60 s cache never ends by itself
    const reader = createGhReader({ exec: createFoundGhExec(finder), ghFound: () => finder.path('gh') !== undefined, now: () => now })
    await reader.refresh(emptyDir, [])
    expect(reader.status()).toBe('missing')

    // Still not found: the cache holds, and nothing is asked again.
    const askedAt = reader.checkedAt()
    expect(await reader.refresh(emptyDir, [])).toBe(false)
    expect(reader.checkedAt()).toBe(askedAt)

    plantGh(pathDir, 'from-path')
    await finder.check()
    expect(await reader.refresh(emptyDir, [])).toBe(true)
    // It ran: the stand-in answers `auth status` with an error, which reads as logged out.
    expect(reader.status()).toBe('logged-out')
  })
})
