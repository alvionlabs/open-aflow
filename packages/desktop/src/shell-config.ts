// The app's identity and its own data folder. The rules are in pod-docs/feature-details/desktop.md.

import { envValue, type Env } from '@openaflow/server/config'

export const APP_NAME = 'OpenAFlow'
/** The human's choice at the rename to OpenAFlow; installer-and-updates uses this exact value. */
export const APP_ID = 'com.alvionlabs.openaflow'
/** The server process's name in Task Manager. */
export const SERVER_SERVICE_NAME = `${APP_NAME} server`

/** `OPENAFLOW_DESKTOP_DATA_DIR`. Unset or empty: Electron's own folder. Never the server's config folder. */
export function dataDirOverride(env: Env): string | undefined {
  return envValue(env, 'OPENAFLOW_DESKTOP_DATA_DIR')
}
