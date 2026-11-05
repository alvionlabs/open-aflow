// Start at login. A settings page will use createLoginItem: nothing in the app turns it on today, though a login
// item an earlier version wrote still starts the app with --hidden. Nothing writes until the user toggles it. On Windows a read
// compares the arguments too, so a read and a write always carry the same ones.

export const HIDDEN_FLAG = '--hidden'

export type LoginPlace = { packaged: boolean; appPath: string }
export type LoginOptions = { openAtLogin: boolean; args: string[] }
export type LoginApi = { get(query: { args: string[] }): { openAtLogin: boolean }; set(options: LoginOptions): void }

/** Unpackaged, Electron's exe needs the app's folder as well. */
const loginArgs = (p: LoginPlace) => (p.packaged ? [HIDDEN_FLAG] : [p.appPath, HIDDEN_FLAG])

export function loginItemOptions(on: boolean, p: LoginPlace): LoginOptions {
  return { openAtLogin: on, args: loginArgs(p) }
}

export function isLoginStart(argv: string[]): boolean {
  return argv.includes(HIDDEN_FLAG)
}

export function createLoginItem(o: LoginPlace & { api: LoginApi }) {
  const isOn = () => o.api.get({ args: loginArgs(o) }).openAtLogin
  return {
    isOn,
    /** Answers what a read returns after the write, not what was asked for. */
    set(on: boolean): boolean {
      try {
        o.api.set(loginItemOptions(on, o))
      } catch {
        // The read below tells the truth.
      }
      return isOn()
    },
  }
}
