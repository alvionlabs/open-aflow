import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createToolFinder, type Hive, type ToolName, type ToolState } from './tool-finder.ts'

// A pass-through spy, so a test can see which paths reached the file system.
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return { ...real, statSync: vi.fn(real.statSync) }
})

const WIN = process.platform === 'win32'
const home = process.cwd()
const ORDER: ToolName[] = ['git', 'gh', 'claude']

let root: string
let pathDir: string
let settingsFile: string
let userProfile: string
let appData: string
let localAppData: string
let programFiles: string
let programFilesX86: string

/** Empty files stand in for tools: the finder only checks that a file exists. */
const plant = (dir: string, ...names: string[]) => {
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, name), '')
}

/** A folder under the temp root. */
const folder = (name: string) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const envOf = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  Path: '',
  USERPROFILE: userProfile,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  ProgramFiles: programFiles,
  'ProgramFiles(x86)': programFilesX86,
  ...over,
})

/** The text `reg.exe query … /v Path` prints. */
const regText = (hive: Hive, value: string, type: 'REG_SZ' | 'REG_EXPAND_SZ' = 'REG_EXPAND_SZ') => {
  const key = hive === 'HKLM' ? 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' : 'HKEY_CURRENT_USER\\Environment'
  return `\r\n${key}\r\n    Path    ${type}    ${value}\r\n\r\n`
}

const noRegistry = async () => ''

const finderOf = (env: NodeJS.ProcessEnv = envOf(), readRegistryPath: (hive: Hive) => Promise<string> = noRegistry) =>
  createToolFinder({ env, platform: 'win32', settingsFile, readRegistryPath })

const stateOf = (states: ToolState[], tool: ToolName) => states.find((s) => s.tool === tool)
const writeSettings = (value: unknown) => writeFileSync(settingsFile, typeof value === 'string' ? value : JSON.stringify(value))

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tool-finder-')))
  pathDir = folder('on-path')
  settingsFile = join(folder('cfg'), 'tool-paths.json')
  userProfile = folder('profile')
  appData = folder('appdata')
  localAppData = folder('localappdata')
  programFiles = folder('pf')
  programFilesX86 = folder('pf86')
})

afterEach(() => {
  process.chdir(home)
  rmSync(root, { recursive: true, force: true })
  vi.mocked(statSync).mockClear()
})

