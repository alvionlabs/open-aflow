import { describe, expect, test, vi } from 'vitest'
import { createLoginItem, isLoginStart, loginItemOptions } from './login-item.ts'

const APP = 'E:\\app\\packages\\desktop'

const fakeApi = (openAtLogin = false) => {
  const api = {
    openAtLogin,
    get: vi.fn((_q: { args: string[] }) => ({ openAtLogin: api.openAtLogin })),
    set: vi.fn((o: { openAtLogin: boolean; args: string[] }) => void (api.openAtLogin = o.openAtLogin)),
  }
  return api
}

describe('login item', () => {
  test('login item options', () => {
    const unpackaged = { packaged: false, appPath: APP }
    expect(loginItemOptions(true, unpackaged)).toEqual({ openAtLogin: true, args: [APP, '--hidden'] })
    expect(loginItemOptions(false, unpackaged)).toEqual({ openAtLogin: false, args: [APP, '--hidden'] })
    const packaged = { packaged: true, appPath: APP }
    expect(loginItemOptions(true, packaged)).toEqual({ openAtLogin: true, args: ['--hidden'] })
    expect(loginItemOptions(false, packaged)).toEqual({ openAtLogin: false, args: ['--hidden'] })
  })

  test('a login start stays in the tray', () => {
    expect(isLoginStart(['electron.exe', APP, '--hidden'])).toBe(true)
    expect(isLoginStart(['Pod Board.exe', '--hidden'])).toBe(true)
    expect(isLoginStart(['electron.exe', APP])).toBe(false)
    expect(isLoginStart(['electron.exe', '--hidden-other', 'x--hidden'])).toBe(false)
  })

  test('off by default', () => {
    const api = fakeApi()
    const item = createLoginItem({ api, packaged: false, appPath: APP })
    expect(item.isOn()).toBe(false)
    expect(api.set).not.toHaveBeenCalled()
  })

  test('a read uses the same args as the write', () => {
    const api = fakeApi()
    createLoginItem({ api, packaged: true, appPath: APP }).isOn()
    expect(api.get).toHaveBeenCalledWith({ args: ['--hidden'] })
    const unpackaged = fakeApi()
    createLoginItem({ api: unpackaged, packaged: false, appPath: APP }).isOn()
    expect(unpackaged.get).toHaveBeenCalledWith({ args: [APP, '--hidden'] })
  })

  test('a toggle writes, then answers what a read returns', () => {
    const api = fakeApi()
    const item = createLoginItem({ api, packaged: false, appPath: APP })
    expect(item.set(true)).toBe(true)
    expect(api.set).toHaveBeenCalledWith({ openAtLogin: true, args: [APP, '--hidden'] })
    expect(item.set(false)).toBe(false)
    expect(api.set).toHaveBeenLastCalledWith({ openAtLogin: false, args: [APP, '--hidden'] })
    // A write that doesn't take: the read wins.
    api.set.mockImplementation(() => {})
    expect(item.set(true)).toBe(false)
  })

  test('a write that throws still answers what a read returns', () => {
    const api = fakeApi(true)
    api.set.mockImplementation(() => {
      throw new Error('registry says no')
    })
    expect(createLoginItem({ api, packaged: false, appPath: APP }).set(false)).toBe(true)
  })
})
