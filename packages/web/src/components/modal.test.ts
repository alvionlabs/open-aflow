import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmModal, type ConfirmModalProps } from './ConfirmModal.tsx'
import { ModalAlert } from './ModalAlert.tsx'
import { backdropClose, createModalEvents, keepFocusInside, returnFocus } from './modal.ts'
import { StopList, type StopItem } from './StopList.tsx'

const confirm = (over: Partial<ConfirmModalProps> = {}) =>
  renderToStaticMarkup(
    createElement(ConfirmModal, {
      heading: 'Remove chess-web?',
      detail: 'The board stops watching this folder. No files change.',
      mono: ['E:\\code\\chess-web'],
      confirmLabel: 'Remove',
      busy: false,
      onConfirm: () => {},
      onCancel: () => {},
      returnFocusTo: 'run-more-1',
      ...over,
    }),
  )

/** A press as a browser reports it: where it went down, where its click landed, and where it came up. */
function press(events: ReturnType<typeof createModalEvents>, down: boolean, click: boolean, up: boolean) {
  const dialog = {}
  const at = (onDialog: boolean) => ({ target: onDialog ? dialog : {}, currentTarget: dialog })
  events.pointerDown(at(down))
  events.pointerUp(at(up))
  events.click(at(click))
}

function modalEvents(busy: boolean) {
  const onClose = vi.fn()
  const state = { busy, onClose }
  const events = createModalEvents(() => state)
  events.mount()
  return { events, onClose, state }
}

