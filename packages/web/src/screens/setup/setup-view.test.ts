import { describe, expect, it } from 'vitest'
import {
  afterRecheck,
  afterSave,
  allFound,
  parseTools,
  pathBody,
  SETUP_NOTE,
  setupRows,
  type SetupRow,
  type SetupState,
  type ToolState,
} from './setup-view.ts'

const git: ToolState = { tool: 'git', state: 'found', path: 'C:\\Git\\cmd\\git.exe', source: 'path' }
const gh: ToolState = { tool: 'gh', state: 'found', path: 'C:\\gh\\gh.exe', source: 'registry' }
const claude: ToolState = { tool: 'claude', state: 'found', path: 'C:\\c\\claude.cmd', source: 'settings' }
const missingGh: ToolState = { tool: 'gh', state: 'missing' }
const badClaude: ToolState = { tool: 'claude', state: 'bad-path', path: 'C:\\gone\\claude.cmd', source: 'settings' }
const envClaude: ToolState = { tool: 'claude', state: 'bad-path', path: 'C:\\gone\\claude.exe', source: 'env' }

const state = (tools: ToolState[], more: Partial<SetupState> = {}): SetupState => ({ tools, busy: false, rowErrors: {}, ...more })
const rowsOf = (tools: ToolState[]) => setupRows(state(tools))
const rowFor = (tools: ToolState[], tool: string) => {
  const row = rowsOf(tools).find((r) => r.tool === tool)
  if (!row) throw new Error(`no row for ${tool}`)
  return row
}
const fixText = (fix: SetupRow['fix']) => [fix?.lead, fix?.link?.label, fix?.rest].filter(Boolean).join(' ')

