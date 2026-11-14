import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RESTARTED, UNREACHABLE } from '../../actions-client.ts'
import { ADD_ALREADY, ADD_BAD_PATH, ADD_FAILED, ADD_RELOAD, type AddResult } from '../../add-repo.ts'
import { AddRepoForm } from './AddRepoDialog.tsx'
import { BRIDGE_FAILED, canAdd, createAddRepoFlow, pathHint, type AddRepoState } from './add-repo-flow.ts'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A flow over fakes: `picks` and `posts` answer in order; each call takes the next one. */
function setup(opts: { bridge: boolean }) {
  const picks: ReturnType<typeof deferred<string | null>>[] = []
  const posts: ReturnType<typeof deferred<AddResult>>[] = []
  const pick = vi.fn(() => {
    const d = deferred<string | null>()
    picks.push(d)
    return d.promise
  })
  const post = vi.fn((_path: string) => {
    const d = deferred<AddResult>()
    posts.push(d)
    return d.promise
  })
  const onClose = vi.fn()
  const seen: AddRepoState[] = []
  const flow = createAddRepoFlow({ ...(opts.bridge ? { pick } : {}), post, onClose }, (s) => seen.push(s))
  return { flow, pick, post, onClose, picks, posts, seen }
}

const form = (s: AddRepoState) => {
  if (s.kind !== 'form') throw new Error(`expected the form, got ${s.kind}`)
  return s
}

