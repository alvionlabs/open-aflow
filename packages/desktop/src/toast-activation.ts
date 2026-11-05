// Stub, replaced in the next commit.
export type ShortcutRead = { target: string; toastActivatorClsid?: string }
export const toastXml = (_toast: { title: string; body: string; hash: string }): string => ''
export const hashFromActivation = (_args: string): string | undefined => '#/stub'
export const activatorClsid = (_shortcut: ShortcutRead | undefined, _execPath: string): string | undefined => '{stub}'
