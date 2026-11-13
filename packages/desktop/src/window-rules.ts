// The window's rules: its options, what a close does, where a link goes, and when the window opens, moves,
// or comes up. window-main.ts is the glue. The rules are in pod-docs/feature-details/desktop.md.

import { APP_NAME } from './shell-config.ts'

export const DEFAULT_WIDTH = 1280
export const DEFAULT_HEIGHT = 800
export const MIN_WIDTH = 800
export const MIN_HEIGHT = 600
/** The dark `--bg`, so no white shows before the page paints. */
const BACKGROUND = '#000000'

export type WindowBounds = { x?: number; y?: number; width: number; height: number }

/** `preload` is the bundled preload-main.ts, `dist/preload.cjs`. It is the page's one bridge: `window.openaflow.pickFolder()`. */
export function windowOptions(bounds: WindowBounds, preload: string) {
  return {
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: APP_NAME,
    show: false,
    backgroundColor: BACKGROUND,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
  }
}

export function closeAction(o: { quitting: boolean; sessionEnded: boolean }): 'hide' | 'close' {
  return o.quitting || o.sessionEnded ? 'close' : 'hide'
}

const readUrl = (url: string): URL | undefined => {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}
const isWeb = (u: URL) => u.protocol === 'http:' || u.protocol === 'https:'

/** A new window never opens in the app: off-origin web links go to the system browser. */
export function newWindowAction(url: string, origin: string): 'external' | 'deny' {
  const u = readUrl(url)
  return u && isWeb(u) && u.origin !== origin ? 'external' : 'deny'
}

export function navigateAction(url: string, origin: string): 'allow' | 'external' | 'deny' {
  const u = readUrl(url)
  if (!u || !isWeb(u)) return 'deny'
  return u.origin === origin ? 'allow' : 'external'
}

export const originOf = (port: number): string => `http://127.0.0.1:${port}`

export function windowUrl(port: number, hash?: string): string {
  const bare = (hash ?? '').replace(/^#/, '')
  return `${originOf(port)}/${bare === '' ? '' : `#${bare}`}`
}

export function hashOf(url: string): string | undefined {
  const hash = readUrl(url)?.hash
  return hash === undefined || hash === '' ? undefined : hash
}

/**
 * The page holds the old server's token, so a restart always loads it again. On one port a load
 * with a hash can stay in the same document, so that case is a reload.
 */
export function afterRestart(currentUrl: string, port: number): { kind: 'reload' } | { kind: 'load'; url: string } {
  if (readUrl(currentUrl)?.origin === originOf(port)) return { kind: 'reload' }
  return { kind: 'load', url: windowUrl(port, hashOf(currentUrl)) }
}

export type WindowHandle = {
  /** Restore, show, and focus. */
  reveal(): void
  setHash(hash: string): void
  load(url: string): void
  reload(): void
  /** Empty until the first page commits. */
  currentUrl(): string
}

export type WindowFlow = {
  /** Each ready of the server. The first opens the window, unless a login start keeps it in the tray. */
  ready(port: number): void
  show(hash?: string): void
  /** The new window has painted, so it can come up. */
  painted(): void
  closed(): void
  quitting(): void
  sessionEnded(): void
  closeAction(): 'hide' | 'close'
  /** The origin of the current port, for the link rules. */
  origin(): string | undefined
}

export function createWindowFlow(o: { hiddenStart: boolean; open(url: string): WindowHandle }): WindowFlow {
  let port: number | undefined
  let win: WindowHandle | undefined
  let firstUrl = ''
  let waiting: { hash: string | undefined } | undefined
  let quitting = false
  let sessionEnded = false

  const showNow = (p: number, hash: string | undefined) => {
    if (win) {
      win.reveal()
      if (hash !== undefined) win.setHash(hash)
      return
    }
    firstUrl = windowUrl(p, hash)
    win = o.open(firstUrl)
  }

  return {
    ready(next) {
      const isFirst = port === undefined
      port = next
      if (quitting) return
      if (isFirst) {
        const kept = waiting
        waiting = undefined
        if (kept) showNow(next, kept.hash)
        else if (!o.hiddenStart) showNow(next, undefined)
        return
      }
      if (!win) return
      const step = afterRestart(win.currentUrl() || firstUrl, next)
      if (step.kind === 'reload') win.reload()
      else win.load(step.url)
    },
    show(hash) {
      if (quitting) return
      if (port === undefined) {
        waiting = { hash: hash ?? waiting?.hash }
        return
      }
      showNow(port, hash)
    },
    painted() {
      if (!quitting) win?.reveal()
    },
    closed() {
      win = undefined
    },
    quitting() {
      quitting = true
    },
    sessionEnded() {
      sessionEnded = true
    },
    closeAction: () => closeAction({ quitting, sessionEnded }),
    origin: () => (port === undefined ? undefined : originOf(port)),
  }
}
