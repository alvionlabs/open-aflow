import { describe, expect, test } from 'vitest'
import { CONFIG_DIR_NAME, configPath, listenConfig, oldConfigDir, portFromEnv } from './config.ts'

describe('listenConfig', () => {
  test('binds 127.0.0.1 with the env port', () => {
    expect(listenConfig({ OPEN_AFLOW_API_PORT: '3010' })).toEqual({ hostname: '127.0.0.1', port: 3010 })
    expect(listenConfig({ OPEN_AFLOW_API_PORT: '1' })).toEqual({ hostname: '127.0.0.1', port: 1 })
    expect(listenConfig({ OPEN_AFLOW_API_PORT: '65535' })).toEqual({ hostname: '127.0.0.1', port: 65535 })
    // Other env vars never move the bind address.
    expect(listenConfig({ OPEN_AFLOW_API_PORT: '3010', HOST: '0.0.0.0', HOSTNAME: '0.0.0.0' }).hostname).toBe(
      '127.0.0.1',
    )
  })

  test('defaults to port 3000', () => {
    expect(listenConfig({})).toEqual({ hostname: '127.0.0.1', port: 3000 })
    // An empty value (`OPEN_AFLOW_API_PORT=`) counts as unset.
    expect(listenConfig({ OPEN_AFLOW_API_PORT: '' })).toEqual({ hostname: '127.0.0.1', port: 3000 })
  })

  test('rejects an invalid port', () => {
    for (const bad of ['0', '65536', 'abc', '-1', '3000.5', '1e3', '0x10', ' 3000', '3000abc', '99999999999']) {
      expect(() => listenConfig({ OPEN_AFLOW_API_PORT: bad }), bad).toThrowError(/OPEN_AFLOW_API_PORT/)
    }
    expect(() => listenConfig({ OPEN_AFLOW_API_PORT: 'abc' })).toThrowError(/"abc"/)
    expect(() => listenConfig({ OPEN_AFLOW_API_PORT: '0' })).toThrowError(/1 to 65535/)
  })
})

describe('portFromEnv', () => {
  test('reads any named variable with its own default', () => {
    expect(portFromEnv({ OPEN_AFLOW_WEB_PORT: '3011' }, 'OPEN_AFLOW_WEB_PORT', 3001)).toBe(3011)
    expect(portFromEnv({}, 'OPEN_AFLOW_WEB_PORT', 3001)).toBe(3001)
    expect(() => portFromEnv({ OPEN_AFLOW_WEB_PORT: 'x' }, 'OPEN_AFLOW_WEB_PORT', 3001)).toThrowError(
      /OPEN_AFLOW_WEB_PORT/,
    )
  })
})

describe('configPath per OS', () => {
  test('OPEN_AFLOW_CONFIG_DIR wins on every OS', () => {
    expect(configPath({ OPEN_AFLOW_CONFIG_DIR: 'D:\\cfg', APPDATA: 'C:\\A' }, 'win32', 'C:\\Users\\me')).toBe(
      'D:\\cfg\\config.json',
    )
    expect(configPath({ OPEN_AFLOW_CONFIG_DIR: '/tmp/cfg' }, 'darwin', '/Users/me')).toBe('/tmp/cfg/config.json')
    expect(configPath({ OPEN_AFLOW_CONFIG_DIR: '/tmp/cfg', XDG_CONFIG_HOME: '/x' }, 'linux', '/home/me')).toBe(
      '/tmp/cfg/config.json',
    )
  })

  test('win32 uses APPDATA, else the home Roaming folder', () => {
    expect(configPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\open-aflow-server\\config.json',
    )
    expect(configPath({}, 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Roaming\\open-aflow-server\\config.json')
  })

  test('darwin uses Application Support', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x' }, 'darwin', '/Users/me')).toBe(
      '/Users/me/Library/Application Support/open-aflow-server/config.json',
    )
  })

  test('linux uses XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/me')).toBe('/x/cfg/open-aflow-server/config.json')
    expect(configPath({}, 'linux', '/home/me')).toBe('/home/me/.config/open-aflow-server/config.json')
    expect(configPath({}, 'freebsd', '/home/me')).toBe('/home/me/.config/open-aflow-server/config.json')
  })

  test('empty values count as unset; a relative XDG_CONFIG_HOME is ignored', () => {
    expect(configPath({ OPEN_AFLOW_CONFIG_DIR: '', APPDATA: '' }, 'win32', 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\open-aflow-server\\config.json',
    )
    expect(configPath({ XDG_CONFIG_HOME: '' }, 'linux', '/home/me')).toBe('/home/me/.config/open-aflow-server/config.json')
    // The XDG spec says a relative value is invalid and must be ignored.
    expect(configPath({ XDG_CONFIG_HOME: 'cfg' }, 'linux', '/home/me')).toBe('/home/me/.config/open-aflow-server/config.json')
  })
})

describe('the config folder name', () => {
  test("is never the packaged app's name or its product name, which NSIS's --delete-app-data removes", () => {
    expect(CONFIG_DIR_NAME).toBe('open-aflow-server')
  })
})

describe('oldConfigDir: the folder before the rename, where a copy comes from', () => {
  test('is the old pod-board folder in the same place, per OS', () => {
    expect(oldConfigDir({ APPDATA: 'C:\Users\me\AppData\Roaming' }, 'win32', 'C:\Users\me')).toBe(
      'C:\Users\me\AppData\Roaming\pod-board',
    )
    expect(oldConfigDir({}, 'win32', 'C:\Users\me')).toBe('C:\Users\me\AppData\Roaming\pod-board')
    expect(oldConfigDir({}, 'darwin', '/Users/me')).toBe('/Users/me/Library/Application Support/pod-board')
    expect(oldConfigDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/me')).toBe('/x/cfg/pod-board')
    expect(oldConfigDir({ XDG_CONFIG_HOME: 'cfg' }, 'linux', '/home/me')).toBe('/home/me/.config/pod-board')
  })

  test('is none when OPEN_AFLOW_CONFIG_DIR is set, so a temp folder never copies from the real one', () => {
    expect(oldConfigDir({ OPEN_AFLOW_CONFIG_DIR: 'D:\cfg', APPDATA: 'C:\A' }, 'win32', 'C:\Users\me')).toBeUndefined()
    expect(oldConfigDir({ OPEN_AFLOW_CONFIG_DIR: '/tmp/cfg' }, 'linux', '/home/me')).toBeUndefined()
    // Empty counts as unset, as it does for configPath.
    expect(oldConfigDir({ OPEN_AFLOW_CONFIG_DIR: '', APPDATA: 'C:\A' }, 'win32', 'C:\Users\me')).toBe('C:\A\pod-board')
  })
})
