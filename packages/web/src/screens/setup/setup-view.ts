// stub
import type { ActionReply } from '../../actions-client.ts'
export type ToolName = 'git' | 'gh' | 'claude'
export type ToolState =
  | { tool: ToolName; state: 'found'; path: string; source: 'env' | 'settings' | 'path' | 'registry' | 'known' }
  | { tool: ToolName; state: 'missing' }
  | { tool: ToolName; state: 'bad-path'; path: string; source: 'env' | 'settings' }
export type ToolsRead = { ok: true; tools: ToolState[] } | { ok: false; message: string }
export type SetupState = { tools: ToolState[]; busy: boolean; rowErrors: Partial<Record<ToolName, string>>; recheckError?: string }
export type SetupStep = { view: 'board' } | { view: 'setup'; setup: SetupState }
export type SetupRow = {
  tool: ToolName
  cls: string
  word: string
  path?: string
  fix?: { lead?: string; link?: { label: string; href: string }; rest?: string }
  field: boolean
  error?: string
}
export const SETUP_NOTE = ''
export const parseTools = (_data: unknown): ToolState[] | undefined => undefined
export const allFound = (_tools: ToolState[]): boolean => false
export const setupStep = (tools: ToolState[]): SetupStep => ({ view: 'setup', setup: { tools, busy: false, rowErrors: {} } })
export const setupRows = (_state: SetupState): SetupRow[] => []
export const pathBody = (tool: ToolName, _text: string): { tool: ToolName; path: string | null } => ({ tool, path: '' })
export const afterSave = (state: SetupState, _tool: ToolName, _reply: ActionReply<unknown>): SetupStep => ({ view: 'setup', setup: state })
export const afterRecheck = (state: SetupState, _read: ToolsRead): SetupStep => ({ view: 'setup', setup: state })
