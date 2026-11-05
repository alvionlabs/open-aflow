import { describe, expect, test, vi } from 'vitest'
import { trayMenu } from './tray-menu.ts'

const menu = () => {
  const on = { onOpen: vi.fn(), onQuit: vi.fn() }
  return { on, items: trayMenu(on) }
}

describe('tray menu', () => {
  test('the tray menu is Open and Quit, as plain rows', () => {
    const { on, items } = menu()
    expect(items.map((i) => i.label)).toEqual(['Open', 'Quit'])
    for (const row of items) {
      expect(row).not.toHaveProperty('type')
      expect(row).not.toHaveProperty('checked')
    }

    items[0]!.click()
    expect(on.onOpen).toHaveBeenCalledOnce()
    expect(on.onQuit).not.toHaveBeenCalled()
    items[1]!.click()
    expect(on.onQuit).toHaveBeenCalledOnce()
  })
})
