// When the app checks for an update, when it asks, and what a Restart now does. No `electron` import: the glue is in
// updater-main.ts. The rules are in pod-docs/feature-details/installer-and-updates.md.

import { HIDDEN_FLAG } from './login-item.ts'
import { APP_NAME } from './shell-config.ts'

export const FIRST_CHECK_MS = 30_000
export const RECHECK_MS = 6 * 60 * 60_000
/** After a server failure: how long the check and the download may take. An open box has no limit. */
export const LAST_CHANCE_MS = 10 * 60_000
/** From the call to the installer: if the app still runs after this, it quits. */
export const INSTALL_LIMIT_MS = 2 * 60_000

/** The GitHub repo that publishes the releases. build-config.ts takes its `publish` from here. */
export const RELEASE_REPO = { owner: 'alvionlabs', repo: 'openaflow' } as const
/** Where a user gets a new version by hand, when the app can't update itself. */
export const RELEASES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases`

/** The error box's text after the server failed for good. It names the check only when a check runs. */
export function failureText(error: string, willCheck: boolean): string {
  const next = willCheck
    ? `${APP_NAME} checks for an update before it closes. You can also get the latest version from ${RELEASES_URL}`
    : `Get the latest version from ${RELEASES_URL}`
  return `The server stopped and could not restart.\n\n${error}\n\n${next}`
}

/** A fresh start shows the window, so a login start's flag goes. */
export function relaunchArgs(argv: string[]): string[] {
  return argv.slice(1).filter((arg) => arg !== HIDDEN_FLAG)
}

const LOG = 'openaflow desktop: update'

export type UpdaterPort = {
  /** May resolve with the download that it started. */
  check(): Promise<{ downloadPromise?: Promise<unknown> | null | undefined } | null | undefined>
  /** Starts the installer, then quits. A failure can be a throw or an `onError`. */
  install(): void
  onDownloaded(fn: (version: string) => void): void
  onError(fn: (error: unknown) => void): void
}

export type UpdateFlowOptions = {
  packaged: boolean
  /** Called once, at the start of a packaged app. */
  updater(): UpdaterPort
  ask(version: string): Promise<'restart' | 'later'>
  stop(): Promise<unknown>
  quit(): void
  quitting(): boolean
  clock: { after(ms: number, fn: () => void): void }
  log(line: string): void
  firstCheckMs?: number | undefined
}

/** Never the message: electron-updater's messages hold URLs. */
function reason(error: unknown): string {
  const { code, message, name } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown; name?: unknown }
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code
  const net = typeof message === 'string' ? /net::ERR_[A-Z0-9_]+/.exec(message)?.[0] : undefined
  if (net) return net
  return typeof name === 'string' && /^\w+$/.test(name) ? name : 'unknown'
}

export type UpdateFlow = {
  /** Starts the checks. It doesn't wait for the server: a server that can't start must not block its own fix. */
  start(): void
  /** Whether lastChance checks: a packaged app whose updater started. */
  willCheck(): boolean
  /**
   * After the server failed for good: one check now. Resolves when the app may quit: no update, a failed check, a Later,
   * LAST_CHANCE_MS gone during the check or the download, or a reopen. It asks again for a version put off earlier in
   * this run. After a Restart now, it resolves only if the app still runs INSTALL_LIMIT_MS after the call to the installer.
   */
  lastChance(): Promise<void>
  /**
   * A second launch or the tray's Open. `show`: before lastChance. `wait`: a box is open, or a restart runs and the
   * installer starts the new copy. `relaunch`: lastChance resolves now, and the caller starts a fresh copy.
   */
  reopen(): 'show' | 'relaunch' | 'wait'
}

export function createUpdateFlow(o: UpdateFlowOptions): UpdateFlow {
  let port: UpdaterPort | undefined
  let started = false
  /** The check that runs now. */
  let running: Promise<void> | undefined
  /** The box and what follows it, for the version it asks about. */
  let boxDone: Promise<void> = Promise.resolve()
  let boxOpen = false
  let failureLogged = false
  /** `restarting` holds from the Restart now; `installing` from the call to the installer. */
  let restarting = false
  let installing = false
  let installFailed = false
  /** Each version asked about. lastChance clears it, so a Later from earlier in this run doesn't hold. */
  const asked = new Set<string>()
  /** The newest version downloaded in this run. */
  let newest: string | undefined
  /** `over` from the end of lastChance: the app quits, so no check runs and no box opens. */
  let phase: 'normal' | 'last chance' | 'over' = 'normal'
  let endWait = () => {}
  let installOver = () => {}
  const installEnded = new Promise<void>((resolve) => (installOver = resolve))

  const failInstall = (error: unknown) => {
    if (installFailed) return
    installFailed = true
    o.log(`${LOG} install failed, quitting: ${reason(error)}`)
    o.quit()
    installOver()
  }

  const failCheck = (error: unknown) => {
    if (failureLogged) return
    failureLogged = true
    o.log(`${LOG} check failed: ${reason(error)}`)
  }

  const onError = (error: unknown) => {
    if (installing) failInstall(error)
    else failCheck(error)
  }

  /** One check at a time: a second call gets the one that runs. */
  const check = (): Promise<void> => {
    if (running) return running
    if (boxOpen || restarting || phase === 'over' || o.quitting()) return Promise.resolve()
    failureLogged = false
    const run = (async () => {
      try {
        const result = await port!.check()
        await result?.downloadPromise
      } catch (error) {
        onError(error)
      }
    })()
    // Cleared after the assignment: a check that throws at once settles before `run` is set.
    running = run
    void run.finally(() => {
      if (running === run) running = undefined
    })
    return run
  }

  const tick = () => {
    void check()
    o.clock.after(RECHECK_MS, tick)
  }

  const restart = async () => {
    restarting = true
    try {
      await o.stop()
    } catch {
      // `stopped`, `killed`, and `not running` all go on, and so does this.
    }
    installing = true
    // quitAndInstall can fail with no error and no quit. The server is gone by then, so the app must not stay.
    o.clock.after(INSTALL_LIMIT_MS, () => {
      if (installFailed) return
      o.log(`${LOG} install did not quit, quitting`)
      o.quit()
      installOver()
    })
    try {
      port!.install()
    } catch (error) {
      failInstall(error)
    }
  }

  const onDownloaded = (version: string) => {
    newest = version
    if (boxOpen || restarting || phase === 'over' || o.quitting() || asked.has(version)) return
    asked.add(version)
    boxDone = askAndAct(version)
  }

  const askAndAct = async (version: string) => {
    boxOpen = true
    o.log(`${LOG} ${version} ready, asking`)
    let answer: 'restart' | 'later' = 'later'
    try {
      answer = await o.ask(version)
    } catch (error) {
      o.log(`${LOG} box failed: ${reason(error)}`)
    }
    boxOpen = false
    // lastChance may have cleared the set while this box was open.
    asked.add(version)
    o.log(`${LOG} ${version}: ${answer}`)
    if (answer === 'restart' && !o.quitting()) await restart()
  }

  const ENDED = Symbol('ended')

  return {
    willCheck: () => port !== undefined,
    reopen() {
      if (phase === 'normal') return 'show'
      if (boxOpen || restarting) return 'wait'
      endWait()
      return 'relaunch'
    },
    start() {
      if (!o.packaged || started) return
      started = true
      try {
        port = o.updater()
        port.onDownloaded((version) => void onDownloaded(version))
        port.onError(onError)
      } catch (error) {
        o.log(`${LOG} failed to start: ${reason(error)}`)
        return
      }
      o.clock.after(o.firstCheckMs ?? FIRST_CHECK_MS, tick)
    },
    async lastChance() {
      phase = 'last chance'
      const ended = new Promise<typeof ENDED>((resolve) => (endWait = () => resolve(ENDED)))
      try {
        if (!port) return
        o.log(`${LOG} server failed, checking before quit`)
        asked.clear()
        let timedOut = false
        const limit = new Promise<void>((resolve) =>
          o.clock.after(LAST_CHANCE_MS, () => {
            timedOut = true
            resolve()
          }),
        )
        // The limit covers the check and the download. It never closes an open box.
        if ((await Promise.race([check(), limit, ended])) === ENDED) return
        for (;;) {
          if ((await Promise.race([boxDone, ended])) === ENDED) return
          if (restarting) return await installEnded
          // A failed check, or a cached download that the check didn't report again.
          if (newest === undefined || asked.has(newest) || o.quitting()) break
          onDownloaded(newest)
        }
        if (timedOut) o.log(`${LOG} no update in time, quitting`)
      } finally {
        phase = 'over'
      }
    },
  }
}
