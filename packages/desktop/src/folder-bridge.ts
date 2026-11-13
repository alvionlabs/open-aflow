// The folder bridge's rules: who may ask for the folder dialog, one dialog at a time, and what the page gets back.
// preload-main.ts and the ipcMain glue in window-main.ts use them. The rules are in pod-docs/feature-details/desktop.md.

export const PICK_FOLDER_CHANNEL = 'openaflow:pick-folder'

export const DIALOG_OPTIONS = { title: 'Add repo', properties: ['openDirectory'] as Array<'openDirectory'> }

export type DialogOptions = typeof DIALOG_OPTIONS
export type DialogResult = { canceled: boolean; filePaths: string[] }

/** Plain facts about an IPC caller, read by the glue from the event. */
export type BridgeCaller<W> = {
  /** The window that holds the caller, or undefined. */
  window: W | undefined
  /** False for a subframe, or for an event with no frame. */
  isMainFrame: boolean
  /** The frame's URL now. */
  url: string
}

export type BridgeReply = { path: string | null } | { error: 'forbidden' | 'dialog failed' }

/** Only the app window's main frame, on the server's current origin. Before the server is ready, nobody. */
function allowed<W>(caller: BridgeCaller<W>, origin: string | undefined, appWindow: W | undefined): boolean {
  if (origin === undefined || appWindow === undefined || caller.window !== appWindow || !caller.isMainFrame) return false
  try {
    return new URL(caller.url).origin === origin
  } catch {
    return false
  }
}

export function createFolderBridge<W>(o: {
  /** The server's origin, or undefined before the server is ready. */
  origin(): string | undefined
  /** The app window, or undefined when it is closed. */
  appWindow(): W | undefined
  showOpenDialog(parent: W, options: DialogOptions): Promise<DialogResult>
  log?(message: string): void
}): { pick(caller: BridgeCaller<W>): Promise<BridgeReply> } {
  let open = false
  return {
    async pick(caller) {
      const parent = o.appWindow()
      if (parent === undefined || !allowed(caller, o.origin(), parent)) return { error: 'forbidden' }
      // A second click while the dialog is up: the first call answers.
      if (open) return { path: null }
      open = true
      try {
        const result = await o.showOpenDialog(parent, DIALOG_OPTIONS)
        const first = result.filePaths[0]
        return { path: result.canceled || first === undefined || first === '' ? null : first }
      } catch (err) {
        o.log?.(`openaflow desktop: the folder dialog failed: ${err instanceof Error ? err.message : String(err)}`)
        return { error: 'dialog failed' }
      } finally {
        open = false
      }
    },
  }
}

/** The preload's side: a reply becomes the value of `pickFolder()`, or a rejection with the reply's word. */
export function answerOf(reply: unknown): string | null {
  if (typeof reply === 'object' && reply !== null) {
    if ('path' in reply && (reply.path === null || typeof reply.path === 'string')) return reply.path
    if ('error' in reply && reply.error === 'forbidden') throw new Error('forbidden')
  }
  throw new Error('dialog failed')
}
