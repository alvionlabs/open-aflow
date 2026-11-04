// The app's identity and its own data folder. The rules are in pod-docs/feature-details/desktop.md.

import { envValue, type Env } from '@pod-board/server/config'

export const APP_NAME = 'Pod Board'
/** Agent default; installer-and-updates uses this exact value. */
export const APP_ID = 'com.iamphduc.podboard'

/** `POD_BOARD_DESKTOP_DATA_DIR`. Unset or empty: Electron's own folder. Never the server's config folder. */
export function dataDirOverride(env: Env): string | undefined {
  return envValue(env, 'POD_BOARD_DESKTOP_DATA_DIR')
}
