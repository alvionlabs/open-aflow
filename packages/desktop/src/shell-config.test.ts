import { describe, expect, test } from 'vitest'
import { APP_ID, APP_NAME, dataDirOverride } from './shell-config.ts'

describe('shell config', () => {
  test('reads the data folder', () => {
    expect(dataDirOverride({})).toBeUndefined()
    expect(dataDirOverride({ POD_BOARD_DESKTOP_DATA_DIR: '' })).toBeUndefined()
    expect(dataDirOverride({ POD_BOARD_DESKTOP_DATA_DIR: 'C:\\tmp\\shell' })).toBe('C:\\tmp\\shell')
  })

  test('the identity is fixed', () => {
    expect(APP_NAME).toBe('Pod Board')
    expect(APP_ID).toBe('com.iamphduc.podboard')
  })
})