describe('desktop: the form first', () => {
  it('opens the modal with an empty path and Browse…; no folder dialog until Browse…', async () => {
    const t = setup({ bridge: true })
    expect(t.flow.state()).toEqual({ kind: 'form', path: '', busy: false, canChoose: true })
    expect(canAdd(t.flow.state())).toBe(false)
    await tick()
    expect(t.pick).not.toHaveBeenCalled()
    t.flow.choose()
    expect(t.pick).toHaveBeenCalledTimes(1)
  })

  it('a typed path adds with no folder dialog', () => {
    const t = setup({ bridge: true })
    t.flow.type(' /home/me/repo ')
    void t.flow.add()
    expect(t.pick).not.toHaveBeenCalled()
    expect(t.post).toHaveBeenCalledWith('/home/me/repo')
  })

  it('a picked folder fills the field, posts nothing, turns Add on, and moves focus to Add', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('/home/me/chess-web')
    await tick()
    const s = form(t.flow.state())
    expect(s).toEqual({ kind: 'form', path: '/home/me/chess-web', busy: false, canChoose: true, focus: 'add' })
    expect(canAdd(s)).toBe(true)
    expect(t.post).not.toHaveBeenCalled()
    expect(t.onClose).not.toHaveBeenCalled()
  })

  it('a picked folder clears a path error, so Add turns on', async () => {
    const t = setup({ bridge: true })
    t.flow.type('/home/me/chess-web')
    void t.flow.add()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    expect(canAdd(t.flow.state())).toBe(false)
    t.flow.choose()
    t.picks[0]!.resolve('/home/me/ytb-feed')
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: '/home/me/ytb-feed', busy: false })
    expect(s.error).toBeUndefined()
    expect(s.pathError).toBeUndefined()
    expect(canAdd(s)).toBe(true)
    expect(t.post).toHaveBeenCalledTimes(1)
  })

  it('a picked folder clears a system error too', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.reject(new Error('dialog failed'))
    await tick()
    t.flow.choose()
    t.picks[1]!.resolve('/home/me/chess-web')
    await tick()
    expect(form(t.flow.state()).error).toBeUndefined()
  })

  for (const answer of [null, '']) {
    it(`a cancelled pick (${JSON.stringify(answer)}) changes nothing and gives focus back to Browse…`, async () => {
      const t = setup({ bridge: true })
      t.flow.type('/home/me/chess-web')
      void t.flow.add()
      t.posts[0]!.resolve({ status: 409, error: 'already registered' })
      await tick()
      const before = form(t.flow.state())
      t.flow.choose()
      t.picks[0]!.resolve(answer)
      await tick()
      expect(t.flow.state()).toEqual({ ...before, focus: 'browse' })
      expect(canAdd(t.flow.state())).toBe(false)
      expect(t.post).toHaveBeenCalledTimes(1)
      expect(t.onClose).not.toHaveBeenCalled()
    })
  }

  for (const word of ['forbidden', 'dialog failed']) {
    it(`a pick that fails (${word}) shows the type-the-path message in the box and keeps the path`, async () => {
      const t = setup({ bridge: true })
      t.flow.type('/home/me/chess-web')
      t.flow.choose()
      t.picks[0]!.reject(new Error(word))
      await tick()
      const s = form(t.flow.state())
      expect(BRIDGE_FAILED).toBe("Couldn't open the folder dialog. Type the path instead.")
      expect(s).toMatchObject({ path: '/home/me/chess-web', busy: false, error: BRIDGE_FAILED, focus: 'path' })
      expect(s.pathError).toBeUndefined()
      expect(canAdd(s)).toBe(true)
      expect(t.post).not.toHaveBeenCalled()
      expect(t.onClose).not.toHaveBeenCalled()
    })
  }

  it('while a pick is out the modal is busy: Add, Browse…, Cancel, and typing do nothing', async () => {
    const t = setup({ bridge: true })
    t.flow.type('/home/me/old')
    t.flow.choose()
    expect(form(t.flow.state()).busy).toBe(true)
    expect(canAdd(t.flow.state())).toBe(false)
    void t.flow.add()
    t.flow.choose()
    t.flow.cancel()
    t.flow.type('/x')
    expect(t.post).not.toHaveBeenCalled()
    expect(t.pick).toHaveBeenCalledTimes(1)
    expect(t.onClose).not.toHaveBeenCalled()
    expect(form(t.flow.state()).path).toBe('/home/me/old')
    t.picks[0]!.resolve('/home/me/new')
    await tick()
    expect(form(t.flow.state())).toMatchObject({ path: '/home/me/new', busy: false })
  })

  it('Add after a pick posts that path; 201 closes', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    const added = t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.post).toHaveBeenCalledWith('E:\\code\\chess-web')
    expect(form(t.flow.state()).busy).toBe(true)
    t.posts[0]!.resolve({ status: 201 })
    await added
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })

  it('Add after a pick, refused as already added: the inline path error, the path kept, Add off', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    const added = t.flow.add()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await added
    const s = form(t.flow.state())
    // Add was off while busy, so focus goes back to the field to fix the path.
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', busy: false, error: ADD_ALREADY, pathError: true, canChoose: true, focus: 'path' })
    expect(canAdd(s)).toBe(false)
    expect(t.onClose).not.toHaveBeenCalled()
  })

  it('Add after a pick that throws (board out of reach): the box says try again, Add on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    const added = t.flow.add()
    t.posts[0]!.reject(new TypeError('Failed to fetch'))
    await added
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', error: ADD_FAILED, busy: false, focus: 'path' })
    expect(s.pathError).toBeUndefined()
    expect(canAdd(s)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UNREACHABLE))
    warn.mockRestore()
  })

  it('after close, nothing more happens', async () => {
    const t = setup({ bridge: true })
    t.flow.cancel()
    t.flow.type('x')
    void t.flow.add()
    t.flow.choose()
    t.flow.cancel()
    expect(t.post).not.toHaveBeenCalled()
    expect(t.pick).not.toHaveBeenCalled()
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })
})

