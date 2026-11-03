// `app.quit()` is the one way to quit. The first `before-quit` holds the quit until the server has
// stopped. Nothing here forces a quit or ends another process, so a resumed `claude` keeps running.

export type QuitFlow = {
  beforeQuit(e: { preventDefault(): void }): void
  /** A Windows shutdown: nothing waits, and the server's parent watch does the rest. */
  sessionEnd(): void
}

export function createQuitFlow(o: { stop(): Promise<unknown>; hide(): void; quit(): void }): QuitFlow {
  let state: 'running' | 'stopping' | 'through' = 'running'
  const stopThenQuit = async () => {
    try {
      o.hide()
    } catch {
      // A window that's gone needs no hiding.
    }
    try {
      await o.stop()
    } catch {
      // Quit anyway: the host's own timeout has run, or there's nothing to wait for.
    }
    // A session end during the stop already let the quit through.
    if (state !== 'stopping') return
    state = 'through'
    o.quit()
  }
  return {
    beforeQuit(e) {
      if (state === 'through') return
      e.preventDefault()
      if (state === 'stopping') return
      state = 'stopping'
      void stopThenQuit()
    },
    sessionEnd() {
      state = 'through'
    },
  }
}
