import type { Configuration } from 'electron-builder'

export const UPDATER_CACHE_DIR = ''
export const EXE_NAME = ''
export type BuildOptions = { noticesFile: string; version?: string; output?: string }
export function checkVersion(_version: string): void {}
export function parsePackageArgs(_argv: string[]): { version?: string; output?: string } {
  return {}
}
export function buildConfig(_o: BuildOptions): Configuration {
  return {}
}
export function builderOptions(_o: BuildOptions): { projectDir: string; publish: 'never'; config: Configuration } {
  return { projectDir: '', publish: 'never', config: {} }
}
