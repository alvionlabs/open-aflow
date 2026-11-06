// The setup check's rows and words, and how a save or a Recheck changes the screen.
// No I/O: setup-client.ts asks the server and hands the answers here.

import type { ActionReply } from '../../actions-client.ts'

/** The server's `ToolState` (packages/server/src/tool-finder.ts). The web app takes no server code into its bundle. */
export type ToolName = 'git' | 'gh' | 'claude'
export type ToolState =
  | { tool: ToolName; state: 'found'; path: string; source: 'env' | 'settings' | 'path' | 'registry' | 'known' }
  | { tool: ToolName; state: 'missing' }
  | { tool: ToolName; state: 'bad-path'; path: string; source: 'env' | 'settings' }

export type ToolsRead = { ok: true; tools: ToolState[] } | { ok: false; message: string }

export type SetupState = {
  tools: ToolState[]
  /** A save or a Recheck is running. Another one waits for it, so an old answer can't replace a newer one. */
  busy: boolean
  rowErrors: Partial<Record<ToolName, string>>
  recheckError?: string
}

export type SetupStep = { view: 'board' } | { view: 'setup'; setup: SetupState }

export type SetupRow = {
  tool: ToolName
  cls: 's-ok' | 's-bad'
  word: 'found' | 'missing' | 'bad path'
  path?: string
  /** One sentence: `lead`, then the link, then `rest`, joined as they stand. */
  fix?: { lead?: string; link?: { label: string; href: string }; rest?: string }
  field: boolean
  error?: string
}

const ORDER: readonly ToolName[] = ['git', 'gh', 'claude']

/** Each tool's own install page, which covers every system. */
const INSTALL: Record<ToolName, string> = {
  git: 'https://git-scm.com/install/',
  gh: 'https://cli.github.com/',
  claude: 'https://code.claude.com/docs/en/setup',
}

const ENV_VARIABLE = 'POD_BOARD_CLAUDE_BIN'
export const UNREADABLE ='The server sent an answer the page cannot read.'

export const SETUP_NOTE =
  'Set CLAUDE* variables in the env block of settings.json. Resumed runs drop those set only in a shell.'

/** The three tools in order, or nothing when the answer isn't in the contract's shape. */
export function parseTools(data: unknown): ToolState[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const list = (data as { tools?: unknown }).tools
  if (!Array.isArray(list) || list.length !== ORDER.length || !list.every(isToolState)) return undefined
  const tools = list as ToolState[]
  const ordered = ORDER.map((name) => tools.find((t) => t.tool === name))
  return ordered.every((t) => t !== undefined) ? (ordered as ToolState[]) : undefined
}

function isToolState(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { tool, state, path, source } = value as Record<string, unknown>
  if (!ORDER.includes(tool as ToolName)) return false
  if (state === 'missing') return true
  if (state === 'found') return typeof path === 'string'
  return state === 'bad-path' && typeof path === 'string' && (source === 'env' || source === 'settings')
}

export const allFound = (tools: ToolState[]) => tools.every((t) => t.state === 'found')

/** The screen for an answer: the board when all are found, else the rows. */
export function setupStep(tools: ToolState[]): SetupStep {
  return allFound(tools) ? { view: 'board' } : { view: 'setup', setup: { tools, busy: false, rowErrors: {} } }
}

export function setupRows(state: SetupState): SetupRow[] {
  return ORDER.flatMap((name) => {
    const tool = state.tools.find((t) => t.tool === name)
    if (!tool) return []
    const error = state.rowErrors[name]
    return [{ ...rowOf(tool), ...(error === undefined ? {} : { error }) }]
  })
}

function rowOf(tool: ToolState): SetupRow {
  const link = { label: `Install ${tool.tool}`, href: INSTALL[tool.tool] }
  if (tool.state === 'found') return { tool: tool.tool, cls: 's-ok', word: 'found', path: tool.path, field: false }
  if (tool.state === 'missing') {
    return {
      tool: tool.tool,
      cls: 's-bad',
      word: 'missing',
      fix: { link, rest: ', then press Recheck. Or enter its path.' },
      field: true,
    }
  }
  if (tool.source === 'env') {
    return {
      tool: tool.tool,
      cls: 's-bad',
      word: 'bad path',
      path: tool.path,
      fix: { lead: `${ENV_VARIABLE} names this file, and no file is there. Correct or remove the variable, then restart Open AFlow.` },
      field: false,
    }
  }
  return {
    tool: tool.tool,
    cls: 's-bad',
    word: 'bad path',
    path: tool.path,
    fix: { lead: 'The saved path does not work. Enter another. Or ', link, rest: ' and save this field empty to search again.' },
    field: true,
  }
}

/** The route's body for what the field holds. Quotes come from Copy as path. An empty field clears the saved path. */
export function pathBody(tool: ToolName, text: string): { tool: ToolName; path: string | null } {
  const path = text.trim().replace(/^"(.*)"$/, '$1').trim()
  return { tool, path: path === '' ? null : path }
}

export function afterSave(state: SetupState, tool: ToolName, reply: ActionReply<unknown>): SetupStep {
  const tools = reply.ok ? parseTools(reply.data) : undefined
  if (tools) return setupStep(tools)
  const message = reply.ok ? UNREADABLE : reply.message
  return { view: 'setup', setup: { ...state, busy: false, rowErrors: { ...state.rowErrors, [tool]: message } } }
}

export function afterRecheck(state: SetupState, read: ToolsRead): SetupStep {
  if (read.ok) return setupStep(read.tools)
  return { view: 'setup', setup: { ...state, busy: false, recheckError: `Recheck failed: ${read.message}` } }
}
