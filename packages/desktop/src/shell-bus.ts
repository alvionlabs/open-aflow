export type ShellBus = {
  showWindow(hash?: string): void
  onShowWindow(fn: (hash: string | undefined) => void): void
  setAttention(on: boolean): void
  onAttention(fn: (on: boolean) => void): void
}
export function createShellBus(): ShellBus {
  return { showWindow() {}, onShowWindow() {}, setAttention() {}, onAttention() {} }
}
