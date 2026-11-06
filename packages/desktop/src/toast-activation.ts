// A toast that a click can still find after it left the screen. Windows calls the app's activator for a click in the
// notification center, with the toast's `launch` text and nothing else, so the toast carries its run. The rules are in
// pod-docs/feature-details/toasts.md.

const LAUNCH_PREFIX = 'open-aflow-toast:'
/** A board hash: `#/<repo>`, and more path after it. */
const BOARD_HASH = /^#\/\S+$/

export type ShortcutRead = { target: string; toastActivatorClsid?: string }

const escapeXml = (text: string) =>
  text
    // XML can't hold these, and one makes Windows refuse the whole toast. Tab, newline, and CR stay. With the `u` flag
    // a surrogate pair is one character, so an emoji stays, and only a surrogate with no partner matches.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff￾￿]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export function toastXml(toast: { title: string; body: string; hash: string }): string {
  const launch = escapeXml(`${LAUNCH_PREFIX}${toast.hash}`)
  return `<toast launch="${launch}" activationType="foreground"><visual><binding template="ToastGeneric"><text>${escapeXml(toast.title)}</text><text>${escapeXml(toast.body)}</text></binding></visual></toast>`
}

/** The run a click names. Undefined for anything else, such as a toast from before this version: the window opens on no run. */
export function hashFromActivation(args: string): string | undefined {
  if (!args.startsWith(LAUNCH_PREFIX)) return undefined
  const hash = args.slice(LAUNCH_PREFIX.length)
  return BOARD_HASH.test(hash) ? hash : undefined
}

/**
 * The CLSID this run must register. Windows reads it from the Start-menu shortcut, and Electron picks a new random one
 * at each start until its first toast, so a click before that toast would start a second copy and lose its run. Only
 * this exe's own shortcut counts. Undefined leaves Electron's choice, which it stamps on the shortcut at the first toast.
 */
export function activatorClsid(shortcut: ShortcutRead | undefined, execPath: string): string | undefined {
  if (!shortcut || shortcut.target.toLowerCase() !== execPath.toLowerCase()) return undefined
  return shortcut.toastActivatorClsid || undefined
}
