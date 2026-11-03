export type LoginPlace = { packaged: boolean; appPath: string }
export type LoginApi = { get(q: { args: string[] }): { openAtLogin: boolean }; set(o: { openAtLogin: boolean; args: string[] }): void }
export const loginItemOptions = (on: boolean, _p: LoginPlace): { openAtLogin: boolean; args: string[] } => ({ openAtLogin: on, args: [] })
export const isLoginStart = (_argv: string[]): boolean => false
export const createLoginItem = (_o: LoginPlace & { api: LoginApi }) => ({
  isOn: (): boolean => true,
  set: (_on: boolean): boolean => false,
})
