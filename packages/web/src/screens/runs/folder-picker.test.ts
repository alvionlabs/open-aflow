import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEED_RELOAD, RESTARTED, UNREACHABLE } from '../../actions-client.ts'
import type { AddResult } from '../../add-repo.ts'
import { CrumbFoldView, PickerPanel } from './FolderPicker.tsx'
import {
  createFolderPicker,
  crumbsFor,
  foldCrumbs,
  FOLD_MENU_MIN_HEIGHT,
  foldMenuMoved,
  foldMenuPlace,
  FULL_PATH,
  getFolders,
  LOCKED,
  startFolder,
  TRUNCATED,
  type FolderEntry,
  type FolderListing,
  type ListReply,
  type PickerState,
} from './folder-picker.ts'

// ---- helpers ----

const entry = (path: string, podDocs = false): FolderEntry => {
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
  return { name, path, podDocs }
}
const listing = (path: string | null, folders: FolderEntry[], extra: Partial<FolderListing> = {}): FolderListing => ({
  path,
  parent: null,
  locked: false,
  truncated: false,
  folders,
  ...extra,
})
const ok = (data: FolderListing): ListReply => ({ ok: true, data })
const ROOTS = listing(null, [
  { name: 'C:\\', path: 'C:\\', podDocs: false },
  { name: 'D:\\', path: 'D:\\', podDocs: false },
])

/** A fake file system the picker lists through, keyed by the path asked for. */
function fakeFs(dirs: Record<string, FolderListing>) {
  const asked: (string | undefined)[] = []
  const list = vi.fn(async (path: string | undefined): Promise<ListReply> => {
    asked.push(path)
    if (path === undefined) return ok(dirs['<roots>'] ?? ROOTS)
    const key = path.length > 3 ? path.replace(/[\\/]+$/, '') : path
    const hit = dirs[key]
    return hit ? ok(hit) : { ok: false, status: 404, message: 'not a directory' }
  })
  return { list, asked }
}

