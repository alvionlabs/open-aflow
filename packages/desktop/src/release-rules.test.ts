import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { stringify } from 'yaml'
import { checkNoTestFeed, checkSize, checkUpdateFile, INSTALLER_CEILING_BYTES, INSTALLER_FLOOR_BYTES, pickInstaller, tagVersion } from './release-rules.ts'

describe('tagVersion', () => {
  test('tag matches the package version', () => {
    expect(tagVersion('v1.2.3', '1.2.3')).toBe('1.2.3')
    expect(tagVersion('v10.0.20', '10.0.20')).toBe('10.0.20')
    expect(tagVersion('v0.1.0', '0.1.0')).toBe('0.1.0')
    expect(() => tagVersion('v1.2.4', '1.2.3')).toThrow(/v1\.2\.4.*1\.2\.3/)
    for (const bad of ['v1.2', 'v1.2.3-beta', '1.2.3', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'V1.2.3', 'v1.2.3 ', '']) {
      expect(() => tagVersion(bad, bad.replace(/^v/, '')), JSON.stringify(bad)).toThrow(/tag/)
    }
  })
})

describe('checkSize', () => {
  test('installer size limits', () => {
    expect(INSTALLER_FLOOR_BYTES).toBeGreaterThan(0)
    expect(INSTALLER_CEILING_BYTES).toBeGreaterThan(INSTALLER_FLOOR_BYTES)
    expect(() => checkSize(INSTALLER_FLOOR_BYTES)).not.toThrow()
    expect(() => checkSize(INSTALLER_CEILING_BYTES)).not.toThrow()
    expect(() => checkSize(INSTALLER_FLOOR_BYTES - 1)).toThrow(/below/)
    expect(() => checkSize(INSTALLER_CEILING_BYTES + 1)).toThrow(/above/)
  })
})

describe('checkUpdateFile', () => {
  const name = 'pod-board-setup-1.2.3.exe'
  const bytes = Buffer.from('the installer')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const file = { url: name, sha512, size: bytes.length }
  const good = { version: '1.2.3', files: [file], path: name, sha512, releaseDate: '2026-11-03T00:00:00.000Z' }

  test('update file matches the installer', () => {
    expect(() => checkUpdateFile(stringify(good), bytes, name)).not.toThrow()
    expect(() => checkUpdateFile(stringify({ ...good, path: 'other.exe' }), bytes, name)).toThrow(/path/)
    expect(() => checkUpdateFile(stringify({ ...good, sha512: 'd3Jvbmc=' }), bytes, name)).toThrow(/sha512/)
    expect(() => checkUpdateFile('{ not: [yaml', bytes, name)).toThrow(/YAML/)
    expect(() => checkUpdateFile('just text', bytes, name)).toThrow(/YAML/)
  })

  // The updater downloads from `files`, not from the top-level `path`.
  test('the files entry the updater reads also matches', () => {
    expect(() => checkUpdateFile(stringify({ ...good, files: [] }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: undefined }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...file, url: 'other.exe' }] }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...file, sha512: 'd3Jvbmc=' }] }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...file, size: 1 }] }), bytes, name)).toThrow(/files/)
  })
})

describe('checkNoTestFeed', () => {
  test('the test feed text in main.cjs fails', () => {
    expect(() => checkNoTestFeed('const a = 1')).not.toThrow()
    expect(() => checkNoTestFeed('const a = process.env.POD_BOARD_UPDATE_TEST_FEED')).toThrow(/POD_BOARD_UPDATE_TEST/)
  })
})

describe('pickInstaller', () => {
  test('exactly one installer counts', () => {
    const name = 'pod-board-setup-1.2.3.exe'
    expect(pickInstaller([name, `${name}.blockmap`, 'latest.yml', 'builder-debug.yml', 'win-unpacked', '__uninstaller-nsis-pod-board-desktop.exe'])).toBe(name)
    expect(() => pickInstaller(['latest.yml'])).toThrow(/no installer/)
    expect(() => pickInstaller([name, 'pod-board-setup-1.2.4.exe'])).toThrow(/pod-board-setup-1\.2\.3\.exe.*pod-board-setup-1\.2\.4\.exe/)
  })
})