describe('browser path field', () => {
  it('opens the empty field at once, with no Browse…; choose does nothing', () => {
    const t = setup({ bridge: false })
    const s = form(t.flow.state())
    expect(s).toEqual({ kind: 'form', path: '', busy: false, canChoose: false })
    t.flow.choose()
    expect(t.flow.state()).toEqual(s)
  })

  it('blank keeps Add off and posts nothing', () => {
    const t = setup({ bridge: false })
    expect(canAdd(t.flow.state())).toBe(false)
    t.flow.type('   ')
    expect(canAdd(t.flow.state())).toBe(false)
    void t.flow.add()
    expect(t.post).not.toHaveBeenCalled()
    t.flow.type('/home/me/repo')
    expect(canAdd(t.flow.state())).toBe(true)
  })

  it('the path is trimmed', () => {
    const t = setup({ bridge: false })
    t.flow.type('  /home/me/repo\t')
    void t.flow.add()
    expect(t.post).toHaveBeenCalledWith('/home/me/repo')
    expect(form(t.flow.state()).path).toBe('  /home/me/repo\t')
  })

  it('a second Add while posting sends nothing, and the modal is busy', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    void t.flow.add()
    expect(form(t.flow.state()).busy).toBe(true)
    expect(canAdd(t.flow.state())).toBe(false)
    void t.flow.add()
    t.flow.cancel()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.onClose).not.toHaveBeenCalled()
    t.posts[0]!.resolve({ status: 400, error: 'not a directory' })
    await tick()
    expect(form(t.flow.state())).toMatchObject({ busy: false, error: ADD_BAD_PATH })
    // Typing clears the error; Add then sends again.
    t.flow.type('/home/me/repo2')
    expect(form(t.flow.state()).error).toBeUndefined()
    void t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(2)
  })

  it('an error turns Add off; a change to the path turns it on again', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    void t.flow.add()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: '/home/me/repo', busy: false, error: ADD_ALREADY })
    expect(canAdd(s)).toBe(false)
    // Enter (add) does nothing while the error shows.
    void t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(form(t.flow.state()).busy).toBe(false)
    // A change to the path clears the error and turns Add on.
    t.flow.type('/home/me/repo2')
    expect(form(t.flow.state()).error).toBeUndefined()
    expect(canAdd(t.flow.state())).toBe(true)
    // A change to a blank path clears the error, but Add stays off.
    t.flow.type('  ')
    expect(form(t.flow.state()).error).toBeUndefined()
    expect(canAdd(t.flow.state())).toBe(false)
  })

  it('canAdd: an idle form with a path and no error', () => {
    const base = { kind: 'form', path: '/a', busy: false, canChoose: false } as const
    expect(canAdd(base)).toBe(true)
    expect(canAdd({ ...base, error: ADD_ALREADY, pathError: true })).toBe(false)
    // An error that isn't about the path keeps Add on, so the same path can be tried again.
    expect(canAdd({ ...base, error: ADD_FAILED })).toBe(true)
    expect(canAdd({ ...base, error: '' })).toBe(true)
    expect(canAdd({ ...base, busy: true })).toBe(false)
    expect(canAdd({ kind: 'closed' })).toBe(false)
  })

  it('Cancel closes; 201 closes', async () => {
    const a = setup({ bridge: false })
    a.flow.cancel()
    expect(a.onClose).toHaveBeenCalledTimes(1)
    expect(a.flow.state().kind).toBe('closed')

    const b = setup({ bridge: false })
    b.flow.type('/home/me/repo')
    void b.flow.add()
    b.posts[0]!.resolve({ status: 201 })
    await tick()
    expect(b.onClose).toHaveBeenCalledTimes(1)
  })

  it('every change reaches onChange', () => {
    const t = setup({ bridge: false })
    t.flow.type('/a')
    expect(t.seen.at(-1)).toEqual(t.flow.state())
  })
})

