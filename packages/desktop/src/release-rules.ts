// The plain rules of a release: the tag, the installer's size, and the update file. `scripts/release-check.ts` runs
// them. The rules are in pod-docs/sprints/installer-and-updates.md.

import { createHash } from 'node:crypto'
import { parse } from 'yaml'

// Measured on 2026-11-03: pod-board-setup-0.1.0.exe is 121,692,606 bytes. The floor is 80% of that, and the ceiling is
// 130%. Measure again and change both when the app gains or loses something large.
export const INSTALLER_FLOOR_BYTES = 97_354_085
export const INSTALLER_CEILING_BYTES = 158_200_388

const TEST_FEED_TEXT = 'POD_BOARD_UPDATE_TEST'
const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const INSTALLER = /^pod-board-setup-.*\.exe$/

/** Answers the version. Throws unless the tag is exactly `v<major>.<minor>.<patch>` and equals the package version. */
export function tagVersion(tag: string, packageVersion: string): string {
  const version = RELEASE_TAG.exec(tag)?.[1]
  if (version === undefined) throw new Error(`bad tag ${JSON.stringify(tag)}: use v<major>.<minor>.<patch>, digits only, with no leading zero`)
  if (version !== packageVersion) throw new Error(`the tag ${tag} doesn't match the version ${packageVersion} in packages/desktop/package.json`)
  return version
}

export function checkSize(bytes: number): void {
  if (bytes < INSTALLER_FLOOR_BYTES) throw new Error(`the installer is ${bytes} bytes, below the floor of ${INSTALLER_FLOOR_BYTES}`)
  if (bytes > INSTALLER_CEILING_BYTES) throw new Error(`the installer is ${bytes} bytes, above the ceiling of ${INSTALLER_CEILING_BYTES}`)
}

type UpdateFile = { path?: unknown; sha512?: unknown; files?: unknown }

function readUpdateFile(yml: string): UpdateFile {
  let value: unknown
  try {
    value = parse(yml)
  } catch {
    throw new Error('latest.yml is unreadable YAML')
  }
  if (typeof value !== 'object' || value === null) throw new Error('latest.yml is unreadable YAML: it holds no fields')
  return value as UpdateFile
}

/** Checks the top-level fields and the `files` entry, because the updater downloads from `files`. */
export function checkUpdateFile(yml: string, installerBytes: Uint8Array, name: string): void {
  const update = readUpdateFile(yml)
  const sha512 = createHash('sha512').update(installerBytes).digest('base64')
  if (update.path !== name) throw new Error(`latest.yml has path ${String(update.path)}, not ${name}`)
  if (update.sha512 !== sha512) throw new Error(`latest.yml has a sha512 that doesn't match ${name}`)
  const files = Array.isArray(update.files) ? (update.files as { url?: unknown; sha512?: unknown; size?: unknown }[]) : []
  if (files.length !== 1) throw new Error(`latest.yml has ${files.length} entries in files, not 1`)
  const [file] = files
  if (file?.url !== name) throw new Error(`latest.yml has files url ${String(file?.url)}, not ${name}`)
  if (file.sha512 !== sha512) throw new Error(`latest.yml has a files sha512 that doesn't match ${name}`)
  if (file.size !== installerBytes.length) throw new Error(`latest.yml has files size ${String(file.size)}, not ${installerBytes.length}`)
}

/** Only a `--test-feed` build may hold this text, and that build must never ship. */
export function checkNoTestFeed(mainCjs: string): void {
  if (mainCjs.includes(TEST_FEED_TEXT)) throw new Error(`main.cjs holds ${TEST_FEED_TEXT}: this is a test-feed build`)
}

/** The output folder must hold one installer: with two, the check could pass one and the upload could take both. */
export function pickInstaller(names: string[]): string {
  const installers = names.filter((name) => INSTALLER.test(name))
  const [only] = installers
  if (only === undefined) throw new Error('no installer in the output folder: run pnpm package first')
  if (installers.length > 1) throw new Error(`more than one installer in the output folder: ${installers.join(', ')}`)
  return only
}
