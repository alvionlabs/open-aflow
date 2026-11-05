// The production server's port: a fixed one, so the web app's saved state keeps its origin, with a
// free one for this launch when the fixed one is taken. A port the user set is that port only.

import { envValue, portFromEnv, type Env } from './config.ts'

export const APP_PORT = 47800

const API_PORT = 'POD_BOARD_API_PORT'

/** Unset or empty env: `preferred` (default `APP_PORT`), with fallback. A set value is strict; a bad one throws naming the variable. */
export function wantedPort(env: Env, preferred?: number): { port: number; fallback: boolean } {
  if (envValue(env, API_PORT) === undefined) return { port: preferred ?? APP_PORT, fallback: true }
  return { port: portFromEnv(env, API_PORT, APP_PORT), fallback: false }
}

/**
 * Calls `open` on the wanted port. When that port is taken or refused (Windows reserved ranges
 * answer EACCES): with fallback, calls `open(0)` so the OS picks a free port; with none, rejects
 * naming the variable and the port. Any other error rejects as it is.
 */
export async function openWithFallback<T>(want: { port: number; fallback: boolean }, open: (port: number) => Promise<T>): Promise<T> {
  try {
    return await open(want.port)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
    if (want.fallback) return open(0)
    throw new Error(`${API_PORT}: port ${want.port} is ${code === 'EACCES' ? 'not allowed' : 'busy'} (${code})`)
  }
}
