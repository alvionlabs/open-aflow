import { describe, expect, test, vi } from 'vitest'
import { trayMenu } from './tray-menu.ts'

const menu = (loginOn: boolean) => {
  const on = { onOpen: vi.fn(), onLogin: vi.fn(), onQuit: vi.fn() }
  return { on, items: trayMenu({ loginOn, ...on }) }
}

describe('tray menu', () => {
  test('the tray menu', () => {
    const { on, items } = menu(false)
    expect(items.map((i) => i.label)).toEqual(['Open', 'Start at login', 'Quit'])
    expect(items[1]).toMatchObject({ type: 'checkbox', checked: false })
    expect(menu(true).items[1]).toMatchObject({ type: 'checkbox', checked: true })

    items[0]!.click()
    expect(on.onOpen).toHaveBeenCalledOnce()
    expect(on.onQuit).not.toHaveBeenCalled()
    items[2]!.click()
    expect(on.onQuit).toHaveBeenCalledOnce()
    expect(on.onLogin).not.toHaveBeenCalled()
  })

  test('the checkbox asks for the other value', () => {
    const off = menu(false)
    off.items[1]!.click()
    expect(off.on.onLogin).toHaveBeenCalledWith(true)
    const on = menu(true)
    on.items[1]!.click()
    expect(on.on.onLogin).toHaveBeenCalledWith(false)
  })
})
