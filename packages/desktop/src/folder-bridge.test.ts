import { describe, expect, test, vi } from 'vitest'
import { answerOf, createFolderBridge, type BridgeCaller, type DialogResult } from './folder-bridge.ts'
import { originOf } from './window-rules.ts'

type Win = { id: number }
const WIN: Win = { id: 1 }
const ORIGIN = originOf(3130)
const PAGE = `${ORIGIN}/#/repo/plan`

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const setup = (o: { origin?: string | undefined; win?: Win | undefined; result?: DialogResult } = {}) => {
  const state = { origin: 'origin' in o ? o.origin : ORIGIN, win: 'win' in o ? o.win : WIN }
  const showOpenDialog = vi.fn(async () => o.result ?? { canceled: false, filePaths: ['C:\\code\\repo'] })
  const log = vi.fn()
  const bridge = createFolderBridge<Win>({ origin: () => state.origin, appWindow: () => state.win, showOpenDialog, log })
  return { bridge, showOpenDialog, log, state }
}
const caller = (o: Partial<BridgeCaller<Win>> = {}): BridgeCaller<Win> => ({ window: WIN, isMainFrame: true, url: PAGE, ...o })

describe('folder bridge', () => {
  test('allowed caller opens the dialog', async () => {
    const { bridge, showOpenDialog } = setup()
    expect(await bridge.pick(caller())).toEqual({ path: 'C:\\code\\repo' })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(showOpenDialog).toHaveBeenCalledWith(WIN, { title: 'Add repo', properties: ['openDirectory'] })
    // Any path on the origin counts, the bare root too.
    expect(await bridge.pick(caller({ url: `${ORIGIN}/` }))).toEqual({ path: 'C:\\code\\repo' })
  })

  test('the first path wins', async () => {
    const { bridge } = setup({ result: { canceled: false, filePaths: ['C:\\a', 'C:\\b'] } })
    expect(await bridge.pick(caller())).toEqual({ path: 'C:\\a' })
  })

  test('cancel is null', async () => {
    expect(await setup({ result: { canceled: true, filePaths: [] } }).bridge.pick(caller())).toEqual({ path: null })
    // A cancel with a path left in it still reads as a cancel.
    expect(await setup({ result: { canceled: true, filePaths: ['C:\\a'] } }).bridge.pick(caller())).toEqual({ path: null })
    expect(await setup({ result: { canceled: false, filePaths: [] } }).bridge.pick(caller())).toEqual({ path: null })
    expect(await setup({ result: { canceled: false, filePaths: [''] } }).bridge.pick(caller())).toEqual({ path: null })
  })

  test('refuses other callers', async () => {
    const refused: Array<[string, BridgeCaller<Win>, { origin?: string | undefined; win?: Win | undefined }?]> = [
      ['another port', caller({ url: `${originOf(3131)}/` })],
      ['localhost for 127.0.0.1', caller({ url: 'http://localhost:3130/' })],
      ['https on the same port', caller({ url: 'https://127.0.0.1:3130/' })],
      ['file:', caller({ url: 'file:///C:/x/index.html' })],
      ['about:blank', caller({ url: 'about:blank' })],
      ['an empty url', caller({ url: '' })],
      ['not a url', caller({ url: 'not a url' })],
      ['a subframe', caller({ isMainFrame: false })],
      ['no window', caller({ window: undefined })],
      ['another window', caller({ window: { id: 2 } })],
      ['no origin yet', caller(), { origin: undefined }],
      ['the app window is closed', caller(), { win: undefined }],
    ]
    for (const [name, c, o] of refused) {
      const { bridge, showOpenDialog } = setup(o)
      expect(await bridge.pick(c), name).toEqual({ error: 'forbidden' })
      expect(showOpenDialog, name).not.toHaveBeenCalled()
    }
  })

  test('the old port is refused after a restart', async () => {
    const { bridge, showOpenDialog, state } = setup()
    state.origin = originOf(3140)
    expect(await bridge.pick(caller())).toEqual({ error: 'forbidden' })
    expect(await bridge.pick(caller({ url: `${originOf(3140)}/` }))).toEqual({ path: 'C:\\code\\repo' })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
  })

  test('one dialog at a time', async () => {
    const { bridge, showOpenDialog } = setup()
    const open = deferred<DialogResult>()
    showOpenDialog.mockImplementationOnce(() => open.promise)
    const first = bridge.pick(caller())
    expect(await bridge.pick(caller())).toEqual({ path: null })
    // A refused caller stays refused while a dialog is open.
    expect(await bridge.pick(caller({ url: 'about:blank' }))).toEqual({ error: 'forbidden' })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    open.resolve({ canceled: false, filePaths: ['C:\\first'] })
    expect(await first).toEqual({ path: 'C:\\first' })
    // Once it closes, the next call opens one again.
    expect(await bridge.pick(caller())).toEqual({ path: 'C:\\code\\repo' })
    expect(showOpenDialog).toHaveBeenCalledTimes(2)
  })

  test('dialog error', async () => {
    const { bridge, showOpenDialog, log } = setup()
    showOpenDialog.mockRejectedValueOnce(new Error('no parent'))
    expect(await bridge.pick(caller())).toEqual({ error: 'dialog failed' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no parent'))
    // A throw that isn't an Error, and a sync throw.
    showOpenDialog.mockRejectedValueOnce('odd')
    expect(await bridge.pick(caller())).toEqual({ error: 'dialog failed' })
    showOpenDialog.mockImplementationOnce(() => {
      throw new Error('sync')
    })
    expect(await bridge.pick(caller())).toEqual({ error: 'dialog failed' })
    // The next call works.
    expect(await bridge.pick(caller())).toEqual({ path: 'C:\\code\\repo' })
  })
})

describe('answerOf', () => {
  test('a path or null passes through', () => {
    expect(answerOf({ path: 'C:\\a' })).toBe('C:\\a')
    expect(answerOf({ path: null })).toBeNull()
  })

  test('an error becomes a rejection with its word', () => {
    expect(() => answerOf({ error: 'forbidden' })).toThrow(new Error('forbidden'))
    expect(() => answerOf({ error: 'dialog failed' })).toThrow(new Error('dialog failed'))
  })

  test('anything else fails', () => {
    for (const reply of [undefined, null, 'C:\\a', {}, { path: 3 }, { error: 'other' }]) {
      expect(() => answerOf(reply), JSON.stringify(reply)).toThrow(new Error('dialog failed'))
    }
  })
})
