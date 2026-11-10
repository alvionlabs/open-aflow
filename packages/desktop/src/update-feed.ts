// What only a `--test-feed` build reads. A default bundle holds none of this: its imports sit behind a build-time
// flag. The rules are in pod-docs/sprints/installer-and-updates.md (Update trust).

import { readFileSync } from 'node:fs'

const FEED = 'OPENAFLOW_UPDATE_TEST_FEED'
const ANSWER = 'OPENAFLOW_UPDATE_TEST_ANSWER'
const DELAY = 'OPENAFLOW_UPDATE_TEST_DELAY_MS'

/** Beside the install folder, so an update leaves it in place. */
export const TEST_ENV_FILE = 'update-test-env.json'

/** Only `http://127.0.0.1:<port>/…` counts. */
export function loopbackFeed(value: string | undefined): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.username !== '' || url.password !== '') return null
  return value
}

export type TestUpdate = { feed: string | null; answer: 'restart' | 'later' | null; firstCheckMs: number | null }

export function readTestUpdate(env: NodeJS.ProcessEnv): TestUpdate {
  const answer = env[ANSWER]
  const delay = Number(env[DELAY] ?? NaN)
  return {
    feed: loopbackFeed(env[FEED]),
    answer: answer === 'restart' || answer === 'later' ? answer : null,
    firstCheckMs: Number.isInteger(delay) && delay >= 0 ? delay : null,
  }
}

function readEnvFile(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * The installer starts the updated app through the shell, so that app has none of the proof's env. The file gives it
 * back. Answers false when the app has no temp folders: a test build then must not start, because it would open the
 * real config folder.
 */
export function applyTestEnv(env: NodeJS.ProcessEnv, file: string): boolean {
  Object.assign(env, readEnvFile(file))
  return Boolean(env.OPENAFLOW_CONFIG_DIR) && Boolean(env.OPENAFLOW_DESKTOP_DATA_DIR)
}
