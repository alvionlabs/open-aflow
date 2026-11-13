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

describe('desktop pick', () => {
  it('starts the folder dialog at once, with no modal while it is up', () => {
    const t = setup({ bridge: true })
    expect(t.flow.state()).toEqual({ kind: 'picking' })
    t.flow.start()
    expect(t.pick).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('picking')
  })

  it('null closes with no post', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve(null)
    await tick()
    expect(t.post).not.toHaveBeenCalled()
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })

  it('an empty path counts as a cancel', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('')
    await tick()
    expect(t.post).not.toHaveBeenCalled()
    expect(t.onClose).toHaveBeenCalledTimes(1)
  })

  it('a path posts once, with still no modal; 201 closes', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.post).toHaveBeenCalledWith('E:\\code\\chess-web')
    expect(t.flow.state().kind).toBe('picking')
    expect(t.onClose).not.toHaveBeenCalled()
    t.posts[0]!.resolve({ status: 201 })
    await tick()
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })

  it('a second start (React StrictMode runs effects twice) opens one dialog', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.flow.start()
    expect(t.pick).toHaveBeenCalledTimes(1)
  })

  it('after close, nothing more happens', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve(null)
    await tick()
    t.flow.type('x')
    void t.flow.add()
    t.flow.choose()
    t.flow.cancel()
    expect(t.post).not.toHaveBeenCalled()
    expect(t.pick).toHaveBeenCalledTimes(1)
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })
})

describe('desktop add error', () => {
  it('409 shows the already-added message with the path and Choose folder…', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', error: ADD_ALREADY, canChoose: true, busy: false })
    // The error turns Add off, until the path changes.
    expect(canAdd(s)).toBe(false)
    expect(t.onClose).not.toHaveBeenCalled()
  })

  it('a post that throws (board out of reach) says to try again, with Add on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    t.posts[0]!.reject(new TypeError('Failed to fetch'))
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', error: ADD_FAILED, busy: false })
    expect(s.pathError).toBeUndefined()
    expect(canAdd(s)).toBe(true)
    // The exact cause is in the console.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UNREACHABLE))
    warn.mockRestore()
  })

  it('Choose folder… opens the dialog again; while it is up the modal is busy; a path posts', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    t.flow.choose()
    expect(t.pick).toHaveBeenCalledTimes(2)
    expect(form(t.flow.state()).busy).toBe(true)
    // Busy: a second Choose, an Add, or a Cancel does nothing.
    t.flow.choose()
    void t.flow.add()
    t.flow.cancel()
    expect(t.pick).toHaveBeenCalledTimes(2)
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.onClose).not.toHaveBeenCalled()
    t.picks[1]!.resolve('E:\\code\\ytb-feed')
    await tick()
    expect(t.post).toHaveBeenLastCalledWith('E:\\code\\ytb-feed')
    expect(form(t.flow.state())).toMatchObject({ path: 'E:\\code\\ytb-feed', busy: true })
    expect(form(t.flow.state()).error).toBeUndefined()
    t.posts[1]!.resolve({ status: 201 })
    await tick()
    expect(t.onClose).toHaveBeenCalledTimes(1)
  })

  it('Choose folder… cancelled keeps the modal and its path', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    t.flow.choose()
    t.picks[1]!.resolve(null)
    await tick()
    expect(form(t.flow.state())).toMatchObject({ path: 'E:\\code\\chess-web', busy: false, error: ADD_ALREADY })
    // The error is back, so Add stays off.
    expect(canAdd(t.flow.state())).toBe(false)
    expect(t.onClose).not.toHaveBeenCalled()
    expect(t.post).toHaveBeenCalledTimes(1)
  })

  it('Choose folder… that fails keeps the path and says to type it', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    t.flow.choose()
    t.picks[1]!.reject(new Error('dialog failed'))
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', busy: false, error: BRIDGE_FAILED })
    // The dialog failure replaces the path error, so Add follows the path: here it isn't blank, so Add is on.
    expect(s.pathError).toBeUndefined()
    expect(canAdd(s)).toBe(true)
  })
})

