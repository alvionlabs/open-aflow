import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { applyTestEnv, loopbackFeed, readTestUpdate } from './update-feed.ts'

describe('the test feed', () => {
  test('only a loopback feed counts', () => {
    expect(loopbackFeed('http://127.0.0.1:3111/')).toBe('http://127.0.0.1:3111/')
    expect(loopbackFeed('http://127.0.0.1:3111/feed/')).toBe('http://127.0.0.1:3111/feed/')
    for (const bad of [
      undefined,
      '',
      'not a url',
      'https://127.0.0.1:3111/',
      'http://localhost:3111/',
      'http://[::1]:3111/',
      'http://example.com:3111/',
      'http://127.0.0.1.example.com:3111/',
      'http://127.0.0.1/',
      'http://me:secret@127.0.0.1:3111/',
      'ftp://127.0.0.1:3111/',
    ]) {
      expect(loopbackFeed(bad), String(bad)).toBeNull()
    }
  })

  test('reads the answer and the first delay, and ignores a bad one', () => {
    expect(
      readTestUpdate({ OPENAFLOW_UPDATE_TEST_FEED: 'http://127.0.0.1:3111/', OPENAFLOW_UPDATE_TEST_ANSWER: 'later', OPENAFLOW_UPDATE_TEST_DELAY_MS: '1000' }),
    ).toEqual({ feed: 'http://127.0.0.1:3111/', answer: 'later', firstCheckMs: 1000 })
    expect(readTestUpdate({ OPENAFLOW_UPDATE_TEST_ANSWER: 'restart' }).answer).toBe('restart')
    expect(readTestUpdate({ OPENAFLOW_UPDATE_TEST_FEED: 'https://example.com/', OPENAFLOW_UPDATE_TEST_ANSWER: 'yes', OPENAFLOW_UPDATE_TEST_DELAY_MS: 'soon' })).toEqual({ feed: null, answer: null, firstCheckMs: null })
    expect(readTestUpdate({ OPENAFLOW_UPDATE_TEST_DELAY_MS: '-5' }).firstCheckMs).toBeNull()
  })
})

// After an update, the installer starts the app through the shell, so the new app has none of the proof's env.
describe('the test build env file', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-update-feed-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const FOLDERS = { OPENAFLOW_CONFIG_DIR: 'C:\\t\\config', OPENAFLOW_DESKTOP_DATA_DIR: 'C:\\t\\shell' }

  test('its values reach the env, over what the env holds', () => {
    const file = join(dir, 'env.json')
    writeFileSync(file, JSON.stringify({ ...FOLDERS, OPENAFLOW_API_PORT: '3120' }))
    const env: NodeJS.ProcessEnv = { OPENAFLOW_API_PORT: '1', KEEP: 'yes' }
    expect(applyTestEnv(env, file)).toBe(true)
    expect(env).toEqual({ ...FOLDERS, OPENAFLOW_API_PORT: '3120', KEEP: 'yes' })
  })

  test('temp folders in the env are enough with no file', () => {
    expect(applyTestEnv({ ...FOLDERS }, join(dir, 'none.json'))).toBe(true)
  })

  test('with no temp folders the test build may not start, so it never opens the real config', () => {
    expect(applyTestEnv({}, join(dir, 'none.json'))).toBe(false)
    expect(applyTestEnv({ OPENAFLOW_CONFIG_DIR: 'C:\\t\\config' }, join(dir, 'none.json'))).toBe(false)
    expect(applyTestEnv({ OPENAFLOW_CONFIG_DIR: '', OPENAFLOW_DESKTOP_DATA_DIR: '' }, join(dir, 'none.json'))).toBe(false)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(applyTestEnv({}, bad)).toBe(false)
    writeFileSync(bad, '["a"]')
    expect(applyTestEnv({}, bad)).toBe(false)
  })
})
