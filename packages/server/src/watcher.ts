// Keeps the Board current: watches the files it is built from, rebuilds after
// a short quiet spell (or a capped wait while events keep coming), and tells
// subscribers only when the Board changed.
// The rules and why are in pod-docs/feature-details/server.md.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Board } from '@open-aflow/model'
import { watch, type FSWatcher } from 'chokidar'
import type { BoardService } from './board-service.ts'
import { projectDirName } from './transcript-files.ts'

export const DEBOUNCE_MS = 300
export const TICK_MS = 30_000
/** The longest a rebuild waits after the first event of a burst, however often events keep coming. */
export const MAX_WAIT_MS = 1500
const POLL_INTERVAL_MS = 500

export type BoardWatcherOptions = {
  service: BoardService
  configFile: string
  portsDir: string
  claudeDir: string
  /** Watch by polling (`OPEN_AFLOW_POLL=1`): for network drives and file systems that miss events. */
  poll?: boolean
  debounceMs?: number
  /** The longest a rebuild waits after the first event of a burst. */
  maxWaitMs?: number
  tickMs?: number
  /** Opens one folder watch; chokidar's `watch` unless a test passes a fake. */
  watch?: typeof watch
  onError?: (err: unknown) => void
}

export type BoardWatcher = {
  /** Builds the first Board and starts watching. */
  start(): Promise<Board>
  /** The latest Board. Its `generatedAt` is when it last changed. */
  board(): Board
  /** Called with each new Board. Returns the unsubscribe. */
  subscribe(fn: (b: Board) => void): () => void
  /** Rebuilds now (after any rebuild already running) and tells subscribers if the Board changed. */
  rebuild(): Promise<void>
  close(): Promise<void>
}

/** A folder to watch and which of its entries count. */
type Target = { dir: string; depth: number; keep: (p: string, isDir: boolean | undefined) => boolean }

/**
 * Board JSON without the fields that change on every build or gh check, so a
 * rebuild that finds nothing new sends nothing. While gh isn't `ok`, the gh
 * check time counts, so the banner's "Last checked" is the latest check.
 */
export function boardSignature(board: Board): string {
  const ghTimeCounts = board.gh !== 'ok'
  return JSON.stringify(board, (key, value) =>
    key === 'generatedAt' || key === 'checkedAt' || (key === 'ghCheckedAt' && !ghTimeCounts) ? undefined : value,
  )
}

/** What to watch for a Board: the config file, the claims, and each repo's pod docs and transcripts. */
export function watchTargets(board: Board, o: Pick<BoardWatcherOptions, 'configFile' | 'portsDir' | 'claudeDir'>): Target[] {
  const configFile = path.resolve(o.configFile)
  const configDir = path.dirname(configFile)
  const targets: Target[] = [
    // chokidar runs `ignored` on the watched folder too, so the folder must be kept.
    { dir: configDir, depth: 0, keep: (p) => p === configDir || p === configFile },
    { dir: path.resolve(o.portsDir), depth: 0, keep: () => true },
  ]
  for (const repo of board.repos) {
    // Pod docs live up to two folders down (`plans/archive/x.md`); only `.md` files count.
    targets.push({ dir: path.resolve(repo.path, 'pod-docs'), depth: 2, keep: (p, isDir) => isDir !== false || p.endsWith('.md') })
    const project = path.resolve(o.claudeDir, 'projects', projectDirName(repo.path))
    targets.push({ dir: project, depth: 2, keep: (p, isDir) => keepTranscriptPath(project, p, isDir) })
  }
  return targets
}

/** Inside a Claude project folder, only `<session>/subagents/agent-*` files matter; session logs and tool output don't. */
function keepTranscriptPath(project: string, p: string, isDir: boolean | undefined): boolean {
  const parts = path.relative(project, p).split(path.sep)
  if (parts[0] === '') return true
  if (parts.length === 1) return isDir !== false && !parts[0]!.endsWith('.jsonl')
  if (parts.length === 2) return parts[1] === 'subagents' && isDir !== false
  return parts.length === 3 && parts[1] === 'subagents' && /^agent-.+\.(?:jsonl|meta\.json)$/.test(parts[2]!)
}