describe('setup rows', () => {
  it('rows show each state', () => {
    const rows = rowsOf([badClaude, missingGh, git])
    expect(rows.map((r) => r.tool)).toEqual(['git', 'gh', 'claude'])
    expect(rows.map((r) => [r.cls, r.word])).toEqual([
      ['s-ok', 'found'],
      ['s-bad', 'missing'],
      ['s-bad', 'bad path'],
    ])
    expect(rows[0]!.path).toBe('C:\\Git\\cmd\\git.exe')
    expect(rows[1]!.path).toBeUndefined()
    expect(rows[2]!.path).toBe('C:\\gone\\claude.cmd')
  })

  it('what to do per state', () => {
    const tools = [git, missingGh, badClaude]
    const found = rowFor(tools, 'git')
    expect(found.field).toBe(false)
    expect(found.fix).toBeUndefined()

    for (const row of [rowFor(tools, 'gh'), rowFor(tools, 'claude')]) {
      expect(row.field).toBe(true)
      expect(row.fix?.link?.href).toMatch(/^https:\/\//)
    }
    // One link per tool, each its own.
    const hrefs = rowsOf([{ tool: 'git', state: 'missing' }, missingGh, { tool: 'claude', state: 'missing' }]).map((r) => r.fix?.link?.href)
    expect(new Set(hrefs).size).toBe(3)
  })

  it("an env path can't be overridden here", () => {
    const row = rowFor([git, gh, envClaude], 'claude')
    expect(row.word).toBe('bad path')
    expect(row.field).toBe(false)
    expect(row.path).toBe('C:\\gone\\claude.exe')
    expect(fixText(row.fix)).toContain('POD_BOARD_CLAUDE_BIN')
  })

  it('the note on CLAUDE variables', () => {
    expect(SETUP_NOTE).toContain('settings.json')
    expect(SETUP_NOTE).toContain('env')
    expect(SETUP_NOTE).toContain('CLAUDE')
  })

  it('a saved path that fails tells how to search again', () => {
    expect(fixText(rowFor([git, gh, badClaude], 'claude').fix)).toMatch(/empty/i)
    expect(fixText(rowFor([git, missingGh, claude], 'gh').fix)).not.toMatch(/empty/i)
  })
})

describe('the path field', () => {
  it('a path is sent trimmed, with the quotes of Copy as path taken off', () => {
    expect(pathBody('gh', '  C:\\gh\\gh.exe ')).toEqual({ tool: 'gh', path: 'C:\\gh\\gh.exe' })
    expect(pathBody('gh', '"C:\\Program Files\\gh\\gh.exe"')).toEqual({ tool: 'gh', path: 'C:\\Program Files\\gh\\gh.exe' })
  })

  it('an empty field clears the saved path', () => {
    for (const text of ['', '   ', '""']) expect(pathBody('claude', text)).toEqual({ tool: 'claude', path: null })
  })
})

describe('moves between setup and board', () => {
  const start = state([git, missingGh, badClaude])
  const ok = (tools: unknown) => ({ ok: true as const, data: { tools } })

  it('saving a path', () => {
    const refused = afterSave(start, 'gh', { ok: false, status: 400, message: 'wrong tool' })
    expect(refused.view).toBe('setup')
    if (refused.view !== 'setup') return
    expect(refused.setup.tools).toEqual(start.tools)
    const rows = setupRows(refused.setup)
    expect(rows.find((r) => r.tool === 'gh')?.error).toBe('wrong tool')
    expect(rows.find((r) => r.tool === 'claude')?.error).toBeUndefined()

    expect(afterSave(start, 'gh', ok([git, gh, claude]))).toEqual({ view: 'board' })

    // Another tool is still not found: the rows take the new states, and the old reason goes.
    const partly = afterSave(refused.setup, 'gh', ok([git, gh, badClaude]))
    expect(partly.view).toBe('setup')
    if (partly.view !== 'setup') return
    expect(partly.setup.tools).toEqual([git, gh, badClaude])
    expect(setupRows(partly.setup).find((r) => r.tool === 'gh')?.error).toBeUndefined()
  })

  it('a 500 or an unreadable save reply stays on the row', () => {
    const failed = afterSave(start, 'gh', { ok: false, status: 500, message: 'settings unwritable' })
    expect(failed.view === 'setup' && failed.setup.rowErrors.gh).toBe('settings unwritable')

    const odd = afterSave(start, 'gh', ok('nonsense'))
    expect(odd.view).toBe('setup')
    expect(odd.view === 'setup' && odd.setup.tools).toEqual(start.tools)
    expect(odd.view === 'setup' && odd.setup.rowErrors.gh).toBeTruthy()
  })

  it('rechecking', () => {
    const failed = afterRecheck(start, { ok: false, message: "Can't reach the board." })
    expect(failed.view).toBe('setup')
    if (failed.view !== 'setup') return
    expect(failed.setup.tools).toEqual(start.tools)
    expect(failed.setup.recheckError).toContain('Recheck failed')
    expect(failed.setup.recheckError).toContain("Can't reach the board.")

    expect(afterRecheck(failed.setup, { ok: true, tools: [git, gh, claude] })).toEqual({ view: 'board' })

    const still = afterRecheck(failed.setup, { ok: true, tools: [git, missingGh, claude] })
    expect(still.view === 'setup' && still.setup.recheckError).toBeUndefined()
    expect(still.view === 'setup' && still.setup.tools).toEqual([git, missingGh, claude])
  })
})

describe('reading the answer', () => {
  it('takes only the three tools in the contract shape, and puts them in order', () => {
    expect(parseTools({ tools: [claude, git, gh] })).toEqual([git, gh, claude])
    expect(allFound([git, gh, claude])).toBe(true)
    expect(allFound([git, missingGh, claude])).toBe(false)
    for (const bad of [
      null,
      'x',
      {},
      { tools: 'x' },
      { tools: [] },
      { tools: [git, gh] },
      { tools: [git, gh, { tool: 'claude', state: 'odd' }] },
      { tools: [git, gh, { tool: 'claude', state: 'found' }] },
      { tools: [git, gh, { tool: 'claude', state: 'bad-path', path: 'x', source: 'path' }] },
      { tools: [git, gh, gh] },
      { tools: [git, gh, null] },
    ]) {
      expect(parseTools(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})
