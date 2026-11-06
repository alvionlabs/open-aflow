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
 * Where the board keeps its own config file, per OS. `OPEN_AFLOW_CONFIG_DIR`
 * wins everywhere. Paths use the separators of `platform`, so callers (and
 * tests) can ask for any OS from any host.
 */
export function configPath(env: Env, platform: NodeJS.Platform, home: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const override = envValue(env, 'OPEN_AFLOW_CONFIG_DIR')
  if (override) return p.join(override, 'config.json')
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA') ?? p.join(home, 'AppData', 'Roaming')
    return p.join(appData, 'pod-board', 'config.json')
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'pod-board', 'config.json')
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const xdg = envValue(env, 'XDG_CONFIG_HOME')
  const base = xdg && p.isAbsolute(xdg) ? xdg : p.join(home, '.config')
  return p.join(base, 'pod-board', 'config.json')
}

/** The server's config folder name. Not built yet. */
export const CONFIG_DIR_NAME = 'pod-board'

/** Not built yet. */
export function oldConfigDir(_env: Env, _platform: NodeJS.Platform, _home: string): string | undefined {
  return undefined
}