describe.runIf(WIN)('createToolFinder', () => {
  test('finds tools on the inherited Path', async () => {
    plant(pathDir, 'git.exe', 'gh.exe', 'claude.cmd')
    const finder = finderOf(envOf({ Path: pathDir }))
    const states = await finder.check()
    expect(states).toEqual([
      { tool: 'git', state: 'found', path: join(pathDir, 'git.exe'), source: 'path' },
      { tool: 'gh', state: 'found', path: join(pathDir, 'gh.exe'), source: 'path' },
      { tool: 'claude', state: 'found', path: join(pathDir, 'claude.cmd'), source: 'path' },
    ])
    expect(finder.states()).toEqual(states)
    expect(finder.path('gh')).toBe(join(pathDir, 'gh.exe'))
  })

  test('finds tools through the registry Path', async () => {
    const regDir = folder('reg')
    plant(regDir, 'git.exe', 'gh.exe', 'claude.exe')
    const states = await finderOf(envOf(), async (hive) => (hive === 'HKLM' ? regText('HKLM', regDir) : '')).check()
    expect(states).toEqual(ORDER.map((tool) => ({ tool, state: 'found', path: join(regDir, `${tool}.exe`), source: 'registry' })))
  })

  test('finds tools in known folders', async () => {
    const cases: [ToolName, () => string][] = [
      ['git', () => join(programFiles, 'Git', 'cmd')],
      ['git', () => join(programFilesX86, 'Git', 'cmd')],
      ['git', () => join(localAppData, 'Programs', 'Git', 'cmd')],
      ['gh', () => join(programFiles, 'GitHub CLI')],
      ['gh', () => join(programFilesX86, 'GitHub CLI')],
      ['gh', () => join(localAppData, 'Programs', 'GitHub CLI')],
      ['gh', () => join(localAppData, 'Microsoft', 'WinGet', 'Links')],
      ['claude', () => join(userProfile, 'scoop', 'shims')],
      ['claude', () => join(userProfile, '.local', 'bin')],
      ['claude', () => join(userProfile, '.claude', 'local')],
      ['claude', () => join(appData, 'npm')],
    ]
    for (const [tool, dir] of cases) {
      const file = join(dir(), `${tool}.exe`)
      plant(dir(), `${tool}.exe`)
      expect(stateOf(await finderOf().check(), tool), file).toEqual({ tool, state: 'found', path: file, source: 'known' })
      rmSync(file)
    }

    // An unset variable skips its own folders and no others.
    plant(join(programFiles, 'GitHub CLI'), 'gh.exe')
    plant(join(appData, 'npm'), 'claude.cmd')
    const env = envOf()
    delete env.ProgramFiles
    const states = await finderOf(env).check()
    expect(stateOf(states, 'gh')?.state).toBe('missing')
    expect(stateOf(states, 'claude')?.state).toBe('found')
  })

  test('reports missing tools', async () => {
    const finder = finderOf()
    expect(await finder.check()).toEqual(ORDER.map((tool) => ({ tool, state: 'missing' })))
    for (const tool of ORDER) expect(finder.path(tool)).toBeUndefined()

    // With no variables at all, too.
    const bare = createToolFinder({ env: {}, platform: 'win32', settingsFile, readRegistryPath: noRegistry })
    expect(await bare.check()).toEqual(ORDER.map((tool) => ({ tool, state: 'missing' })))
  })

  test('never searches the current folder', async () => {
    const cwd = folder('cwd')
    const empty = folder('empty')
    plant(cwd, 'gh.exe', 'git.exe', 'claude.cmd')
    plant(join(cwd, 'rel'), 'gh.exe', 'git.exe', 'claude.cmd')
    process.chdir(cwd)
    const finder = finderOf(envOf({ Path: `.;;rel;.\\rel;${empty}` }), async () => regText('HKLM', '.;rel'))
    expect(await finder.check()).toEqual(ORDER.map((tool) => ({ tool, state: 'missing' })))
    expect(finder.env().Path).toBe(empty)
  })

  test('reads the registry Path', async () => {
    const machine = folder('machine')
    const user = folder('user')
    const expanded = folder('expanded')
    plant(machine, 'gh.exe')
    plant(user, 'gh.exe', 'claude.exe')
    plant(expanded, 'git.exe')

    // REG_SZ and REG_EXPAND_SZ both parse, and HKLM comes before HKCU.
    const finder = finderOf(envOf({ MyTools: expanded }), async (hive) =>
      hive === 'HKLM'
        ? regText('HKLM', `${machine};%NOPE%\\bin;rel\\bin;\\\\host\\share\\bin;//host/share`, 'REG_EXPAND_SZ')
        : regText('HKCU', `${user};%MYTOOLS%;%mytools%\\sub`, 'REG_SZ'),
    )
    const states = await finder.check()
    expect(stateOf(states, 'gh')).toEqual({ tool: 'gh', state: 'found', path: join(machine, 'gh.exe'), source: 'registry' })
    expect(stateOf(states, 'claude')).toEqual({ tool: 'claude', state: 'found', path: join(user, 'claude.exe'), source: 'registry' })
    expect(stateOf(states, 'git')).toEqual({ tool: 'git', state: 'found', path: join(expanded, 'git.exe'), source: 'registry' })

    // Unknown-variable, relative, and UNC entries are gone from the child Path too.
    expect(finder.env().Path).toBe([machine, user, expanded, join(expanded, 'sub')].join(';'))
  })

  test('a registry entry whose variable holds a semicolon is dropped', async () => {
    const finder = finderOf(envOf({ TRICK: `${pathDir};\\\\host\\share` }), async () => regText('HKLM', '%TRICK%'))
    await finder.check()
    expect(finder.env().Path).toBe('')
  })

  test('a failed registry read stops nothing', async () => {
    const good = folder('good')
    plant(good, 'gh.exe')
    const found = { tool: 'gh', state: 'found', path: join(good, 'gh.exe'), source: 'registry' }
    const finderWith = (readRegistryPath: (hive: Hive) => Promise<string>) =>
      createToolFinder({ env: envOf(), platform: 'win32', settingsFile, readRegistryPath, registryLimitMs: 20 })

    // One hive fails: by a rejection, or by never answering.
    const hang = () => new Promise<string>(() => {})
    const rejecting = async (): Promise<string> => {
      throw new Error('reg failed')
    }
    const oneBad = (bad: () => Promise<string>, goodHive: Hive) => async (hive: Hive) => (hive === goodHive ? regText(hive, good) : bad())
    for (const reader of [oneBad(rejecting, 'HKLM'), oneBad(rejecting, 'HKCU'), oneBad(hang, 'HKCU'), oneBad(hang, 'HKLM')]) {
      expect(stateOf(await finderWith(reader).check(), 'gh')).toEqual(found)
    }

    // Both fail, also by a throw before any promise: an empty result, and the check still ends.
    const throwing = (): Promise<string> => {
      throw new Error('no reg.exe')
    }
    for (const reader of [rejecting, hang, throwing]) {
      expect((await finderWith(reader).check()).map((s) => s.state)).toEqual(['missing', 'missing', 'missing'])
    }
  })

  test('registry text with no Path value reads as empty', async () => {
    for (const text of ['', 'ERROR: The system was unable to find the specified registry key or value.', '    Other    REG_SZ    C:\\x\r\n']) {
      const finder = finderOf(envOf(), async () => text)
      await finder.check()
      expect(finder.env().Path).toBe('')
    }
  })

  test('a path in settings wins', async () => {
    const chosen = folder('chosen')
    plant(chosen, 'gh.exe')
    plant(pathDir, 'gh.exe')
    const finder = finderOf(envOf({ Path: pathDir }))

    expect(await finder.setPath('gh', join(chosen, 'gh.exe'))).toMatchObject({ tools: expect.any(Array) })
    expect(stateOf(finder.states(), 'gh')).toEqual({ tool: 'gh', state: 'found', path: join(chosen, 'gh.exe'), source: 'settings' })

    // It goes away: bad-path, with no search, and the tool isn't used.
    rmSync(join(chosen, 'gh.exe'))
    expect(stateOf(await finder.check(), 'gh')).toEqual({ tool: 'gh', state: 'bad-path', path: join(chosen, 'gh.exe'), source: 'settings' })
    expect(finder.path('gh')).toBeUndefined()

    // Clearing it brings the search back.
    await finder.setPath('gh', null)
    expect(stateOf(finder.states(), 'gh')).toEqual({ tool: 'gh', state: 'found', path: join(pathDir, 'gh.exe'), source: 'path' })
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({})
  })

  test('the path rules also hold for a value edited into the file', async () => {
    const wrong = folder('wrong')
    plant(wrong, 'other.exe', 'gh.cmd')
    plant(pathDir, 'gh.exe', 'git.exe', 'claude.exe')
    writeSettings({ gh: join(wrong, 'gh.cmd'), git: 'git.exe', claude: wrong })
    expect(await finderOf(envOf({ Path: pathDir })).check()).toEqual([
      { tool: 'git', state: 'bad-path', path: 'git.exe', source: 'settings' },
      { tool: 'gh', state: 'bad-path', path: join(wrong, 'gh.cmd'), source: 'settings' },
      { tool: 'claude', state: 'bad-path', path: wrong, source: 'settings' },
    ])
  })

  test('the env value is the only claude', async () => {
    const fromEnv = folder('from-env')
    const fromSettings = folder('from-settings')
    plant(fromEnv, 'my-claude.exe')
    plant(fromSettings, 'claude.exe')
    plant(pathDir, 'claude.exe')
    writeSettings({ claude: join(fromSettings, 'claude.exe') })

    const file = join(fromEnv, 'my-claude.exe')
    const wins = finderOf(envOf({ Path: pathDir, OPENAFLOW_CLAUDE_BIN: file }))
    expect(stateOf(await wins.check(), 'claude')).toEqual({ tool: 'claude', state: 'found', path: file, source: 'env' })

    const gone = join(fromEnv, 'no-such', 'claude.exe')
    const missing = finderOf(envOf({ Path: pathDir, OPENAFLOW_CLAUDE_BIN: gone }))
    expect(stateOf(await missing.check(), 'claude')).toEqual({ tool: 'claude', state: 'bad-path', path: gone, source: 'env' })
    expect(missing.path('claude')).toBeUndefined()

    // A bare name or a relative path starts no search either.
    process.chdir(pathDir)
    for (const value of ['claude', 'claude.exe', '.\\claude.exe']) {
      const bare = finderOf(envOf({ Path: pathDir, OPENAFLOW_CLAUDE_BIN: value }))
      expect(stateOf(await bare.check(), 'claude')).toEqual({ tool: 'claude', state: 'bad-path', path: value, source: 'env' })
    }

    // An empty value counts as unset, as it does everywhere else.
    const empty = finderOf(envOf({ Path: pathDir, OPENAFLOW_CLAUDE_BIN: '' }))
    expect(stateOf(await empty.check(), 'claude')).toMatchObject({ state: 'found', source: 'settings' })
  })

  test('the env value finds the shim beside an extensionless name, as the runner does', async () => {
    const shimDir = folder('shim')
    plant(shimDir, 'claude', 'claude.cmd')
    const finder = finderOf(envOf({ OPENAFLOW_CLAUDE_BIN: join(shimDir, 'claude') }))
    expect(stateOf(await finder.check(), 'claude')).toEqual({ tool: 'claude', state: 'found', path: join(shimDir, 'claude.cmd'), source: 'env' })
  })

  test('each tool keeps its extensions', async () => {
    plant(pathDir, 'gh.cmd', 'gh.bat', 'gh', 'git.cmd', 'claude.cmd', 'claude')
    const states = await finderOf(envOf({ Path: pathDir })).check()
    expect(stateOf(states, 'gh')?.state).toBe('missing')
    expect(stateOf(states, 'git')?.state).toBe('missing')
    expect(stateOf(states, 'claude')).toMatchObject({ state: 'found', path: join(pathDir, 'claude.cmd') })

    // .com before .exe, and a later folder's .exe beats an earlier folder's .cmd for gh.
    const later = folder('later')
    plant(later, 'gh.exe', 'gh.com')
    const next = await finderOf(envOf({ Path: `${pathDir};${later}` })).check()
    expect(stateOf(next, 'gh')).toMatchObject({ state: 'found', path: join(later, 'gh.com') })
  })

  test('a bad settings file', async () => {
    plant(pathDir, 'gh.exe', 'git.exe', 'claude.exe')
    const finder = finderOf(envOf({ Path: pathDir }))
    const allFromPath = ORDER.map((tool) => ({ tool, state: 'found', path: join(pathDir, `${tool}.exe`), source: 'path' }))

    for (const text of ['{ not json', '[]', 'null', '"gh"', JSON.stringify({ gh: 5, git: null, claude: { a: 1 } })]) {
      writeSettings(text)
      expect(await finder.check(), text).toEqual(allFromPath)
    }

    // A folder where the file should be is unreadable: nothing set.
    rmSync(settingsFile)
    mkdirSync(settingsFile)
    expect(await finder.check()).toEqual(allFromPath)
    rmSync(settingsFile, { recursive: true })

    // A network or device value is bad-path, and no file system call sees it.
    for (const unc of ['\\\\host\\share\\gh.exe', '//host/share/gh.exe', '\\\\?\\C:\\x\\gh.exe', '\\\\.\\pipe\\gh.exe']) {
      writeSettings({ gh: unc })
      vi.mocked(statSync).mockClear()
      expect(stateOf(await finder.check(), 'gh')).toEqual({ tool: 'gh', state: 'bad-path', path: unc, source: 'settings' })
      const touched = vi.mocked(statSync).mock.calls.map((c) => String(c[0]))
      expect(touched.length).toBeGreaterThan(0) // the spy sees the other tools' lookups
      expect(touched.filter((p) => /^[\\/]{2}/.test(p))).toEqual([])
    }
  })

  test('each check looks again', async () => {
    const finder = finderOf(envOf({ Path: pathDir }))
    expect(stateOf(await finder.check(), 'gh')?.state).toBe('missing')
    plant(pathDir, 'gh.exe')
    expect(stateOf(await finder.check(), 'gh')?.state).toBe('found')
    rmSync(join(pathDir, 'gh.exe'))
    expect(stateOf(await finder.check(), 'gh')?.state).toBe('missing')

    // Two calls during a check share one registry read.
    let reads = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = finderOf(envOf(), async () => {
      reads++
      await gate
      return ''
    })
    const a = slow.check()
    const b = slow.check()
    release()
    const [first, second] = await Promise.all([a, b])
    expect(first).toEqual(ORDER.map((tool) => ({ tool, state: 'missing' })))
    expect(second).toBe(first)
    expect(reads).toBe(2) // one per hive

    await slow.check()
    expect(reads).toBe(4)
  })

  test('a save during a running check answers from a check that started after the write', async () => {
    const chosen = folder('chosen')
    plant(chosen, 'gh.exe')
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const finder = finderOf(envOf(), async () => {
      await gate
      return ''
    })
    const running = finder.check()
    const save = finder.setPath('gh', join(chosen, 'gh.exe'))
    release()
    await running
    const saved = await save
    expect('tools' in saved && stateOf(saved.tools, 'gh')).toMatchObject({ state: 'found', source: 'settings' })
    expect(stateOf(finder.states(), 'gh')).toMatchObject({ state: 'found', source: 'settings' })
  })

  test('two saves at once both land', async () => {
    const chosen = folder('chosen')
    plant(chosen, 'gh.exe', 'git.exe')
    const finder = finderOf()
    await Promise.all([finder.setPath('gh', join(chosen, 'gh.exe')), finder.setPath('git', join(chosen, 'git.exe'))])
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({ gh: join(chosen, 'gh.exe'), git: join(chosen, 'git.exe') })
    expect(stateOf(finder.states(), 'gh')?.state).toBe('found')
    expect(stateOf(finder.states(), 'git')?.state).toBe('found')
  })

  test('a save makes a missing config folder', async () => {
    const chosen = folder('chosen')
    plant(chosen, 'gh.exe')
    const nested = join(root, 'not-yet', 'tool-paths.json')
    const finder = createToolFinder({ env: envOf(), platform: 'win32', settingsFile: nested, readRegistryPath: noRegistry })
    expect(await finder.setPath('gh', join(chosen, 'gh.exe'))).toHaveProperty('tools')
    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({ gh: join(chosen, 'gh.exe') })
  })

  test('merges the child Path', async () => {
    const inherited = folder('inherited')
    const reg = folder('reg-entries')
    plant(join(programFiles, 'GitHub CLI'), 'gh.exe')
    const env = envOf({ Path: `${inherited};.;rel;${inherited.toUpperCase()}\\;${reg}`, KEEP_ME: 'yes' })
    const finder = finderOf(env, async (hive) => regText(hive, hive === 'HKLM' ? `${reg};${reg.toLowerCase()}` : inherited))
    await finder.check()
    const out = finder.env()
    expect(out.Path).toBe([inherited, reg, join(programFiles, 'GitHub CLI')].join(';'))
    expect(Object.keys(out).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(out.KEEP_ME).toBe('yes')
    expect(env.Path).toContain('rel') // the given env is left alone

    // Under the existing key as spelled, and `Path` when there is none.
    const spelled = finderOf({ PATH: inherited })
    await spelled.check()
    expect(spelled.env().PATH).toBe(inherited)
    plant(join(userProfile, '.local', 'bin'), 'claude.exe')
    const none = finderOf({ USERPROFILE: userProfile })
    await none.check()
    expect(none.env().Path).toBe(join(userProfile, '.local', 'bin'))
  })

  test('before the first check every tool reads missing', () => {
    plant(pathDir, 'gh.exe')
    const finder = finderOf(envOf({ Path: pathDir }))
    expect(finder.states()).toEqual(ORDER.map((tool) => ({ tool, state: 'missing' })))
    expect(finder.path('gh')).toBeUndefined()
    expect(finder.env().Path).toBe(pathDir)
  })
})

describe('createToolFinder on another system', () => {
  test('no registry off Windows', async () => {
    const reader = vi.fn(async () => regText('HKLM', pathDir))
    plant(pathDir, 'gh.exe')
    plant(join(programFiles, 'GitHub CLI'), 'gh.exe')
    const finder = createToolFinder({ env: envOf({ Path: '/nowhere' }), platform: 'linux', settingsFile, readRegistryPath: reader })
    const states = await finder.check()
    expect(states).toEqual(ORDER.map((tool) => ({ tool, state: 'missing' })))
    expect(reader).not.toHaveBeenCalled()
  })
})
