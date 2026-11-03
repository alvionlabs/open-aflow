import { describe, expect, test, vi } from 'vitest'
import { createQuitFlow } from './quit-flow.ts'

type Result = 'stopped' | 'killed' | 'not running'

function setup(stopImpl?: () => Promise<Result>) {
  let finish!: (r: Result) => void
  const stop = vi.fn(stopImpl ?? (() => new Promise<Result>((resolve) => (finish = resolve))))
  const hide = vi.fn()
  const quit = vi.fn()
  const flow = createQuitFlow({ stop, hide, quit })
  const event = () => ({ preventDefault: vi.fn() })
  return { stop, hide, quit, flow, event, finish: (r: Result) => finish(r) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('quit', () => {
  test('quit waits for the server', async () => {
    const s = setup()

    const first = s.event()
    s.flow.beforeQuit(first)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(s.hide).toHaveBeenCalledOnce()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.quit).not.toHaveBeenCalled()

    // A repeat during the stop does nothing and never forces a quit.
    const repeat = s.event()
    s.flow.beforeQuit(repeat)
    expect(repeat.preventDefault).toHaveBeenCalledOnce()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.hide).toHaveBeenCalledOnce()
    await settle()
    expect(s.quit).not.toHaveBeenCalled()

    s.finish('stopped')
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()

    // The quit that follows goes through.
    const last = s.event()
    s.flow.beforeQuit(last)
    expect(last.preventDefault).not.toHaveBeenCalled()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.quit).toHaveBeenCalledOnce()

    // Killed and not running quit too.
    for (const result of ['killed', 'not running'] as const) {
      const other = setup()
      other.flow.beforeQuit(other.event())
      other.finish(result)
      await settle()
      expect(other.quit).toHaveBeenCalledOnce()
    }
  })

  test('a failed stop or a failed hide still quits', async () => {
    const s = setup(() => Promise.reject(new Error('no')))
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()

    const stop = vi.fn(async () => 'stopped' as const)
    const quit = vi.fn()
    const flow = createQuitFlow({
      stop,
      quit,
      hide: () => {
        throw new Error('window gone')
      },
    })
    flow.beforeQuit({ preventDefault: vi.fn() })
    await settle()
    expect(stop).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  test("a Windows shutdown doesn't wait", async () => {
    const s = setup()
    s.flow.sessionEnd()
    const e = s.event()
    s.flow.beforeQuit(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(s.stop).not.toHaveBeenCalled()
    expect(s.hide).not.toHaveBeenCalled()
    expect(s.quit).not.toHaveBeenCalled()
  })

  test('a session end during a stop lets the quit through', async () => {
    const s = setup()
    s.flow.beforeQuit(s.event())
    s.flow.sessionEnd()
    const e = s.event()
    s.flow.beforeQuit(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(s.stop).toHaveBeenCalledOnce()
  })
})
