// When the app checks for an update, when it asks, and what a Restart now does. No `electron` import: the glue is in
// updater-main.ts. The rules are in pod-docs/feature-details/desktop.md.

export const FIRST_CHECK_MS = 30_000
export const RECHECK_MS = 6 * 60 * 60_000

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
  /** Called at the first ready of a packaged app. */
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

export function createUpdateFlow(o: UpdateFlowOptions): { ready(): void } {
  let port: UpdaterPort | undefined
  let started = false
  let busy = false
  let boxOpen = false
  let failureLogged = false
  /** `restarting` holds from the Restart now; `installing` from the call to the installer. */
  let restarting = false
  let installing = false
  let installFailed = false
  const asked = new Set<string>()

  const failInstall = (error: unknown) => {
    if (installFailed) return
    installFailed = true
    o.log(`${LOG} install failed, quitting: ${reason(error)}`)
    o.quit()
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

  const check = async () => {
    if (busy || boxOpen || restarting || o.quitting()) return
    busy = true
    failureLogged = false
    try {
      const result = await port!.check()
      await result?.downloadPromise
    } catch (error) {
      onError(error)
    } finally {
      busy = false
    }
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
    try {
      port!.install()
    } catch (error) {
      failInstall(error)
    }
  }

  const onDownloaded = async (version: string) => {
    if (boxOpen || restarting || o.quitting() || asked.has(version)) return
    asked.add(version)
    boxOpen = true
    o.log(`${LOG} ${version} ready, asking`)
    let answer: 'restart' | 'later' = 'later'
    try {
      answer = await o.ask(version)
    } catch (error) {
      o.log(`${LOG} box failed: ${reason(error)}`)
    }
    boxOpen = false
    o.log(`${LOG} ${version}: ${answer}`)
    if (answer === 'restart' && !o.quitting()) await restart()
  }

  return {
    ready() {
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
  }
}
