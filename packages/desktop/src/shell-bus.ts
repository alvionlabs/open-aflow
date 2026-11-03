// Where the slices of the shell meet: a toast, the tray, or a second launch asks for the window, and
// the notifier sets the tray's dot.

export type ShellBus = {
  /** From a toast, the tray, or a second launch. */
  showWindow(hash?: string): void
  /** A call before the first listener attaches is kept, and the last one runs on attach. */
  onShowWindow(fn: (hash: string | undefined) => void): void
  /** From the notifier. */
  setAttention(on: boolean): void
  /** Fires at once with the current value; a repeat of one value doesn't fire. */
  onAttention(fn: (on: boolean) => void): void
}

export function createShellBus(): ShellBus {
  const showListeners: ((hash: string | undefined) => void)[] = []
  const attentionListeners: ((on: boolean) => void)[] = []
  let kept: { hash: string | undefined } | undefined
  let attention = false
  return {
    showWindow(hash) {
      if (showListeners.length === 0) kept = { hash }
      for (const fn of showListeners) fn(hash)
    },
    onShowWindow(fn) {
      showListeners.push(fn)
      if (kept) {
        const { hash } = kept
        kept = undefined
        fn(hash)
      }
    },
    setAttention(on) {
      if (on === attention) return
      attention = on
      for (const fn of attentionListeners) fn(on)
    },
    onAttention(fn) {
      attentionListeners.push(fn)
      fn(attention)
    },
  }
}
