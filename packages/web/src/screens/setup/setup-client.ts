// Asks the server about the tools and holds the setup gate: checking, then setup or board.
// The check runs only on load, on Recheck, and after a path save.

import { NEED_RELOAD, pageToken, postAction, RESTARTED, UNREACHABLE } from '../../actions-client.ts'
import { afterRecheck, afterSave, parseTools, pathBody, setupStep, UNREADABLE, type SetupStep, type ToolName, type ToolsRead } from './setup-view.ts'

/** On load, a hung check must not lock anyone out. */
export const GATE_LIMIT_MS = 5000
/** Recheck and save: above a check's two 5 s registry reads, so a slow check isn't called a failure. */
export const ACTION_LIMIT_MS = 15000

export type SetupDeps = { fetch?: typeof fetch; token?: () => string | null | undefined }
export type GateState = { view: 'checking' } | SetupStep

/** `work`, or `late` once the limit passes. The abort also ends the request. */
async function withLimit<T>(limitMs: number, late: T, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(late)
    }, limitMs)
  })
  try {
    return await Promise.race([work(controller.signal), limit])
  } finally {
    clearTimeout(timer)
  }
}

async function askTools(fetchFn: typeof fetch, token: string, signal: AbortSignal): Promise<ToolsRead> {
  let res: Response
  let text: string
  try {
    res = await fetchFn('/api/tools', { headers: { 'X-Open-AFlow-Token': token }, signal })
    text = await res.text()
  } catch {
    return { ok: false, message: UNREACHABLE }
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, message: res.ok ? UNREADABLE : `HTTP ${res.status}` }
  }
  if (res.ok) {
    const tools = parseTools(data)
    return tools ? { ok: true, tools } : { ok: false, message: UNREADABLE }
  }
  const error = typeof data === 'object' && data !== null ? (data as { error?: unknown }).error : undefined
  if (res.status === 403 && error === 'bad token') return { ok: false, message: RESTARTED }
  return { ok: false, message: typeof error === 'string' && error.trim() !== '' ? error : `HTTP ${res.status}` }
}

/** GET /api/tools with the page token. Every failure comes back as words, never as a throw. */
export async function readTools(deps: SetupDeps = {}, limitMs = GATE_LIMIT_MS): Promise<ToolsRead> {
  const token = (deps.token ?? pageToken)()
  if (!token) return { ok: false, message: NEED_RELOAD }
  const fetchFn = deps.fetch ?? fetch
  return withLimit<ToolsRead>(limitMs, { ok: false, message: UNREACHABLE }, (signal) => askTools(fetchFn, token, signal))
}

export function createSetupGate(deps: SetupDeps = {}) {
  let current: GateState = { view: 'checking' }
  let started = false
  const listeners = new Set<() => void>()

  const show = (next: GateState) => {
    current = next
    for (const fn of listeners) fn()
  }

  /** Runs one save or Recheck at a time, and only while the rows are up. */
  const whileSetup = async (work: (setup: Extract<GateState, { view: 'setup' }>['setup']) => Promise<SetupStep>) => {
    if (current.view !== 'setup' || current.setup.busy) return
    const setup = { ...current.setup, busy: true }
    show({ view: 'setup', setup })
    show(await work(setup))
  }

  return {
    state: (): GateState => current,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    /** The check on load. Any answer but a tool not found opens the board. */
    start: () => {
      if (started) return
      started = true
      void readTools(deps, GATE_LIMIT_MS).then((read) => show(read.ok ? setupStep(read.tools) : { view: 'board' }))
    },
    recheck: () => whileSetup(async (setup) => afterRecheck(setup, await readTools(deps, ACTION_LIMIT_MS))),
    save: (tool: ToolName, text: string) =>
      whileSetup(async (setup) => {
        const late = { ok: false as const, status: 0, message: UNREACHABLE }
        const reply = await withLimit(ACTION_LIMIT_MS, late, (signal) =>
          postAction<unknown>('tool-path', pathBody(tool, text), {
            ...deps,
            fetch: (url, init) => (deps.fetch ?? fetch)(url, { ...init, signal }),
          }),
        )
        return afterSave(setup, tool, reply)
      }),
  }
}
