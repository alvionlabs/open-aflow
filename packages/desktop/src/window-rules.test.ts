import { describe, expect, test, vi } from 'vitest'
import { afterRestart, closeAction, createWindowFlow, hashOf, navigateAction, newWindowAction, originOf, windowOptions, windowUrl, type WindowHandle } from './window-rules.ts'

const ORIGIN = originOf(3130)

const fakeWindow = (url = '') => {
  const win = {
    url,
    reveal: vi.fn(),
    setHash: vi.fn(),
    load: vi.fn((next: string) => void (win.url = next)),
    reload: vi.fn(),
    currentUrl: () => win.url,
  }
  return win satisfies WindowHandle
}

const flowWith = (o: { hiddenStart?: boolean } = {}) => {
  const opened: { url: string; win: ReturnType<typeof fakeWindow> }[] = []
  const flow = createWindowFlow({
    hiddenStart: o.hiddenStart ?? false,
    open: (url) => {
      const win = fakeWindow(url)
      opened.push({ url, win })
      return win
    },
  })
  return { flow, opened }
}

describe('windowOptions', () => {
  test('the window is plain and isolated', () => {
    const o = windowOptions({ width: 1280, height: 800 })
    expect(o).toMatchObject({ width: 1280, height: 800, minWidth: 800, minHeight: 600, show: false, backgroundColor: '#000000' })
    expect(o.webPreferences).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    // The normal Windows frame: nothing here changes it, and no preload reaches the page.
    for (const key of ['frame', 'titleBarStyle', 'titleBarOverlay', 'transparent']) expect(o).not.toHaveProperty(key)
    expect(o.webPreferences).not.toHaveProperty('preload')
  })

  test('a saved place carries through', () => {
    expect(windowOptions({ x: -1000, y: 20, width: 900, height: 700 })).toMatchObject({ x: -1000, y: 20, width: 900, height: 700 })
  })
})

describe('closeAction', () => {
  test('close hides to the tray', () => {
    expect(closeAction({ quitting: false, sessionEnded: false })).toBe('hide')
    expect(closeAction({ quitting: true, sessionEnded: false })).toBe('close')
    expect(closeAction({ quitting: false, sessionEnded: true })).toBe('close')
  })
})

describe('link rules', () => {
  test('links go to the system browser', () => {
    expect(newWindowAction('https://cli.github.com/', ORIGIN)).toBe('external')
    expect(newWindowAction('http://example.com/a?b=1#c', ORIGIN)).toBe('external')
    // Another port on one host is another origin.
    expect(newWindowAction('http://127.0.0.1:9/', ORIGIN)).toBe('external')
    expect(newWindowAction(`${ORIGIN}/`, ORIGIN)).toBe('deny')
    expect(newWindowAction(`${ORIGIN}/#/repo/plan`, ORIGIN)).toBe('deny')
    for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'ms-settings:display', 'vscode://x', 'about:blank', 'data:text/html,x', 'not a url', '']) {
      expect(newWindowAction(url, ORIGIN), url).toBe('deny')
    }
  })

  test('the window stays on the board', () => {
    expect(navigateAction(`${ORIGIN}/`, ORIGIN)).toBe('allow')
    expect(navigateAction(`${ORIGIN}/x#/y`, ORIGIN)).toBe('allow')
    expect(navigateAction('https://cli.github.com/', ORIGIN)).toBe('external')
    // A host that only starts with the board's origin is off-origin.
    expect(navigateAction(`${ORIGIN}.evil.example/`, ORIGIN)).toBe('external')
    for (const url of ['file:///C:/a.txt', 'javascript:alert(1)', 'pod://x', 'not a url']) expect(navigateAction(url, ORIGIN), url).toBe('deny')
    // The origin follows the current port: the old one is now off-origin.
    expect(navigateAction(`${ORIGIN}/`, originOf(3999))).toBe('external')
    expect(navigateAction(`${originOf(3999)}/`, originOf(3999))).toBe('allow')
  })
})

describe('window URLs', () => {
  test('a URL takes a port and a hash', () => {
    expect(windowUrl(3130)).toBe('http://127.0.0.1:3130/')
    expect(windowUrl(3130, '')).toBe('http://127.0.0.1:3130/')
    expect(windowUrl(3130, '#/a/b%20c')).toBe('http://127.0.0.1:3130/#/a/b%20c')
    expect(windowUrl(3130, '/a')).toBe('http://127.0.0.1:3130/#/a')
  })

  test('hashOf reads a kept hash', () => {
    expect(hashOf('http://127.0.0.1:1/#/a/b%20c')).toBe('#/a/b%20c')
    expect(hashOf('http://127.0.0.1:1/')).toBeUndefined()
    expect(hashOf('')).toBeUndefined()
  })

  test('a restart moves the window to the new port', () => {
    expect(afterRestart('http://127.0.0.1:3130/#/repo/plan/board', 3999)).toEqual({ kind: 'load', url: 'http://127.0.0.1:3999/#/repo/plan/board' })
    expect(afterRestart('http://127.0.0.1:3130/', 3999)).toEqual({ kind: 'load', url: 'http://127.0.0.1:3999/' })
    // One port, one URL: a load could keep the page, and the page needs the new token.
    expect(afterRestart('http://127.0.0.1:3130/#/repo', 3130)).toEqual({ kind: 'reload' })
    // A window with no page yet, or on Chromium's error page, loads.
    expect(afterRestart('', 3130)).toEqual({ kind: 'load', url: 'http://127.0.0.1:3130/' })
    expect(afterRestart('chrome-error://chromewebdata/', 3130)).toEqual({ kind: 'load', url: 'http://127.0.0.1:3130/' })
  })
})

