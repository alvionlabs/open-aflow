export type TrayMenuItem = { label: string; type?: 'checkbox'; checked?: boolean; click(): void }
export const trayMenu = (_o: { loginOn: boolean; onOpen(): void; onLogin(on: boolean): void; onQuit(): void }): TrayMenuItem[] => []
