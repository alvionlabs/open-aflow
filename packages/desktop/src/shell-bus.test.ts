import { describe, expect, test, vi } from 'vitest'
import { createShellBus } from './shell-bus.ts'

describe('the shell bus', () => {
  test('slices meet on the bus', () => {
    const bus = createShellBus()

    // A show before a listener: the last one runs on attach, once.
    bus.showWindow('#/a')
    bus.showWindow('#/b')
    const show = vi.fn()
    bus.onShowWindow(show)
    expect(show.mock.calls).toEqual([['#/b']])
    bus.showWindow()
    expect(show.mock.calls).toEqual([['#/b'], [undefined]])

    // Attention fires at once with the current value, and a repeat doesn't fire.
    const attention = vi.fn()
    bus.onAttention(attention)
    expect(attention.mock.calls).toEqual([[false]])
    bus.setAttention(false)
    bus.setAttention(true)
    bus.setAttention(true)
    bus.setAttention(false)
    expect(attention.mock.calls).toEqual([[false], [true], [false]])
  })

  test('a later listener hears later shows but not the kept one', () => {
    const bus = createShellBus()
    bus.showWindow('#/kept')
    const first = vi.fn()
    const second = vi.fn()
    bus.onShowWindow(first)
    bus.onShowWindow(second)
    expect(first.mock.calls).toEqual([['#/kept']])
    expect(second).not.toHaveBeenCalled()
    bus.showWindow('#/next')
    expect(first).toHaveBeenLastCalledWith('#/next')
    expect(second).toHaveBeenLastCalledWith('#/next')
  })

  test('a show with no hash before a listener is kept too', () => {
    const bus = createShellBus()
    bus.showWindow()
    const show = vi.fn()
    bus.onShowWindow(show)
    expect(show.mock.calls).toEqual([[undefined]])
  })

  test('a late attention listener gets the current value', () => {
    const bus = createShellBus()
    bus.setAttention(true)
    const attention = vi.fn()
    bus.onAttention(attention)
    expect(attention.mock.calls).toEqual([[true]])
  })
})
