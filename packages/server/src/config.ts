import path from 'node:path'

export type Env =Record<string, string | undefined>

export type ListenConfig = { hostname: '127.0.0.1'; port: number }

export const DEFAULT_API_PORT = 3000

/**
 * Reads a TCP port from `env[name]`. Unset or empty → `fallback`. Anything
 * other than a plain integer from 1 to 65535 throws an error naming the
 * variable, so a typo fails at start instead of binding somewhere odd.
 */
export function portFromEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const port = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

/** Where the API server listens. Always loopback: the board reads local files. */
export function listenConfig(env: Env): ListenConfig {
  return { hostname: '127.0.0.1', port: portFromEnv(env, 'OPEN_AFLOW_API_PORT', DEFAULT_API_PORT) }
}

/** `env[name]`, with an empty value counted as unset. */
export function envValue(env: Env, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * The server's config folder name. It must differ from the packaged app's name (`open-aflow`) and its product name
 * (`Open AFlow`): NSIS's `--delete-app-data` removes `%APPDATA%\<each of them>`. build-config.test.ts checks it.
 */
export const CONFIG_DIR_NAME = 'open-aflow-server'

/** The folder name before the rename to Open AFlow. A first start copies it once (config-move.ts). */
const OLD_CONFIG_DIR_NAME = 'pod-board'

/** The folder that holds the server's own folders on `platform`, with that OS's separators. */
function configBase(env: Env, platform: NodeJS.Platform, home: string): { p: path.PlatformPath; base: string } {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') return { p, base: envValue(env, 'APPDATA') ?? p.join(home, 'AppData', 'Roaming') }
  if (platform === 'darwin') return { p, base: p.join(home, 'Library', 'Application Support') }
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const xdg = envValue(env, 'XDG_CONFIG_HOME')
  return { p, base: xdg && p.isAbsolute(xdg) ? xdg : p.join(home, '.config') }
}

/**
 * Where the board keeps its own config file, per OS. `OPEN_AFLOW_CONFIG_DIR` wins everywhere. Paths use the
 * separators of `platform`, so callers (and tests) can ask for any OS from any host.
 */
export function configPath(env: Env, platform: NodeJS.Platform, home: string): string {
  const override = envValue(env, 'OPEN_AFLOW_CONFIG_DIR')
  const { p, base } = configBase(env, platform, home)
  if (override) return p.join(override, 'config.json')
  return p.join(base, CONFIG_DIR_NAME, 'config.json')
}

/**
 * The config folder before the rename, beside the one `configPath` picks. None when `OPEN_AFLOW_CONFIG_DIR` is
 * set: a temp folder never copies from the real one.
 */
export function oldConfigDir(env: Env, platform: NodeJS.Platform, home: string): string | undefined {
  if (envValue(env, 'OPEN_AFLOW_CONFIG_DIR')) return undefined
  const { p, base } = configBase(env, platform, home)
  return p.join(base, OLD_CONFIG_DIR_NAME)
}
