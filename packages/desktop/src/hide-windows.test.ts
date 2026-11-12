import { describe, expect, test, vi } from 'vitest'
import { hideWindows } from './hide-windows.ts'

const win = (o: { destroyed?: boolean; throws?: boolean } = {}) => ({
  isDestroyed: () => o.destroyed ?? false,
  hide: vi.fn(() => {
    if (o.throws) throw new Error('Object has been destroyed')
  }),
})

describe('hideWindows', () => {
  test('hides each window, skips a destroyed one, and goes on past a throw', () => {
    const live = win()
    const gone = win({ destroyed: true })
    const broken = win({ throws: true })
    const last = win()
    expect(() => hideWindows([live, gone, broken, last])).not.toThrow()
    expect(live.hide).toHaveBeenCalledOnce()
    expect(gone.hide).not.toHaveBeenCalled()
    expect(broken.hide).toHaveBeenCalledOnce()
    expect(last.hide).toHaveBeenCalledOnce()
  })

  test('no windows', () => {
    expect(() => hideWindows([])).not.toThrow()
  })
})