describe('bridge fails', () => {
  for (const word of ['forbidden', 'dialog failed']) {
    it(`a ${word} rejection shows the type-the-path message and the field`, async () => {
      const t = setup({ bridge: true })
      t.flow.start()
      t.picks[0]!.reject(new Error(word))
      await tick()
      const s = form(t.flow.state())
      expect(BRIDGE_FAILED).toBe("Couldn't open the folder dialog. Type the path instead.")
      expect(s).toMatchObject({ path: '', error: BRIDGE_FAILED, busy: false })
      expect(canAdd(s)).toBe(false)
      expect(t.post).not.toHaveBeenCalled()
      expect(t.onClose).not.toHaveBeenCalled()
    })
  }

  it('the typed path then posts', async () => {
    const t = setup({ bridge: true })
    t.flow.start()
    t.picks[0]!.reject(new Error('dialog failed'))
    await tick()
    t.flow.type('  E:\\code\\chess-web ')
    expect(form(t.flow.state()).error).toBeUndefined()
    void t.flow.add()
    expect(t.post).toHaveBeenCalledWith('E:\\code\\chess-web')
  })
})

describe('browser path field', () => {
  it('opens the empty field at once, with no Choose folder…; start opens no dialog', () => {
    const t = setup({ bridge: false })
    t.flow.start()
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
    expect(canAdd({ kind: 'picking' })).toBe(false)
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

  it('field, Choose folder… below it, the alert, then Cancel and Add', () => {
    const html = render({ kind: 'form', path: 'E:\\code\\chess-web', busy: false, canChoose: true, error: ADD_ALREADY, pathError: true })
    const order = ['<label', '<input', '>Choose folder…<', 'class="modal-alert"', '>Cancel<', '>Add<']
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // Choose folder… is its own row under the field, not in the action row.
    const actions = html.slice(html.indexOf('class="modal-actions"'))
    expect(actions).not.toContain('Choose folder…')
    expect(buttons(actions).map((b) => b.label)).toEqual(['Cancel', 'Add'])
    expect(html).toMatch(/<div class="add-repo-choose"><button class="btn" type="button">Choose folder…<\/button><\/div>/)
    // The alert is the shared one, named by the field; Add is off while a path error shows.
    expect(html).toMatch(/<div id="[^"]+" class="modal-alert" role="alert">/)
    const errorId = /<div id="([^"]+)" class="modal-alert"/.exec(html)?.[1]
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${errorId}"`))
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/)
    expect(html).toContain(`>${ADD_ALREADY}</p>`)
    expect(html).not.toContain('modal-error')
    const add = buttons(html).find((b) => b.label === 'Add')!
    expect(add.attrs).toMatch(/disabled=""/)
  })

  it('an error that is not about the path: the alert names the field, the field is not invalid, Add is on', () => {
    const html = render({ kind: 'form', path: '/home/me/repo', busy: false, canChoose: false, error: ADD_FAILED })
    const errorId = /<div id="([^"]+)" class="modal-alert"/.exec(html)?.[1]
    expect(errorId).toBeDefined()
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${errorId}"`))
    expect(html).not.toContain('aria-invalid')
    // React escapes the apostrophe.
    expect(html).toContain(`>${ADD_FAILED.replace("'", '&#x27;')}</p>`)
    expect(buttons(html).find((b) => b.label === 'Add')!.attrs).not.toMatch(/disabled/)
  })

  it('no Choose folder… without the bridge, no alert without an error, and Add on for a path', () => {
    const html = render({ kind: 'form', path: '/home/me/repo', busy: false, canChoose: false })
    expect(html).not.toContain('Choose folder…')
    expect(html).not.toContain('add-repo-choose')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('aria-describedby')
    expect(buttons(html).map((b) => b.label)).toEqual(['Cancel', 'Add'])
    expect(buttons(html).find((b) => b.label === 'Add')!.attrs).not.toMatch(/disabled/)
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
