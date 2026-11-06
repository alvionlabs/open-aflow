// The folder picker's logic: the folder listing client, the start folder, and
// the panel's state machine over injected `list` / `add` so tests can hold the
// answers. Paths are Windows (`C:\x`) or POSIX (`/x`) as the server spells them;
// the server normalizes what's typed.
//
// Typing: text ending in a separator lists that folder; other text lists its
// parent and keeps the folders whose names start with the last part (any case).
// A request waits for 150 ms of quiet, and only the latest one's answer shows.
// More letters in a folder that's already listed filter at once. A relative
// path sends nothing. Add posts the folder the text names: the listed folder
// when the text ends in a separator, or a listed folder whose whole name the
// last part is; anything else (the roots, a partial name, a request still out)
// leaves Add with nothing to add.

import { NEED_RELOAD, pageToken, RESTARTED, UNREACHABLE } from '../../actions-client.ts'
import { errorSentence, type AddResult } from '../../add-repo.ts'

export type FolderEntry = { name: string; path: string; podDocs: boolean }
export type FolderListing = { path: string | null; parent: string | null; locked: boolean; truncated: boolean; folders: FolderEntry[] }
export type ListReply = { ok: true; data: FolderListing } | { ok: false; status: number; message: string }
export type ListDeps = {
  fetch?: typeof fetch
  /** The session token; by default the page's token meta, read on each call. */
  token?: () => string | null | undefined
}

export const FULL_PATH = 'Type a full path, such as C:\\Users or /home.'
export const LOCKED = "Can't open this folder."
export const TRUNCATED = 'Showing the first 1000 folders. Type to narrow.'
export const EMPTY = 'No folders here.'
export const DEBOUNCE_MS = 150

/**
 * GET `/api/fs/folders`, with `path` in the query (none → the roots) and the
 * token in its header, never in the URL. Failures come back as words, as the
 * action client gives them, never as a throw.
 */
export async function getFolders(path: string | undefined, deps: ListDeps = {}): Promise<ListReply> {
  const token = (deps.token ?? pageToken)()
  if (!token) return { ok: false, status: 0, message: NEED_RELOAD }
  const url = path === undefined ? '/api/fs/folders' : `/api/fs/folders?${new URLSearchParams({ path })}`
  let res: Response
  let text = ''
  try {
    res = await (deps.fetch ?? fetch)(url, { method: 'GET', headers: { 'X-Open-AFlow-Token': token } })
    text = await res.text()
  } catch {
    return { ok: false, status: 0, message: UNREACHABLE }
  }
  // The Vite proxy answers 502 with no body when the API isn't running.
  if (res.status === 502 && text.trim() === '') return { ok: false, status: 502, message: UNREACHABLE }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (res.ok && typeof data === 'object' && data !== null) return { ok: true, data: data as FolderListing }
  const error = typeof data === 'object' && data !== null ? (data as { error?: unknown }).error : undefined
  if (res.status === 403 && error === 'bad token') return { ok: false, status: 403, message: RESTARTED }
  const message = typeof error === 'string' && error.trim() !== '' ? error : `HTTP ${res.status}`
  return { ok: false, status: res.status, message }
}

// ---- paths ----

const DRIVE = /^[A-Za-z]:/
const isSep = (c: string | undefined) => c === '/' || c === '\\'

/** A full local path: `C:\…`, `C:/…`, or `/…` (but not `//host`, which the server refuses). */
function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || (p[0] === '/' && p[1] !== '/')
}

/** The path without trailing separators; a root keeps its own (`C:\`, `/`). */
function trimSeps(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  if (s === '') return p.startsWith('/') ? '/' : p
  return /^[A-Za-z]:$/.test(s) ? s + (p[2] ?? '\\') : s
}

/** The parent folder, or null for a root or a path that isn't full. */
function parentOf(p: string): string | null {
  if (!isAbsolute(p)) return null
  const s = trimSeps(p)
  if (s === '/' || /^[A-Za-z]:[\\/]$/.test(s)) return null
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  const head = s.slice(0, i)
  if (head === '') return '/'
  return /^[A-Za-z]:$/.test(head) ? head + s[i] : head
}

/** The path with one separator after it, in the path's own style. */
function withSep(p: string): string {
  return isSep(p.at(-1)) ? p : p + (DRIVE.test(p) ? '\\' : '/')
}

