// Stub: the tests in tool-finder.test.ts come first.

export type ToolName = 'git' | 'gh' | 'claude'
export type ToolState =
  | { tool: ToolName; state: 'found'; path: string; source: 'env' | 'settings' | 'path' | 'registry' | 'known' }
  | { tool: ToolName; state: 'missing' }
  | { tool: ToolName; state: 'bad-path'; path: string; source: 'env' | 'settings' }
export type Hive = 'HKLM' | 'HKCU'
export type PathRefusal = 'bad request' | 'not absolute' | 'not a local path' | 'not a file' | 'wrong tool'
export type SetPathResult = { tools: ToolState[] } | { error: PathRefusal | 'settings unwritable' }
export type ToolFinder = {
  check(): Promise<ToolState[]>
  states(): ToolState[]
  path(tool: ToolName): string | undefined
  env(): NodeJS.ProcessEnv
  setPath(tool: ToolName, path: string | null): Promise<SetPathResult>
}

export function createToolFinder(_o: {
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  settingsFile: string
  readRegistryPath?: (hive: Hive) => Promise<string>
  registryLimitMs?: number
}): ToolFinder {
  return {
    check: async () => [],
    states: () => [],
    path: () => undefined,
    env: () => ({}),
    setPath: async () => ({ error: 'bad request' }),
  }
}
