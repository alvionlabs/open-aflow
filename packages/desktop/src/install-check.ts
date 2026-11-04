export type ProofPlace = { root: string; installDir: string; env: NodeJS.ProcessEnv; port: number }
export type MachineState = { uninstallKeys: string[]; runValue: string | null; startMenu: string[]; apps: number[]; updaterCache: boolean; realConfig: string[] | null }
export function proofPlace(port: number): ProofPlace {
  return { root: '', installDir: '', env: {}, port }
}
export function withInstallLock<T>(fn: () => Promise<T>, _o?: { path?: string; pollMs?: number; waitMs?: number }): Promise<T> {
  return fn()
}
export function createRealConfigReader(_dir: string): () => { files: string[] | null; held: boolean } {
  return () => ({ files: [], held: false })
}
export function stateDiff(_before: MachineState, _after: MachineState): string[] {
  return []
}
export function refuseRealInstall(_state: MachineState): void {}
export function machineState(): Promise<MachineState> {
  throw new Error('not built')
}
export function silentInstall(_installer: string, _place: ProofPlace): Promise<void> {
  throw new Error('not built')
}
export function launch(_place: ProofPlace, _args?: string[]): Promise<{ pid: number; output(): string }> {
  throw new Error('not built')
}
export function waitForHealth(_place: ProofPlace, _ms?: number): Promise<void> {
  throw new Error('not built')
}
export function silentUninstall(_place: ProofPlace): Promise<void> {
  throw new Error('not built')
}
export function finishProof(_place: ProofPlace, _before: MachineState): Promise<string[]> {
  throw new Error('not built')
}
export function proofLastLine(_diff: string[]): string {
  return ''
}
