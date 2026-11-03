// Glue: real toasts, the server's Boards, and the tray dot's value on the bus. The logic is in the plain
// modules. The rules are in pod-docs/feature-details/toasts.md.

import { app, Notification } from 'electron'
import { createBoardStream } from './board-stream.ts'
import { createNotifier, type Toast } from './notifier.ts'
import type { ShellContext } from './shell-main.ts'

export function startNotifier(ctx: ShellContext): void {
  // Windows drops a click when nothing holds the toast, so each one stays here until it closes.
  const open = new Set<Notification>()
  const send = (toast: Toast) => {
    const note = new Notification({ title: toast.title, body: toast.body })
    open.add(note)
    note.on('click', () => ctx.bus.showWindow(toast.hash))
    note.on('close', () => open.delete(note))
    note.on('failed', () => {
      open.delete(note)
      console.error('pod-board desktop: toast failed')
    })
    note.show()
    console.log('pod-board desktop: toast sent')
  }

  const notifier = createNotifier({
    now: () => Date.now(),
    supported: () => Notification.isSupported(),
    send,
    setAttention: (on) => ctx.bus.setAttention(on),
    onError: (error) => console.error('pod-board desktop: notifier error:', error),
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
