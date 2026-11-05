// The tray's menu: Open, Start at login, Quit. The words show `loginOn`, and a click asks for the other value.

export type TrayMenuItem = { label: string; click(): void }

export function trayMenu(o: { loginOn: boolean; onOpen(): void; onLogin(on: boolean): void; onQuit(): void }): TrayMenuItem[] {
  return [
    { label: 'Open', click: () => o.onOpen() },
    { label: `Start at login: ${o.loginOn ? 'On' : 'Off'}`, click: () => o.onLogin(!o.loginOn) },
    { label: 'Quit', click: () => o.onQuit() },
  ]
}