describe('the window flow', () => {
  test('no window opens before the first ready', () => {
    const { flow, opened } = flowWith()
    flow.show()
    flow.show('#/a')
    expect(opened).toEqual([])
    expect(flow.origin()).toBeUndefined()
  })

  test('the first ready opens the window', () => {
    const { flow, opened } = flowWith()
    flow.ready(3130)
    expect(opened.map((o) => o.url)).toEqual(['http://127.0.0.1:3130/'])
    expect(flow.origin()).toBe('http://127.0.0.1:3130')
    flow.painted()
    expect(opened[0]!.win.reveal).toHaveBeenCalledOnce()
  })

  test('a show before the first ready runs on ready, with its hash', () => {
    const { flow, opened } = flowWith()
    flow.show('#/a')
    flow.ready(3130)
    expect(opened.map((o) => o.url)).toEqual(['http://127.0.0.1:3130/#/a'])
    expect(opened[0]!.win.setHash).not.toHaveBeenCalled()
  })

  test('a later show without a hash keeps the earlier hash', () => {
    const { flow, opened } = flowWith()
    flow.show('#/a')
    flow.show()
    flow.ready(3130)
    expect(opened.map((o) => o.url)).toEqual(['http://127.0.0.1:3130/#/a'])
  })

  test('a login start stays in the tray until a show', () => {
    const { flow, opened } = flowWith({ hiddenStart: true })
    flow.ready(3130)
    expect(opened).toEqual([])
    flow.ready(3999)
    expect(opened).toEqual([])
    flow.show('#/a')
    expect(opened.map((o) => o.url)).toEqual(['http://127.0.0.1:3999/#/a'])
  })

  test('a login start with a show before ready opens on ready', () => {
    const { flow, opened } = flowWith({ hiddenStart: true })
    flow.show()
    flow.ready(3130)
    expect(opened).toHaveLength(1)
  })

  test('a show on an open window reveals it and sets the hash', () => {
    const { flow, opened } = flowWith()
    flow.ready(3130)
    const win = opened[0]!.win
    flow.show()
    expect(win.reveal).toHaveBeenCalledOnce()
    expect(win.setHash).not.toHaveBeenCalled()
    flow.show('#/b')
    expect(win.reveal).toHaveBeenCalledTimes(2)
    expect(win.setHash).toHaveBeenCalledWith('#/b')
    expect(win.load).not.toHaveBeenCalled()
    expect(opened).toHaveLength(1)
  })

  test('a later ready moves the window and keeps its hash', () => {
    const { flow, opened } = flowWith()
    flow.ready(3130)
    const win = opened[0]!.win
    win.url = 'http://127.0.0.1:3130/#/moved/here'
    flow.ready(3999)
    expect(win.load).toHaveBeenCalledWith('http://127.0.0.1:3999/#/moved/here')
    expect(flow.origin()).toBe('http://127.0.0.1:3999')
    // A move never brings a hidden window up.
    expect(win.reveal).not.toHaveBeenCalled()
    expect(opened).toHaveLength(1)
  })

  test('a later ready on the same port reloads', () => {
    const { flow, opened } = flowWith()
    flow.ready(3130)
    const win = opened[0]!.win
    flow.ready(3130)
    expect(win.reload).toHaveBeenCalledOnce()
    expect(win.load).not.toHaveBeenCalled()
  })

  test('a later ready before the first page commits keeps the first hash', () => {
    const { flow, opened } = flowWith()
    flow.show('#/a')
    flow.ready(3130)
    const win = opened[0]!.win
    win.url = ''
    flow.ready(3999)
    expect(win.load).toHaveBeenCalledWith('http://127.0.0.1:3999/#/a')
  })

  test('close follows the quit and the session end', () => {
    const quit = flowWith().flow
    expect(quit.closeAction()).toBe('hide')
    quit.quitting()
    expect(quit.closeAction()).toBe('close')
    const end = flowWith().flow
    end.sessionEnded()
    expect(end.closeAction()).toBe('close')
  })

  test('nothing comes up once the quit has begun', () => {
    const { flow, opened } = flowWith()
    flow.ready(3130)
    const win = opened[0]!.win
    flow.quitting()
    flow.show('#/a')
    flow.painted()
    flow.ready(3999)
    expect(win.reveal).not.toHaveBeenCalled()
    expect(win.setHash).not.toHaveBeenCalled()
    expect(win.load).not.toHaveBeenCalled()
    expect(opened).toHaveLength(1)
  })

  test('a show before ready during a quit opens nothing', () => {
    const { flow, opened } = flowWith()
    flow.show()
    flow.quitting()
    flow.ready(3130)
    expect(opened).toEqual([])
  })

  test('a closed window opens again on the next show', () => {
    const { flow, opened } = flowWith()
    flow.ready(3130)
    flow.closed()
    flow.show()
    expect(opened).toHaveLength(2)
  })
})