describe('the path hint', () => {
  it('shows a path in the form of the user\'s own system', () => {
    expect(pathHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('C:\\code\\my-repo')
    expect(pathHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe('/Users/you/code/my-repo')
    expect(pathHint('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('/home/you/code/my-repo')
    expect(pathHint('')).toBe('/home/you/code/my-repo')
  })
})

describe('the Add repo modal', () => {
  type Form = Extract<AddRepoState, { kind: 'form' }>
  const render = (state: Form) => {
    const { flow } = setup({ bridge: state.canChoose })
    return renderToStaticMarkup(createElement(AddRepoForm, { state, flow }))
  }
  const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ label: m[2]!, attrs: m[1]! }))

  /** The markup between the first `<div class="add-repo-row">` and its closing tag (it holds no nested div). */
  const row = (html: string) => /<div class="add-repo-row">([\s\S]*?)<\/div>/.exec(html)?.[1]

  it('path error: the label, a row with the field and Browse…, the inline error, then Cancel and Add', () => {
    const html = render({ kind: 'form', path: 'E:\\code\\chess-web', busy: false, canChoose: true, error: ADD_ALREADY, pathError: true })
    const order = ['<label', 'class="add-repo-row"', '<input', 'Browse…</button>', 'class="modal-field-error"', '>Cancel<', '>Add<']
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The field and Browse… share one row; Browse… is a regular button with the 16 px folder icon, not in the actions.
    const inRow = row(html)!
    expect(inRow).toMatch(/^<input[^>]*>/)
    expect(inRow).toMatch(/<button class="btn lead" type="button"><svg[^>]*width="16"[^>]*>[\s\S]*?<\/svg>Browse…<\/button>$/)
    const actions = html.slice(html.indexOf('class="modal-actions"'))
    expect(buttons(actions).map((b) => b.label)).toEqual(['Cancel', 'Add'])
    // The path error is inline under the row: no alert box. The field names it and is invalid; Add is off.
    expect(html).not.toContain('modal-alert')
    const inline = /<p id="([^"]+)" class="modal-field-error" role="alert"><svg[^>]*>[\s\S]*?<\/svg><span>([^<]*)<\/span><\/p>/.exec(html)
    expect(inline, html).not.toBeNull()
    expect(inline![2]).toBe(ADD_ALREADY)
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${inline![1]}"`))
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/)
    // The label, the row, and the inline error are one group, so the panel's gaps fall between groups.
    expect(html).toMatch(/<div class="add-repo-field"><label[\s\S]*?<\/label><div class="add-repo-row">[\s\S]*?<\/div><p id="[^"]+" class="modal-field-error"[\s\S]*?<\/p><\/div>/)
    expect(buttons(html).find((b) => b.label === 'Add')!.attrs).toMatch(/disabled=""/)
  })

  it('the second path error shows inline too', () => {
    const html = render({ kind: 'form', path: '/nope', busy: false, canChoose: false, error: ADD_BAD_PATH, pathError: true })
    expect(html).toContain(`<span>${ADD_BAD_PATH.replace("'", '&#x27;')}</span>`)
    expect(html).not.toContain('modal-alert')
  })

  for (const message of [ADD_FAILED, ADD_RELOAD, BRIDGE_FAILED]) {
    it(`system error "${message}": the alert box above the actions, no inline error, the field not invalid, Add on`, () => {
      const html = render({ kind: 'form', path: '/home/me/repo', busy: false, canChoose: true, error: message })
      expect(html).not.toContain('modal-field-error')
      expect(html).not.toContain('aria-invalid')
      const errorId = /<div id="([^"]+)" class="modal-alert" role="alert">/.exec(html)?.[1]
      expect(errorId, html).toBeDefined()
      expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${errorId}"`))
      // React escapes the apostrophe.
      expect(html).toContain(`>${message.replace("'", '&#x27;')}</p>`)
      // The box sits after the field group and before the actions.
      const at = ['class="add-repo-field"', '</div></div><div id=', 'class="modal-alert"', 'class="modal-actions"'].map((s) => html.indexOf(s))
      expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
      expect(buttons(html).find((b) => b.label === 'Add')!.attrs).not.toMatch(/disabled/)
    })
  }

  it('without the bridge: no Browse…, the field alone fills its row, no error, and Add on for a path', () => {
    const html = render({ kind: 'form', path: '/home/me/repo', busy: false, canChoose: false })
    expect(html).not.toContain('Browse')
    expect(row(html)).toMatch(/^<input[^>]*\/>$/)
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('aria-describedby')
    expect(buttons(html).map((b) => b.label)).toEqual(['Cancel', 'Add'])
    expect(buttons(html).find((b) => b.label === 'Add')!.attrs).not.toMatch(/disabled/)
  })

  it('Browse… is off while the modal is busy', () => {
    const html = render({ kind: 'form', path: '/home/me/repo', busy: true, canChoose: true })
    expect(row(html)).toMatch(/<button class="btn lead" type="button" disabled="">/)
  })
})

describe('an error that is not about the path', () => {
  it('keeps Add on, so you can try the same path again', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    const added = t.flow.add()
    t.posts[0]!.resolve({ status: 500, error: 'config unreadable' })
    await added
    expect(form(t.flow.state())).toMatchObject({ path: '/home/me/repo', error: ADD_FAILED })
    expect(canAdd(t.flow.state())).toBe(true)
    // Add again with the same path: it posts, and a 201 closes the modal.
    const again = t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(2)
    expect(t.post).toHaveBeenLastCalledWith('/home/me/repo')
    t.posts[1]!.resolve({ status: 201 })
    await again
    expect(t.onClose).toHaveBeenCalledTimes(1)
  })

  it('a reload message keeps Add on too', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    const added = t.flow.add()
    t.posts[0]!.resolve({ status: 403, error: RESTARTED })
    await added
    expect(form(t.flow.state())).toMatchObject({ error: ADD_RELOAD })
    expect(canAdd(t.flow.state())).toBe(true)
  })
})
