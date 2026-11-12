// Hides each window that still exists. No `electron` import: the glue passes `BrowserWindow.getAllWindows()`.

export type Hideable = { isDestroyed(): boolean; hide(): void }

export function hideWindows(windows: readonly Hideable[]): void {
  for (const win of windows) {
    try {
      if (!win.isDestroyed()) win.hide()
    } catch {
      // A window that's gone needs no hiding.
    }
  }
}
