// The desktop shell's bridge, read in one place. The desktop app's preload puts `window.openaflow` on the page;
// the browser build has none.

export type PickFolder = () => Promise<string | null>

/**
 * The desktop shell's folder dialog, or undefined in the browser build. It opens the system's folder
 * dialog (Windows, Linux, or macOS) and resolves to the chosen path, or null on cancel; it rejects with `forbidden` or `dialog failed`.
 */
export function folderBridge(win: unknown = globalThis.window): PickFolder | undefined {
  if (typeof win !== 'object' || win === null) return undefined
  const bridge = (win as { openaflow?: unknown }).openaflow
  if (typeof bridge !== 'object' || bridge === null) return undefined
  const pick = (bridge as { pickFolder?: unknown }).pickFolder
  if (typeof pick !== 'function') return undefined
  return () => (pick as PickFolder).call(bridge)
}
