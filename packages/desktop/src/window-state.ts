export type Rect = { x: number; y: number; width: number; height: number }
export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean }
export const DEFAULT_STATE: WindowState = { width: 0, height: 0, maximized: false }
export const readWindowState = (_file: string, _displays: Rect[]): WindowState => ({ width: 1, height: 1, maximized: false })
export const saveWindowState = (_file: string, _state: WindowState): void => {}
