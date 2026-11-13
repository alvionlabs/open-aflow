// Glue: the window's preload, bundled to dist/preload.cjs. It runs sandboxed, so it may require only `electron`.
// The page gets exactly `window.openaflow.pickFolder()`. The rules are in folder-bridge.ts.

import { contextBridge, ipcRenderer } from 'electron'
import { answerOf, PICK_FOLDER_CHANNEL } from './folder-bridge.ts'

contextBridge.exposeInMainWorld('openaflow', {
  // A failed invoke (no handler, a closed window) reads as a failed dialog, never as Electron's own text.
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(PICK_FOLDER_CHANNEL).then(answerOf, () => {
      throw new Error('dialog failed')
    }),
})
