import type { Env } from '@pod-board/server/config'

export const APP_NAME = 'Pod Board'
export const APP_ID = 'com.iamphduc.podboard'

export function dataDirOverride(_env: Env): string | undefined {
  return ''
}
