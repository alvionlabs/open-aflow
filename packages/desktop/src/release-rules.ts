// Stub: the test commit fails on assertions, not on a missing import.
const notBuilt = (): never => {
  throw new Error('not built')
}
export const INSTALLER_FLOOR_BYTES = 0
export const INSTALLER_CEILING_BYTES = 0
export const tagVersion = (_tag: string, _packageVersion: string): string => notBuilt()
export const checkSize = (_bytes: number): void => notBuilt()
export const checkUpdateFile = (_yml: string, _installerBytes: Uint8Array, _name: string): void => notBuilt()
export const checkNoTestFeed = (_mainCjs: string): void => notBuilt()
export const pickInstaller = (_names: string[]): string => notBuilt()