/** A list whose answers the test hands out by hand, in any order. */
function heldList() {
  const calls: { path: string | undefined; answer: (r: ListReply) => void }[] = []
  const list = (path: string | undefined) => new Promise<ListReply>((answer) => calls.push({ path, answer }))
  return { list, calls }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

type Setup = { list: (p: string | undefined) => Promise<ListReply>; add?: (p: string) => Promise<AddResult> }
function picker({ list, add }: Setup) {
  const onClose = vi.fn()
  const addFn = vi.fn(add ?? (async () => ({ status: 201 })))
  const p = createFolderPicker({ list, add: addFn, onClose }, () => {})
  return { p, onClose, add: addFn }
}
const names = (s: PickerState) => s.shown.map((f) => f.name)

const USERS = listing('C:\\Users', [entry('C:\\Users\\ann'), entry('C:\\Users\\Bob'), entry('C:\\Users\\bea'), entry('C:\\Users\\cy')], {
  parent: 'C:\\',
})
const C_ROOT = listing('C:\\', [entry('C:\\Users'), entry('C:\\Windows')])
const PROJECTS = listing('C:\\Users\\ann\\Projects', [entry('C:\\Users\\ann\\Projects\\chess', true), entry('C:\\Users\\ann\\Projects\\notes')], {
  parent: 'C:\\Users\\ann',
})

// ---- tests ----

describe('folder picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('listing client', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(ROOTS), { status: 200 }))
    const f = fetch as unknown as typeof globalThis.fetch

    // The token goes in its header, never in the URL; no path asks for the roots.
    const roots = await getFolders(undefined, { fetch: f, token: () => 'tok-123' })
    expect(roots).toEqual({ ok: true, data: ROOTS })
    const [url0, init0] = fetch.mock.calls[0]!
    expect(url0).toBe('/api/fs/folders')
    expect(new Headers(init0?.headers).get('X-OpenAFlow-Token')).toBe('tok-123')
    expect(init0?.method ?? 'GET').toBe('GET')

    // A path is query-encoded (a folder named `a+b c` round-trips).
    await getFolders('C:\\x\\a+b c', { fetch: f, token: () => 'tok-123' })
    const url1 = fetch.mock.calls[1]![0]
    expect(url1).not.toContain('tok-123')
    expect(new URL(url1, 'http://h').searchParams.get('path')).toBe('C:\\x\\a+b c')

    // No token: nothing is sent.
    fetch.mockClear()
    expect(await getFolders(undefined, { fetch: f, token: () => null })).toEqual({ ok: false, status: 0, message: NEED_RELOAD })
    expect(fetch).not.toHaveBeenCalled()

    // A token from before a restart.
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 403 }))
    expect(await getFolders(undefined, { fetch: f, token: () => 't' })).toEqual({ ok: false, status: 403, message: RESTARTED })

    // The API's error word comes back as it is.
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'not a directory' }), { status: 404 }))
    expect(await getFolders('C:\\nope', { fetch: f, token: () => 't' })).toEqual({ ok: false, status: 404, message: 'not a directory' })

    // The proxy's empty 502, a thrown fetch, and a body with no error word.
    fetch.mockImplementationOnce(async () => new Response('', { status: 502 }))
    expect(await getFolders(undefined, { fetch: f, token: () => 't' })).toEqual({ ok: false, status: 502, message: UNREACHABLE })
    fetch.mockImplementationOnce(async () => {
      throw new TypeError('network')
    })
    expect(await getFolders(undefined, { fetch: f, token: () => 't' })).toEqual({ ok: false, status: 0, message: UNREACHABLE })
    fetch.mockImplementationOnce(async () => new Response('oops', { status: 500 }))
    expect(await getFolders(undefined, { fetch: f, token: () => 't' })).toEqual({ ok: false, status: 500, message: 'HTTP 500' })
  })

  it('start folder', () => {
    // One parent.
    expect(startFolder(['C:\\Users\\ann\\Projects\\chess'])).toBe('C:\\Users\\ann\\Projects')
    expect(startFolder(['/home/ann/src/chess', '/home/ann/src/notes'])).toBe('/home/ann/src')
    expect(startFolder(['/chess'])).toBe('/')
    expect(startFolder(['C:\\chess'])).toBe('C:\\')
    // Mixed parents: the one most repos share.
    expect(startFolder(['D:\\work\\a', 'E:\\Projects\\b', 'E:\\Projects\\c'])).toBe('E:\\Projects')
    // A Windows parent matches in any case, and keeps the first repo's spelling.
    expect(startFolder(['D:\\w\\a', 'e:\\projects\\b', 'E:\\Projects\\c'])).toBe('e:\\projects')
    // A tie goes to the first repo's parent.
    expect(startFolder(['D:\\work\\a', 'E:\\Projects\\b', 'E:\\Projects\\c', 'D:\\work\\d'])).toBe('D:\\work')
    expect(startFolder(['/b/x', '/a/y'])).toBe('/b')
    // A trailing separator doesn't change the parent.
    expect(startFolder(['C:\\Users\\ann\\chess\\'])).toBe('C:\\Users\\ann')
    // No repos, or a repo at a root: the roots.
    expect(startFolder([])).toBeNull()
    expect(startFolder(['D:\\'])).toBeNull()
    expect(startFolder(['/'])).toBeNull()
    // A root repo doesn't count, so another repo's parent wins.
    expect(startFolder(['D:\\', 'C:\\src\\a'])).toBe('C:\\src')
  })

  it('typing a path', async () => {
    const fs = fakeFs({ 'C:\\Users': USERS, 'C:\\': C_ROOT })
    const { p } = picker({ list: fs.list })
    p.start(null)
    await flush()
    expect(fs.asked).toEqual([undefined])

    // Text with no trailing separator lists the parent and keeps the names that start with the last part.
    p.type('C:\\Users\\b')
    await vi.advanceTimersByTimeAsync(149)
    expect(fs.asked).toEqual([undefined])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(fs.asked).toEqual([undefined, 'C:\\Users\\'])
    expect(names(p.state())).toEqual(['Bob', 'bea'])
    // A partial name names no folder, so Add has nothing to add.
    expect(p.state().target).toBeNull()

    // More letters in the same folder filter at once, with no new request.
    p.type('C:\\Users\\be')
    expect(names(p.state())).toEqual(['bea'])
    await vi.advanceTimersByTimeAsync(500)
    expect(fs.asked).toHaveLength(2)
    // A whole name (any case) names that folder.
    p.type('C:\\Users\\BEA')
    expect(p.state().target).toBe('C:\\Users\\bea')

    // Requests wait for 150 ms of quiet: three quick edits send one request.
    p.type('C:\\W')
    await vi.advanceTimersByTimeAsync(100)
    p.type('C:\\Wi')
    await vi.advanceTimersByTimeAsync(100)
    p.type('C:\\Win')
    expect(p.state().target).toBeNull()
    await vi.advanceTimersByTimeAsync(150)
    await flush()
    expect(fs.asked).toEqual([undefined, 'C:\\Users\\', 'C:\\'])
    expect(names(p.state())).toEqual(['Windows'])

    // Tab completes the first match plus a separator, and lists it.
    p.type('C:\\u')
    expect(names(p.state())).toEqual(['Users'])
    expect(p.complete()).toBe(true)
    expect(p.state().input).toBe('C:\\Users\\')
    await flush()
    expect(fs.asked.at(-1)).toBe('C:\\Users')
    expect(names(p.state())).toEqual(['ann', 'Bob', 'bea', 'cy'])
    // A trailing separator lists that folder, and Add adds it.
    expect(p.state().target).toBe('C:\\Users')

    // Tab with no match, or no partial name, completes nothing (focus may move on).
    p.type('C:\\Users\\zz')
    expect(p.state().shown).toEqual([])
    expect(p.complete()).toBe(false)
    p.type('C:\\Users\\')
    expect(p.complete()).toBe(false)
    expect(p.state().input).toBe('C:\\Users\\')

    // A relative path asks for a full path and sends nothing.
    const before = fs.asked.length
    for (const text of ['Users\\ann', 'C:x', '\\\\host\\share', 'C:']) {
      p.type(text)
      await vi.advanceTimersByTimeAsync(300)
      expect(p.state().note, text).toBe(FULL_PATH)
      expect(p.state().target, text).toBeNull()
      expect(p.complete(), text).toBe(false)
    }
    expect(fs.asked).toHaveLength(before)

    // Empty text lists the roots again.
    p.type('')
    await vi.advanceTimersByTimeAsync(150)
    await flush()
    expect(fs.asked.at(-1)).toBeUndefined()
    expect(p.state().note).toBeUndefined()
    expect(p.state().atRoots).toBe(true)
  })

  it('typing a path: an out-of-order answer is dropped', async () => {
    const held = heldList()
    const { p } = picker({ list: held.list })
    p.start(null)
    expect(held.calls.map((c) => c.path)).toEqual([undefined])
    held.calls[0]!.answer(ok(ROOTS))
    await flush()

    p.type('C:\\Users\\')
    await vi.advanceTimersByTimeAsync(150)
    p.type('C:\\Program Files\\')
    await vi.advanceTimersByTimeAsync(150)
    expect(held.calls.map((c) => c.path)).toEqual([undefined, 'C:\\Users\\', 'C:\\Program Files\\'])

    // The newer answer lands first; the older one, coming later, is dropped.
    held.calls[2]!.answer(ok(listing('C:\\Program Files', [entry('C:\\Program Files\\Git')], { parent: 'C:\\' })))
    await flush()
    expect(names(p.state())).toEqual(['Git'])
    held.calls[1]!.answer(ok(USERS))
    await flush()
    expect(names(p.state())).toEqual(['Git'])
    expect(p.state().listing?.path).toBe('C:\\Program Files')

    // An answer still out when the text turns relative is dropped too.
    p.type('D:\\x\\')
    await vi.advanceTimersByTimeAsync(150)
    p.type('x')
    held.calls[3]!.answer(ok(listing('D:\\x', [entry('D:\\x\\y')], { parent: 'D:\\' })))
    await flush()
    expect(p.state().shown).toEqual([])
    expect(p.state().note).toBe(FULL_PATH)
  })

  it('clicking down and adding', async () => {
    const fs = fakeFs({ 'C:\\': C_ROOT, 'C:\\Users': USERS, 'C:\\Users\\ann\\Projects': PROJECTS })
    const { p, onClose, add } = picker({ list: fs.list })

    // The start folder lists at once.
    p.start('C:\\Users\\ann\\Projects')
    await flush()
    expect(fs.asked).toEqual(['C:\\Users\\ann\\Projects'])
    expect(p.state().input).toBe('C:\\Users\\ann\\Projects\\')
    expect(p.state().shown.find((f) => f.name === 'chess')?.podDocs).toBe(true)

    // Up from a folder lists its parent.
    fs.list.mockClear()
    const C_USERS_ANN = listing('C:\\Users\\ann', [entry('C:\\Users\\ann\\Projects')], { parent: 'C:\\Users' })
    fs.list.mockImplementationOnce(async () => ok(C_USERS_ANN))
    p.up()
    await flush()
    expect(fs.list).toHaveBeenLastCalledWith('C:\\Users\\ann')
    expect(p.state().input).toBe('C:\\Users\\ann\\')

    // Up from a root lists the roots.
    p.open('C:\\')
    await flush()
    expect(p.state().atRoots).toBe(false)
    p.up()
    await flush()
    expect(fs.list).toHaveBeenLastCalledWith(undefined)
    expect(p.state().atRoots).toBe(true)
    expect(p.state().input).toBe('')
    // At the roots: Add is disabled and Up does nothing.
    expect(p.state().target).toBeNull()
    const n = fs.list.mock.calls.length
    p.up()
    await p.add()
    expect(fs.list.mock.calls.length).toBe(n)
    expect(add).not.toHaveBeenCalled()

    // Click down from the roots to the folder, then Add with no typing: 201 closes.
    for (const path of ['C:\\', 'C:\\Users', 'C:\\Users\\ann\\Projects']) {
      p.open(path)
      await flush()
    }
    fs.list.mockImplementationOnce(async () => ok(listing('C:\\Users\\ann\\Projects\\chess', [entry('C:\\Users\\ann\\Projects\\chess\\pod-docs')], { parent: 'C:\\Users\\ann\\Projects' })))
    p.open(p.state().shown.find((f) => f.name === 'chess')!.path)
    await flush()
    expect(p.state().target).toBe('C:\\Users\\ann\\Projects\\chess')
    await p.add()
    expect(add).toHaveBeenCalledWith('C:\\Users\\ann\\Projects\\chess')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking down and adding: errors stay in the panel', async () => {
    const fs = fakeFs({ 'C:\\Users': USERS })
    const answers: AddResult[] = [{ status: 409, error: 'already registered' }, { status: 400, error: 'not a directory' }]
    const { p, onClose, add } = picker({ list: fs.list, add: async () => answers.shift()! })

    // A start folder that 404s falls back to the roots, with no error shown.
    p.start('E:\\gone')
    await flush()
    expect(fs.asked).toEqual(['E:\\gone', undefined])
    expect(p.state().atRoots).toBe(true)
    expect(p.state().input).toBe('')
    expect(p.state().error).toBeUndefined()

    // 409 shows `Already registered.` and keeps the panel open.
    p.open('C:\\Users')
    await flush()
    await p.add()
    expect(add).toHaveBeenCalledWith('C:\\Users')
    expect(p.state().error).toBe('Already registered.')
    expect(p.state().adding).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    // Moving on clears it.
    p.type('C:\\Users\\a')
    expect(p.state().error).toBeUndefined()
    p.type('C:\\Users\\ann')
    await p.add()
    expect(p.state().error).toBe('Not a directory.')

    // A thrown add reads as unreachable; one add at a time.
    let release!: (r: AddResult) => void
    const slow = picker({ list: fs.list, add: () => new Promise<AddResult>((r) => (release = r)) })
    slow.p.open('C:\\Users')
    await flush()
    const first = slow.p.add()
    expect(slow.p.state().adding).toBe(true)
    void slow.p.add()
    expect(slow.add).toHaveBeenCalledTimes(1)
    release({ status: 201 })
    await first
    expect(slow.onClose).toHaveBeenCalledTimes(1)
    const broken = picker({ list: fs.list, add: async () => Promise.reject(new TypeError('x')) })
    broken.p.open('C:\\Users')
    await flush()
    await broken.p.add()
    expect(broken.p.state().error).toBe(UNREACHABLE)

    // Any other listing error shows, and a typed folder that 404s isn't the start folder.
    p.type('C:\\nope\\')
    await vi.advanceTimersByTimeAsync(150)
    await flush()
    expect(p.state().error).toBe('Not a directory.')
    expect(p.state().atRoots).toBe(false)
    expect(p.state().target).toBeNull()

    // Escape closes and stops a waiting request.
    p.type('C:\\Users\\')
    const asked = fs.asked.length
    p.escape()
    expect(onClose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(fs.asked).toHaveLength(asked)
  })

  it('clicking down and adding: the rendered panel', async () => {
    const fs = fakeFs({ 'C:\\Users\\ann\\Projects': PROJECTS })
    const { p } = picker({ list: fs.list })
    const html = () => renderToStaticMarkup(createElement(PickerPanel, { state: p.state(), on: handlers }))
    const handlers = { type() {}, complete: () => false, open() {}, roots() {}, up() {}, add() {}, close() {} }

    p.start(null)
    await flush()
    // At the roots: Add is disabled, and there is no Up button.
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*>Add this folder<\/button>/)
    expect(html()).not.toMatch(/aria-label="Up/)
    p.open('C:\\Users\\ann\\Projects')
    await flush()
    const markup = html()
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Add this folder<\/button>/)
    expect(markup).toContain('value="C:\\Users\\ann\\Projects\\"')
    // A row per folder, and a pod-docs mark as an icon plus words.
    expect(markup.match(/class="picker-row"/g)).toHaveLength(2)
    expect(markup).toMatch(/chess<\/span><span class="picker-mark"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>pod-docs<\/span>/)
    expect(markup.match(/pod-docs/g)).toHaveLength(1)
    // Icons, not text glyphs; Close is labelled.
    expect(markup).toContain('aria-label="Close"')
    expect(markup).not.toMatch(/>[+⋯✓→↑×]</)
  })

  it('locked and truncated', async () => {
    const fs = fakeFs({
      'C:\\Locked': listing('C:\\Locked', [], { parent: 'C:\\', locked: true }),
      'C:\\Big': listing('C:\\Big', [entry('C:\\Big\\a'), entry('C:\\Big\\b')], { parent: 'C:\\', truncated: true }),
      'C:\\Empty': listing('C:\\Empty', [], { parent: 'C:\\' }),
    })
    const { p } = picker({ list: fs.list })
    const handlers = { type() {}, complete: () => false, open() {}, roots() {}, up() {}, add() {}, close() {} }
    const html = () => renderToStaticMarkup(createElement(PickerPanel, { state: p.state(), on: handlers }))

    p.open('C:\\Locked')
    await flush()
    expect(p.state().notice).toBe(LOCKED)
    expect(LOCKED).toBe("Can't open this folder.")
    expect(html()).toContain('Can&#x27;t open this folder.')

    p.open('C:\\Big')
    await flush()
    expect(p.state().notice).toBe(TRUNCATED)
    expect(TRUNCATED).toBe('Showing the first 1000 folders. Type to narrow.')
    expect(html()).toContain(TRUNCATED)

    // An empty folder, and a filter that keeps nothing, say so.
    p.open('C:\\Empty')
    await flush()
    expect(p.state().notice).toBe('No folders here.')
    p.open('C:\\Big')
    await flush()
    p.type('C:\\Big\\zz')
    expect(p.state().notice).toBe('No folder here starts with “zz”.')
    p.type('C:\\Big\\a')
    expect(p.state().notice).toBe(TRUNCATED)
  })
})

