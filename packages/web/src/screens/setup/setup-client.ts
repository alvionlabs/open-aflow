// stub
import type { SetupStep, ToolName, ToolsRead } from './setup-view.ts'
export const GATE_LIMIT_MS = 5000
export const ACTION_LIMIT_MS = 15000
export type SetupDeps = { fetch?: typeof fetch; token?: () => string | null | undefined }
export type GateState = { view: 'checking' } | SetupStep
export const readTools = async (_deps: SetupDeps = {}, _limitMs = GATE_LIMIT_MS): Promise<ToolsRead> => ({ ok: false, message: '' })
export function createSetupGate(_deps: SetupDeps = {}) {
  const current: GateState = { view: 'checking' }
  return {
    state: (): GateState => current,
    subscribe: (_fn: () => void) => () => {},
    start: () => {},
    recheck: async () => {},
    save: async (_tool: ToolName, _text: string) => {},
  }
}