describe('shared modal', () => {
  it('backdropClose needs all three', () => {
    // A click lands on the nearest common ancestor of down and up, so it hits the <dialog> whenever either end is on the backdrop.
    expect(backdropClose(true, true, true)).toBe(true)
    expect(backdropClose(true, true, false)).toBe(false) // down on the dimmed page, up in the panel
    expect(backdropClose(false, true, true)).toBe(false) // a drag from the panel out to the backdrop
    expect(backdropClose(false, false, false)).toBe(false) // a click in the panel

    // Through the dialog's own events.
    const { events, onClose } = modalEvents(false)
    press(events, true, true, false)
    press(events, false, true, true)
    press(events, false, false, false)
    expect(onClose).not.toHaveBeenCalled()
    press(events, true, true, true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a press does not carry over into the next one', () => {
    // Down on the backdrop, then a click with no pointerdown of its own (a keyboard Enter on the dialog) must not close it.
    const { events, onClose } = modalEvents(false)
    const dialog = {}
    events.pointerDown({ target: dialog, currentTarget: dialog })
    events.pointerUp({ target: dialog, currentTarget: dialog })
    events.click({ target: {}, currentTarget: dialog })
    events.click({ target: dialog, currentTarget: dialog })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('busy keeps the modal open', () => {
    const { events, onClose, state } = modalEvents(true)
    const cancel = { preventDefault: vi.fn() }
    events.cancel(cancel)
    // Escape never closes the dialog natively: React owns the close.
    expect(cancel.preventDefault).toHaveBeenCalledTimes(1)
    press(events, true, true, true)
    expect(onClose).not.toHaveBeenCalled()

    // Once the work ends, the same presses close it.
    state.busy = false
    const cancel2 = { preventDefault: vi.fn() }
    events.cancel(cancel2)
    expect(cancel2.preventDefault).toHaveBeenCalledTimes(1)
    press(events, true, true, true)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('a dialog the browser closes on its own opens again while mounted', () => {
    // Chromium can skip `cancel` on a second Escape and close the dialog itself.
    const busy = modalEvents(true)
    const dialog = { open: false, showModal: vi.fn(() => (dialog.open = true)) }
    busy.events.nativeClose(dialog)
    expect(dialog.showModal).toHaveBeenCalledTimes(1)
    expect(busy.onClose).not.toHaveBeenCalled()

    // Not busy: it asks to close, once, even after the cancel that came first.
    const idle = modalEvents(false)
    idle.events.cancel({ preventDefault: () => {} })
    const d2 = { open: false, showModal: vi.fn(() => (d2.open = true)) }
    idle.events.nativeClose(d2)
    expect(idle.onClose).toHaveBeenCalledTimes(1)
    const fresh = modalEvents(false)
    const d3 = { open: false, showModal: vi.fn(() => (d3.open = true)) }
    fresh.events.nativeClose(d3)
    expect(fresh.onClose).toHaveBeenCalledTimes(1)
  })

  it('a stale close event after unmount or a StrictMode remount does nothing', () => {
    const { events, onClose } = modalEvents(false)
    // StrictMode: the cleanup closes the dialog, the remount shows it again, then the first close event arrives.
    events.unmount()
    events.mount()
    const reopened = { open: true, showModal: vi.fn() }
    events.nativeClose(reopened)
    expect(reopened.showModal).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // The remounted modal still answers a real close.
    const closed = { open: false, showModal: vi.fn(() => (closed.open = true)) }
    events.nativeClose(closed)
    expect(closed.showModal).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    // A real unmount: the parent already took it away.
    events.unmount()
    const gone = { open: false, showModal: vi.fn() }
    events.nativeClose(gone)
    expect(gone.showModal).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('confirm markup and button order', () => {
    const html = confirm({ mono: ['E:\\code\\chess-web', 'port base 3400'], notes: ['Its 1 run leaves the sidebar.'] })
    // A native dialog named by its heading.
    const dialog = /^<dialog[^>]*>/.exec(html)?.[0] ?? ''
    expect(dialog).toMatch(/class="modal[ "]/)
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(dialog)?.[1]
    expect(labelledBy).toBeTruthy()
    expect(html).toContain(`<h2 id="${labelledBy}"`)
    expect(html).toMatch(/<h2[^>]*>Remove chess-web\?<\/h2>/)
    // Heading, detail, the mono lines, the muted note, then the buttons.
    const order = ['Remove chess-web?', 'The board stops watching', 'E:\\code\\chess-web', 'port base 3400', 'Its 1 run leaves', '>Cancel<', '>Remove<']
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toMatch(/<p class="[^"]*\bmono\b[^"]*">E:\\code\\chess-web<\/p>/)
    expect(html).toMatch(/<p class="[^"]*\bmono\b[^"]*">port base 3400<\/p>/)
    expect(html).toMatch(/<p class="[^"]*\bmuted\b[^"]*">Its 1 run leaves the sidebar\.<\/p>/)
    // Cancel is quiet and first; the confirm is the danger button.
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]])
    expect(buttons.map(([label]) => label)).toEqual(['Cancel', 'Remove'])
    expect(buttons[0]![1]).toMatch(/class="btn quiet"/)
    expect(buttons[1]![1]).toMatch(/class="btn danger"/)
    expect(buttons.every(([, attrs]) => /type="button"/.test(attrs!))).toBe(true)
  })

  it('confirm leaves out what it is not given', () => {
    const html = confirm({ mono: undefined, notes: [] })
    expect(html).not.toMatch(/class="[^"]*\bmono\b/)
    expect(html).not.toMatch(/class="[^"]*\bmuted\b[^"]*">/)
    expect(html).not.toContain('role="alert"')
    // The live region is there before any status, so a screen reader hears the first one.
    expect(html).toMatch(/<p[^>]*role="status"[^>]*><\/p>/)
  })

  it('busy and error states', () => {
    const busy = confirm({ busy: true, status: 'Removing…' })
    const buttons = [...busy.matchAll(/<button([^>]*)>/g)].map((m) => m[1]!)
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b).toMatch(/disabled=""/)
    expect(busy).toMatch(/<p[^>]*role="status"[^>]*>Removing…<\/p>/)
    expect(busy).not.toContain('role="alert"')

    const idle = confirm()
    expect(idle).not.toContain('disabled')

    // Both at once: the status, then the error, both before the buttons.
    const failed = confirm({ status: 'Checked.', error: 'Couldn’t save the board’s config.' })
    // The error is the shared modal alert, the same markup as ModalAlert renders.
    expect(failed).toContain(renderToStaticMarkup(createElement(ModalAlert, { message: 'Couldn’t save the board’s config.' })))
    expect(failed).not.toContain('modal-error')
    const s = failed.indexOf('role="status"')
    const e = failed.indexOf('role="alert"')
    expect(s).toBeGreaterThanOrEqual(0)
    expect(e).toBeGreaterThan(s)
    expect(failed.indexOf('>Cancel<')).toBeGreaterThan(e)
  })

  it('modal alert: a box with role="alert", the alert icon, and the message', () => {
    const html = renderToStaticMarkup(createElement(ModalAlert, { message: 'Already registered.', id: 'err-1' }))
    const box = /^<div([^>]*)>/.exec(html)?.[1] ?? ''
    expect(box).toMatch(/class="modal-alert"/)
    expect(box).toMatch(/role="alert"/)
    expect(box).toMatch(/id="err-1"/)
    // The shared alert icon (a ring with !), hidden from assistive tech, before the message.
    const icon = html.indexOf('<svg')
    expect(icon).toBeGreaterThan(0)
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*<circle cx="8" cy="8" r="6"><\/circle><path d="M8 4\.75v3\.75M8 11\.25v\.01"><\/path><\/svg>/)
    expect(html).toMatch(/<p class="modal-alert-text">Already registered\.<\/p>/)
    expect(html.indexOf('Already registered.')).toBeGreaterThan(icon)
    // No id given, no id attribute.
    expect(renderToStaticMarkup(createElement(ModalAlert, { message: 'x' }))).not.toContain('id=')
  })

  it('focus stays in the dialog when its focused button goes disabled', () => {
    const dialog = { contains: (n: unknown) => n === inside, focus: vi.fn() }
    const inside = {}
    const body = {}
    keepFocusInside(dialog, { activeElement: body })
    expect(dialog.focus).toHaveBeenCalledTimes(1)
    keepFocusInside(dialog, { activeElement: inside })
    expect(dialog.focus).toHaveBeenCalledTimes(1)
    keepFocusInside(null, { activeElement: body })
    // Chromium moves focus off a button that just went disabled only at its next frame, after React's effects.
    const goingOff = { disabled: true }
    const dialog2 = { contains: (n: unknown) => n === goingOff, focus: vi.fn() }
    keepFocusInside(dialog2, { activeElement: goingOff })
    expect(dialog2.focus).toHaveBeenCalledTimes(1)
  })

  it('focus goes back to the opener', () => {
    const opener = { focus: vi.fn() }
    const other = { focus: vi.fn() }
    const body = {}
    const doc = (active: unknown, found: unknown = opener) =>
      ({ activeElement: active, body, getElementById: (id: string) => (id === 'run-more-1' ? found : null) }) as never
    // Focus fell to the body with the dialog: it goes to the opener.
    returnFocus('run-more-1', doc(body))
    expect(opener.focus).toHaveBeenCalledTimes(1)
    returnFocus('run-more-1', doc(null))
    expect(opener.focus).toHaveBeenCalledTimes(2)
    // Something else took focus (Open run's title, say): it stays there.
    returnFocus('run-more-1', doc(other))
    expect(opener.focus).toHaveBeenCalledTimes(2)
    expect(other.focus).not.toHaveBeenCalled()
    // The opener left the page with its card: nothing throws, nothing moves.
    expect(() => returnFocus('run-more-1', doc(body, null))).not.toThrow()
    expect(opener.focus).toHaveBeenCalledTimes(2)
  })

  it('stop list items', () => {
    const items: StopItem[] = [
      { key: 'm', label: 'Merged PR #12', time: '12:03', state: 'done' },
      { key: 's', label: 'Sent continue', time: '12:05', state: 'done', note: 'pod goes on with wave 2.' },
      { key: 'c', label: 'pod runs', time: '12:05', state: 'current' },
    ]
    const html = renderToStaticMarkup(createElement(StopList, { items }))
    expect(html).toMatch(/^<ol[^>]*aria-label="What happened"/)
    const lis = [...html.matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map((m) => ({ attrs: m[1]!, text: m[2]!.replace(/<[^>]+>/g, '') }))
    expect(lis).toHaveLength(3)
    expect(lis[0]).toEqual({ attrs: expect.stringMatching(/\bdone\b/), text: 'Merged PR #12 · 12:03' })
    expect(lis[1]!.text).toBe('Sent continue · 12:05pod goes on with wave 2.')
    expect(html).toMatch(/<li[^>]*>Sent continue.*<p class="[^"]*\bstop-note\b[^"]*">pod goes on with wave 2\.<\/p><\/li>/)
    // The current item shows "— now", never its time.
    expect(lis[2]).toEqual({ attrs: expect.stringMatching(/\bcurrent\b/), text: 'pod runs — now' })
    expect(lis[2]!.attrs).toMatch(/aria-current="step"/)
    // Only done items, with no current one, is still a list.
    const noCurrent = renderToStaticMarkup(createElement(StopList, { items: items.slice(0, 1) }))
    expect(noCurrent).not.toContain('— now')
    expect(noCurrent).toContain('Merged PR #12')
    // Empty: nothing at all.
    expect(renderToStaticMarkup(createElement(StopList, { items: [] }))).toBe('')
  })
})
