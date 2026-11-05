// The tray's menu: Open and Quit. Start at login goes on a settings page later (pod-docs/decisions.md).

export type TrayMenuItem = { label: string; click(): void }

export function trayMenu(o: { onOpen(): void; onQuit(): void }): TrayMenuItem[] {
  return [
    { label: 'Open', click: () => o.onOpen() },
    { label: 'Quit', click: () => o.onQuit() },
  ]
}
