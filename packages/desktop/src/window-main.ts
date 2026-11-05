// Glue: the window and the tray. The rules are in window-rules, window-state, tray-menu, and login-item (the --hidden start).

import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { isLoginStart } from './login-item.ts'
import { APP_NAME } from './shell-config.ts'
import type { ShellContext } from './shell-main.ts'
import { trayMenu } from './tray-menu.ts'
import { createWindowFlow, navigateAction, newWindowAction, windowOptions, type WindowHandle } from './window-rules.ts'
import { readWindowState, saveWindowState } from './window-state.ts'

// Kept here so the tray isn't collected. A collected tray leaves the notification area.
let tray: Tray | undefined

const openExternal = (url: string) => void shell.openExternal(url).catch(() => {})

export function startWindow(ctx: ShellContext): void {
  const { bus, host } = ctx
  const stateFile = join(app.getPath('userData'), 'window-state.json')
  const assets = join(app.getAppPath(), 'assets')
  // A path with no file gives an empty image: an empty tray icon, and no throw.
  const icon = (name: string) => nativeImage.createFromPath(join(assets, name))

  const openWindow = (url: string): WindowHandle => {
    const state = readWindowState(
      stateFile,
      screen.getAllDisplays().map((d) => d.workArea),
    )
    const { maximized, ...bounds } = state
    const win = new BrowserWindow(windowOptions(bounds))
    const load = (next: string) => void win.loadURL(next).catch(() => {})
    const save = () => {
      if (!win.isDestroyed()) saveWindowState(stateFile, { ...win.getNormalBounds(), maximized: win.isMaximized() })
    }

    win.webContents.setWindowOpenHandler((details) => {
      if (newWindowAction(details.url, flow.origin() ?? '') === 'external') openExternal(details.url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => {
      const action = navigateAction(e.url, flow.origin() ?? '')
      if (action === 'allow') return
      e.preventDefault()
      if (action === 'external') openExternal(e.url)
    })
    win.on('session-end', () => {
      flow.sessionEnded()
      save()
    })
    win.on('hide', save)
    win.on('close', (e) => {
      if (flow.closeAction() === 'close') {
        save()
        return
      }
      e.preventDefault()
      win.hide()
    })
    win.on('closed', () => flow.closed())
    win.once('ready-to-show', () => {
      if (maximized) win.maximize()
      flow.painted()
    })
    load(url)

    return {
      reveal() {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      },
      // A same-document change, so the page keeps its state. Electron runs it once the page has loaded.
      setHash: (hash) => void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {}),
      load,
      reload: () => win.webContents.reload(),
      currentUrl: () => win.webContents.getURL(),
    }
  }

  const flow = createWindowFlow({ hiddenStart: isLoginStart(process.argv), open: openWindow })

  // Tray first: a login start has nothing else on the screen.
  tray = new Tray(icon('tray.png'))
  tray.setToolTip(APP_NAME)
  tray.on('click', () => bus.showWindow())
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu({ onOpen: () => bus.showWindow(), onQuit: () => app.quit() })))
  bus.onAttention((on) => tray?.setImage(icon(on ? 'tray-dot.png' : 'tray.png')))

  // shell-main's listener holds the quit. This one lets the window close when the quit goes through.
  app.on('before-quit', () => flow.quitting())
  app.on('will-quit', () => {
    tray?.destroy()
    tray = undefined
  })
  bus.onShowWindow((hash) => flow.show(hash))
  host.onReady((port) => flow.ready(port))
}