export function createBoardWatcher(o: BoardWatcherOptions): BoardWatcher {
  // A poller sees a quick burst of writes on up to two ticks, one interval
  // apart; a longer quiet spell keeps that burst to one rebuild.
  const debounceMs = (o.debounceMs ?? DEBOUNCE_MS) + (o.poll === true ? POLL_INTERVAL_MS : 0)
  const maxWaitMs = o.maxWaitMs ?? MAX_WAIT_MS
  const tickMs = o.tickMs ?? TICK_MS
  const openWatch = o.watch ?? watch
  const onError = o.onError ?? ((err: unknown) => console.error('open-aflow watcher:', err))
  const subscribers = new Set<(b: Board) => void>()
  // Key → open watcher. A key names the folder and whether it is watched itself or through its nearest existing parent.
  const watchers = new Map<string, FSWatcher>()

  let current: Board | undefined
  let signature = ''
  let chain: Promise<void> = Promise.resolve()
  let debounce: NodeJS.Timeout | undefined
  // Set by a burst's first event and never pushed back, so steady events can't starve rebuilds.
  let maxWait: NodeJS.Timeout | undefined
  let tickTimer: NodeJS.Timeout | undefined
  let ticking = false
  let closed = false

  // Rebuilds once per burst: when it goes quiet, or when its wait hits the cap.
  // Events after that start a new burst.
  const fire = () => {
    clearTimeout(debounce)
    clearTimeout(maxWait)
    debounce = maxWait = undefined
    void rebuild()
  }
  const schedule = () => {
    if (closed) return
    clearTimeout(debounce)
    debounce = setTimeout(fire, debounceMs)
    maxWait ??= setTimeout(fire, maxWaitMs)
  }

  async function rebuildNow(): Promise<void> {
    if (closed) return
    let board: Board
    try {
      board = await o.service.build()
    } catch (err) {
      onError(err)
      return
    }
    if (closed) return
    const next = boardSignature(board)
    if (next !== signature) {
      signature = next
      current = board
      for (const fn of [...subscribers]) {
        try {
          fn(board)
        } catch (err) {
          onError(err)
        }
      }
    }
    try {
      if (await sync(board)) schedule()
    } catch (err) {
      onError(err)
    }
  }

  function rebuild(): Promise<void> {
    // A rejected link would skip every later rebuild, so report it and go on.
    chain = chain.then(rebuildNow).catch(onError)
    return chain
  }

  /**
   * Opens and closes watchers to match the Board's targets. A folder that
   * doesn't exist yet is watched through its nearest existing parent, so its
   * creation triggers a rebuild that swaps in the real watch. `true` when it
   * opened a watcher, so the caller rebuilds once more to catch what changed
   * before it was ready.
   */
  async function sync(board: Board): Promise<boolean> {
    const wanted = new Map<string, Target>()
    for (const target of watchTargets(board, o)) {
      const spec = await resolveTarget(target)
      if (spec) wanted.set(spec.key, spec.target)
    }
    if (closed) return false
    for (const [key, w] of watchers) {
      if (!wanted.has(key)) {
        watchers.delete(key)
        await w.close()
      }
    }
    const opened: Promise<void>[] = []
    for (const [key, target] of wanted) {
      if (watchers.has(key)) continue
      const w = openWatch(target.dir, {
        ignoreInitial: true,
        depth: target.depth,
        ignored: (p, stats) => !target.keep(path.resolve(p), stats ? stats.isDirectory() : undefined),
        usePolling: o.poll === true,
        interval: POLL_INTERVAL_MS,
        binaryInterval: POLL_INTERVAL_MS,
      })
      w.on('all', schedule)
      w.on('error', onError)
      watchers.set(key, w)
      opened.push(new Promise((resolve) => w.once('ready', () => resolve())))
    }
    await Promise.all(opened)
    return opened.length > 0
  }

  async function tick(): Promise<void> {
    if (closed || ticking || !current) return
    ticking = true
    try {
      await o.service.refreshGh(current)
    } catch (err) {
      onError(err)
    } finally {
      ticking = false
    }
    await rebuild()
  }

  function loop(): void {
    tickTimer = setTimeout(() => {
      void tick().finally(() => {
        if (!closed) loop()
      })
    }, tickMs)
    tickTimer.unref()
  }

  return {
    async start() {
      const board = await o.service.build()
      current = board
      signature = boardSignature(board)
      await sync(board)
      // Catch anything that changed while the watchers were starting.
      schedule()
      void tick()
      loop()
      return board
    },
    board() {
      if (!current) throw new Error('board watcher not started')
      return current
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
    rebuild,
    async close() {
      closed = true
      clearTimeout(debounce)
      clearTimeout(maxWait)
      clearTimeout(tickTimer)
      subscribers.clear()
      await chain
      const open = [...watchers.values()]
      watchers.clear()
      await Promise.all(open.map((w) => w.close()))
    },
  }
}

/** The folder itself when it exists, else its nearest existing parent, kept to the one child on the way. */
async function resolveTarget(target: Target): Promise<{ key: string; target: Target } | undefined> {
  if (await isDir(target.dir)) return { key: `dir:${target.dir}`, target }
  let child = target.dir
  let parent = path.dirname(child)
  while (parent !== child) {
    if (await isDir(parent)) {
      const step = child
      const top = parent
      return { key: `parent:${top}>${target.dir}`, target: { dir: top, depth: 0, keep: (p) => p === top || p === step } }
    }
    child = parent
    parent = path.dirname(child)
  }
  return undefined
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
