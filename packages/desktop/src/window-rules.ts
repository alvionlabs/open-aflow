export type WindowBounds = { x?: number; y?: number; width: number; height: number }
export type WindowHandle = { reveal(): void; setHash(hash: string): void; load(url: string): void; reload(): void; currentUrl(): string }
export const originOf = (_port: number): string => ''
export const windowOptions = (b: WindowBounds): Record<string, unknown> & { webPreferences: object } => ({ ...b, webPreferences: {} })
export const closeAction = (_o: { quitting: boolean; sessionEnded: boolean }): 'hide' | 'close' => 'hide'
export const newWindowAction = (_url: string, _origin: string): 'external' | 'deny' => 'external'
export const navigateAction = (_url: string, _origin: string): 'allow' | 'external' | 'deny' => 'external'
export const windowUrl = (_port: number, _hash?: string): string => ''
export const hashOf = (_url: string): string | undefined => 'none'
export const afterRestart = (_url: string, _port: number): { kind: 'reload' } | { kind: 'load'; url: string } => ({ kind: 'reload' })
export const createWindowFlow = (_o: { hiddenStart: boolean; open(url: string): WindowHandle }) => ({
  ready(_port: number) {},
  show(_hash?: string) {},
  painted() {},
  closed() {},
  quitting() {},
  sessionEnded() {},
  closeAction: (): 'hide' | 'close' => 'close',
  origin: (): string | undefined => 'none',
})
