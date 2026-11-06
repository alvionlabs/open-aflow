// Glue: real toasts, the server's Boards, and the tray dot's value on the bus. The logic is in the plain
// modules. The rules are in pod-docs/feature-details/toasts.md.

import { join } from 'node:path'
import { app, Notification, shell } from 'electron'
import { createBoardStream } from './board-stream.ts'
import { createNotifier, type Toast } from './notifier.ts'
import { APP_NAME } from './shell-config.ts'
import type { ShellContext } from './shell-main.ts'
import { activatorClsid, hashFromActivation, toastXml, type ShortcutRead } from './toast-activation.ts'

/** The Start-menu shortcut the installer writes. Undefined when there is none. */
function readShortcut(): ShortcutRead | undefined {
  try {
    return shell.readShortcutLink(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`))
  } catch {
    return undefined
  }
}

export function startNotifier(ctx: ShellContext): void {
  // A click in the notification center reaches only this: a toast's own `click` ends when the toast leaves the screen.
  Notification.handleActivation((details) => ctx.bus.showWindow(hashFromActivation(details.arguments)))
  if (ctx.activatorAtStart) {
    const clsid = activatorClsid(readShortcut(), process.execPath)
    if (clsid !== undefined) app.setToastActivatorCLSID(clsid)
    // This registers the activator, so a click works before this run's first toast, and on a start that the click caused.
    Notification.isSupported()
  }

  // A banner's click comes here too. Windows drops it when nothing holds the toast, so each one stays until it closes.
  const open = new Set<Notification>()
  const send = (toast: Toast) => {
    const note = new Notification({ toastXml: toastXml(toast) })
    open.add(note)
    note.on('click', () => ctx.bus.showWindow(toast.hash))
    note.on('close', () => open.delete(note))
    note.on('failed', () => {
      open.delete(note)
      console.error('open-aflow desktop: toast failed')
    })
    note.show()
    console.log('open-aflow desktop: toast sent')
  }

  const notifier = createNotifier({
    now: () => Date.now(),
    supported: () => Notification.isSupported(),
    send,
    setAttention: (on) => ctx.bus.setAttention(on),
    onError: (error) => console.error('open-aflow desktop: notifier error:', error),
  })
  const stream = createBoardStream({
    fetch: (url, init) => fetch(url, init),
    onBoard: (board) => notifier.board(board),
    onLost: () => notifier.lost(),
  })
  ctx.host.onReady((port) => stream.moveTo(port))

  // A quit always goes through once it starts. A toast from here on would open a window that is closing.
  app.once('before-quit', () => {
    stream.close()
    notifier.close()
  })
}