describe('folder picker crumbs', () => {
  it('splits a Windows path into This PC, the drive, and each folder', () => {
    expect(crumbsFor(listing('E:\\Projects\\pod', []))).toEqual([
      { label: 'This PC', path: null, current: false },
      { label: 'E:', path: 'E:\\', current: false },
      { label: 'Projects', path: 'E:\\Projects', current: false },
      { label: 'pod', path: 'E:\\Projects\\pod', current: true },
    ])
  })

  it('reads forward slashes in a Windows path the same way', () => {
    expect(crumbsFor(listing('E:/Projects', [])).map((c) => [c.label, c.path])).toEqual([
      ['This PC', null],
      ['E:', 'E:\\'],
      ['Projects', 'E:\\Projects'],
    ])
  })

  it('ends at the drive for a drive root', () => {
    expect(crumbsFor(listing('C:\\', []))).toEqual([
      { label: 'This PC', path: null, current: false },
      { label: 'C:', path: 'C:\\', current: true },
    ])
  })

  it('splits a POSIX path into /, then each folder', () => {
    expect(crumbsFor(listing('/home/ann', []))).toEqual([
      { label: '/', path: null, current: false },
      { label: 'home', path: '/home', current: false },
      { label: 'ann', path: '/home/ann', current: true },
    ])
  })

  it('shows one current crumb at the roots, named by what they hold', () => {
    expect(crumbsFor(ROOTS)).toEqual([{ label: 'This PC', path: null, current: true }])
    const posix = listing(null, [entry('/'), entry('/home/ann')])
    expect(crumbsFor(posix)).toEqual([{ label: '/', path: null, current: true }])
  })

  it('has none before the first listing', () => {
    expect(crumbsFor(undefined)).toEqual([])
  })

  it('the root crumb lists the roots', async () => {
    vi.useFakeTimers()
    const fs = fakeFs({ 'C:\\Users\\ann\\Projects': PROJECTS })
    const { p } = picker({ list: fs.list })
    p.start('C:\\Users\\ann\\Projects')
    await flush()
    p.roots()
    await flush()
    expect(fs.asked.at(-1)).toBeUndefined()
    expect(fs.asked).toHaveLength(2)
    expect(p.state().atRoots).toBe(true)
    expect(p.state().input).toBe('')
    vi.useRealTimers()
  })

  it('renders the crumbs row: plain crumbs, the middle folded, the current part marked', async () => {
    vi.useFakeTimers()
    const fs = fakeFs({ 'C:\\Users\\ann\\Projects': PROJECTS })
    const { p } = picker({ list: fs.list })
    p.start('C:\\Users\\ann\\Projects')
    await flush()
    const handlers = { type() {}, complete: () => false, open() {}, roots() {}, up() {}, add() {}, close() {} }
    const html = renderToStaticMarkup(createElement(PickerPanel, { state: p.state(), on: handlers }))
    vi.useRealTimers()
    // The path box has the bar to itself.
    const bar = /<div class="picker-bar">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
    expect(bar).toMatch(/id="picker-path"/)
    expect(bar).not.toMatch(/<button/)
    // The crumbs sit between the path box and the list.
    const crumbs = /<nav class="picker-crumbs"[^>]*aria-label="Folder path parts"[^>]*>([\s\S]*?)<\/nav>/.exec(html)
    expect(crumbs).not.toBeNull()
    expect(html.indexOf('picker-crumbs')).toBeGreaterThan(html.indexOf('id="picker-path"'))
    expect(html.indexOf('picker-crumbs')).toBeLessThan(html.indexOf('picker-list'))
    const row = crumbs![1]!
    // Plain crumbs: no Up button or other control.
    expect(row).not.toMatch(/picker-up|aria-label="Up/)
    // This PC › C: › Users › ann › Projects: the root and the last two stay, C: and Users fold into one button.
    const parts = [...row.matchAll(/<button[^>]*class="picker-crumb"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(parts).toEqual(['This PC', 'ann'])
    const fold = /<button[^>]*class="picker-fold"[^>]*>/.exec(row)?.[0] ?? ''
    expect(fold).toMatch(/aria-label="Show hidden folders"/)
    expect(fold).toMatch(/aria-expanded="false"/)
    expect(row.indexOf('picker-fold')).toBeGreaterThan(row.indexOf('This PC'))
    expect(row.indexOf('picker-fold')).toBeLessThan(row.indexOf('>ann<'))
    // The menu stays closed until the fold is pressed.
    expect(row).not.toMatch(/>Users</)
    // The current folder: not a button, its full name in a title.
    expect(row).toMatch(/<span[^>]*class="picker-crumb"[^>]*aria-current="location"[^>]*title="Projects"[^>]*>Projects<\/span>/)
    expect(row).not.toMatch(/>[›>…]</)
  })

  it('shows every crumb when there is nothing to fold', async () => {
    vi.useFakeTimers()
    const fs = fakeFs({ 'C:\\Users': USERS })
    const { p } = picker({ list: fs.list })
    p.start('C:\\Users')
    await flush()
    const handlers = { type() {}, complete: () => false, open() {}, roots() {}, add() {}, close() {} }
    const html = renderToStaticMarkup(createElement(PickerPanel, { state: p.state(), on: handlers }))
    vi.useRealTimers()
    expect(html).not.toMatch(/picker-fold/)
    const parts = [...html.matchAll(/<button[^>]*class="picker-crumb"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(parts).toEqual(['This PC', 'C:'])
  })
})

describe('folding crumbs', () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `c${i}`, path: i === 0 ? null : `/c${i}`, current: i === n - 1 }))

  it('keeps up to three crumbs as they are', () => {
    for (const n of [0, 1, 2, 3]) expect(foldCrumbs(chain(n))).toEqual({ head: chain(n), hidden: [], tail: [] })
  })

  it('folds everything between the root and the last two', () => {
    const c = chain(4)
    expect(foldCrumbs(c)).toEqual({ head: [c[0]], hidden: [c[1]], tail: [c[2], c[3]] })
    const deep = chain(8)
    expect(foldCrumbs(deep)).toEqual({ head: [deep[0]], hidden: deep.slice(1, 6), tail: deep.slice(6) })
  })

  it('the fold menu lists the hidden folders in order, each a button', () => {
    const hidden = chain(5).slice(1, 3)
    const closed = renderToStaticMarkup(createElement(CrumbFoldView, { hidden, open: false, onToggle() {}, onPick() {} }))
    expect(closed).toMatch(/<button[^>]*class="picker-fold"[^>]*aria-label="Show hidden folders"[^>]*aria-expanded="false"[^>]*><svg/)
    expect(closed).not.toMatch(/c1/)
    const open = renderToStaticMarkup(createElement(CrumbFoldView, { hidden, open: true, onToggle() {}, onPick() {} }))
    expect(open).toMatch(/aria-expanded="true"/)
    expect(open).toMatch(/class="menu picker-fold-menu"/)
    expect([...open.matchAll(/<button[^>]*class="picker-fold-item"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(['c1', 'c2'])
  })
})

describe('fold menu placement', () => {
  it('opens under the … button, inside the window, and scrolls past the bottom edge', () => {
    // A short dialog would clip a menu placed inside it, so the menu is placed against the window.
    expect(foldMenuPlace({ left: 380, bottom: 418 }, { width: 1280, height: 800 })).toEqual({ top: 422, left: 380, maxHeight: 362 })
  })

  it('moves left to stay on a narrow screen', () => {
    // 320 px wide at most, 16 px from the edge.
    expect(foldMenuPlace({ left: 200, bottom: 300 }, { width: 375, height: 667 })).toEqual({ top: 304, left: 39, maxHeight: 347 })
  })

  it('never starts left of the window', () => {
    expect(foldMenuPlace({ left: 4, bottom: 100 }, { width: 300, height: 600 }).left).toBe(16)
  })
})

describe('fold menu while the page moves', () => {
  it('keeps a usable height near the bottom of the window', () => {
    // 260 px window, button bottom at 240: 4 px under it would leave a negative height.
    expect(foldMenuPlace({ left: 380, bottom: 240 }, { width: 1280, height: 260 }).maxHeight).toBe(FOLD_MENU_MIN_HEIGHT)
    expect(FOLD_MENU_MIN_HEIGHT).toBeGreaterThanOrEqual(88)
  })

  it('closes on a window resize', () => {
    expect(foldMenuMoved('resize', false)).toBe(true)
  })

  it('closes when the dialog or page scrolls under it', () => {
    expect(foldMenuMoved('scroll', false)).toBe(true)
  })

  it('stays open while its own list scrolls', () => {
    expect(foldMenuMoved('scroll', true)).toBe(false)
  })
})