/** A key for comparing folders: no trailing separator, Windows paths in one style. */
function dirKey(p: string): string {
  const s = trimSeps(p)
  return DRIVE.test(s) ? s.replace(/\//g, '\\') : s
}

/**
 * The folder the picker opens in: the parent most repos share, with a tie going
 * to the first repo's parent. Windows parents match in any case. No repos, or
 * only repos at a root → null (the roots).
 */
export function startFolder(repoPaths: string[]): string | null {
  const counts = new Map<string, number>()
  const parents = repoPaths.map((p) => {
    const parent = parentOf(p)
    if (parent === null) return null
    const key = DRIVE.test(parent) ? dirKey(parent).toLowerCase() : parent
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return { parent, key }
  })
  const most = Math.max(0, ...counts.values())
  return parents.find((x) => x !== null && counts.get(x.key) === most)?.parent ?? null
}

export type Crumb = { label: string; path: string | null; current: boolean }

/**
 * The path crumbs for the listed folder: the roots (`This PC` on Windows, `/`
 * elsewhere, path null), then each folder down to the listed one, which is
 * `current`. Windows paths come back in backslash style. At the roots there is
 * one current crumb, named by what the roots hold. No listing → none.
 */
export function crumbsFor(listing: FolderListing | undefined): Crumb[] {
  if (!listing) return []
  if (listing.path === null) {
    const drives = listing.folders.some((f) => DRIVE.test(f.path))
    return [{ label: drives ? 'This PC' : '/', path: null, current: true }]
  }
  const p = listing.path
  const parts = p.split(/[\\/]+/).filter((x) => x !== '')
  const out: Crumb[] = []
  if (DRIVE.test(p)) {
    out.push({ label: 'This PC', path: null, current: false })
    let path = ''
    parts.forEach((part, i) => {
      path = i === 0 ? `${part}\\` : `${path}${i === 1 ? '' : '\\'}${part}`
      out.push({ label: part, path, current: false })
    })
  } else {
    out.push({ label: '/', path: null, current: false })
    let path = ''
    for (const part of parts) {
      path = `${path}/${part}`
      out.push({ label: part, path, current: false })
    }
  }
  const last = out.at(-1)!
  last.current = true
  return out
}

/**
 * Folds a long crumb trail: the root and the last two (parent and current)
 * always show; anything between them goes behind one `…` button, in order.
 * Three crumbs or fewer show as they are.
 */
export function foldCrumbs(crumbs: Crumb[]): { head: Crumb[]; hidden: Crumb[]; tail: Crumb[] } {
  if (crumbs.length <= 3) return { head: crumbs, hidden: [], tail: [] }
  return { head: crumbs.slice(0, 1), hidden: crumbs.slice(1, -2), tail: crumbs.slice(-2) }
}

type Parsed = { kind: 'roots' } | { kind: 'relative' } | { kind: 'list'; dir: string; prefix: string }

function parse(text: string): Parsed {
  const t = text.trim()
  if (t === '') return { kind: 'roots' }
  if (!isAbsolute(t)) return { kind: 'relative' }
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  return { kind: 'list', dir: t.slice(0, i + 1), prefix: t.slice(i + 1) }
}

// ---- the panel ----

export type PickerState = {
  /** The path input. */
  input: string
  /** The last listing that answered; none before the first, or after an error. */
  listing?: FolderListing
  /** The listing's folders the typed name keeps. */
  shown: FolderEntry[]
  /** A request is waiting or out. */
  loading: boolean
  /** The roots are listed. */
  atRoots: boolean
  /** What Add posts; null leaves Add disabled. */
  target: string | null
  adding: boolean
  /** Asks for a full path. */
  note?: string
  /** Locked, truncated, or nothing to show. */
  notice?: string
  /** A listing or add error, as a sentence. */
  error?: string
}

export type PickerDeps = {
  list: (path: string | undefined) => Promise<ListReply>
  add: (path: string) => Promise<AddResult>
  onClose: () => void
}

const matches = (folders: FolderEntry[], prefix: string) => {
  const p = prefix.toLowerCase()
  return folders.filter((f) => f.name.toLowerCase().startsWith(p))
}

export function createFolderPicker(deps: PickerDeps, onChange: (s: PickerState) => void) {
  let input = ''
  let listing: FolderListing | undefined
  /** The `dirKey` the listing answered for; `null` for the roots. */
  let listedKey: string | null | undefined
  let loading = false
  let adding = false
  let note: string | undefined
  let error: string | undefined
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  let state: PickerState = { input, shown: [], loading, atRoots: false, target: null, adding }
  const emit = () => {
    const parsed = parse(input)
    const prefix = parsed.kind === 'list' ? parsed.prefix : ''
    const shown = listing && note === undefined ? matches(listing.folders, prefix) : []
    const atRoots = listing !== undefined && listing.path === null
    let target: string | null = null
    if (listing && listing.path !== null && !loading && note === undefined) {
      if (prefix === '') target = listing.path
      else target = shown.find((f) => f.name.toLowerCase() === prefix.toLowerCase())?.path ?? null
    }
    let notice: string | undefined
    if (listing && note === undefined) {
      if (listing.locked) notice = LOCKED
      else if (shown.length === 0 && prefix !== '') notice = `No folder here starts with “${prefix}”.`
      else if (shown.length === 0) notice = EMPTY
      else if (listing.truncated) notice = TRUNCATED
    }
    state = { input, listing, shown, loading, atRoots, target, adding, note, notice, error }
    onChange(state)
  }

  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  /** Lists `dir` (undefined → the roots) now; an answer that isn't the latest is dropped. */
  const request = (dir: string | undefined, fromStart = false) => {
    stopTimer()
    const id = ++seq
    loading = true
    emit()
    void deps.list(dir).then((r) => {
      if (id !== seq) return
      if (!r.ok && fromStart && r.status === 404) return go(undefined)
      loading = false
      if (r.ok) {
        listing = r.data
        listedKey = dir === undefined ? null : dirKey(dir)
        error = undefined
      } else {
        listing = undefined
        listedKey = undefined
        error = errorSentence({ status: r.status, error: r.message })
      }
      emit()
    })
  }

  const go = (path: string | undefined, fromStart = false) => {
    input = path === undefined ? '' : withSep(path)
    note = undefined
    error = undefined
    request(path, fromStart)
  }

  return {
    state: () => state,
    /** Opens the start folder (null → the roots); one that's missing falls back to the roots. */
    start(folder: string | null) {
      go(folder ?? undefined, folder !== null)
    },
    type(text: string) {
      input = text
      error = undefined
      note = undefined
      stopTimer()
      const parsed = parse(text)
      if (parsed.kind === 'relative') {
        seq++
        loading = false
        note = FULL_PATH
        return emit()
      }
      const key = parsed.kind === 'roots' ? null : dirKey(parsed.dir)
      if (listing && !loading && listedKey === key) return emit()
      // Drop any answer still out: it's for other text.
      seq++
      loading = true
      emit()
      const dir = parsed.kind === 'roots' ? undefined : parsed.dir
      timer = setTimeout(() => request(dir), DEBOUNCE_MS)
    },
    /** Tab: the first match plus a separator. False when there's nothing to complete. */
    complete(): boolean {
      const parsed = parse(input)
      if (parsed.kind !== 'list' || parsed.prefix === '' || loading || note !== undefined) return false
      const first = state.shown[0]
      if (!first) return false
      go(first.path)
      return true
    },
    open(path: string) {
      go(path)
    },
    /** The roots listing (the root crumb). */
    roots() {
      go(undefined)
    },
    /** To the parent; from a root, to the roots. Nothing at the roots. */
    up() {
      if (!listing || listing.path === null) return
      go(listing.parent ?? undefined)
    },
    async add() {
      const target = state.target
      if (target === null || adding) return
      adding = true
      error = undefined
      emit()
      let result: AddResult
      try {
        result = await deps.add(target)
      } catch {
        result = { status: 0, error: UNREACHABLE }
      }
      adding = false
      if (result.status === 201) {
        stopTimer()
        deps.onClose()
        return
      }
      error = errorSentence(result)
      emit()
    },
    escape() {
      stopTimer()
      seq++
      deps.onClose()
    },
    /** Stops a waiting request; the panel is gone. */
    dispose() {
      stopTimer()
      seq++
    },
  }
}

const FOLD_MENU_WIDTH = 320
/** Two 44 px rows: never a negative or useless height near the window's bottom. */
export const FOLD_MENU_MIN_HEIGHT = 88
const EDGE = 16

/**
 * Where the fold menu opens, in window pixels (it is `position: fixed`, so the
 * dialog's own scroll box can't clip it): 4 px under the `…` button, moved left
 * to keep its widest (320 px) 16 px inside the window, and never left of 16 px.
 * Its height stops 16 px above the window's bottom; longer lists scroll.
 */
export function foldMenuPlace(trigger: { left: number; bottom: number }, view: { width: number; height: number }): { top: number; left: number; maxHeight: number } {
  const top = trigger.bottom + 4
  const left = Math.max(EDGE, Math.min(trigger.left, view.width - FOLD_MENU_WIDTH - EDGE))
  return { top, left, maxHeight: Math.max(FOLD_MENU_MIN_HEIGHT, view.height - top - EDGE) }
}

/**
 * Whether the page moved under an open fold menu, so it closes: a window
 * resize, or a scroll anywhere but the menu's own list (the menu is fixed to
 * the window, so it would part from its `…` button).
 */
export function foldMenuMoved(kind: 'scroll' | 'resize', insideMenu: boolean): boolean {
  return kind === 'resize' || !insideMenu
}
