import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BoardRepo, RemoveRepoResult, RunSummary } from '@pod-board/model'
import type { ActionReply } from '../../actions-client.ts'
import { RemoveConfirmView } from './RemoveConfirm.tsx'
import { confirmView, createRemoveFlow, hashAfterRemove, removeLabel, removeTarget, type Post, type RemoveState, type RemoveTarget } from './remove-flow.ts'

const A: RemoveTarget = { repoId: 'ra', name: 'alpha-repo', path: 'C:\\code\\alpha-repo', alsoClaimed: false }
const B: RemoveTarget = { repoId: 'rb', name: 'beta-repo', path: 'C:\\code\\beta-repo', alsoClaimed: false }

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

function setup() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string, body: object) =>
    new Promise<ActionReply<T>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  const seen: RemoveState[] = []
  const removed: RemoveTarget[] = []
  const flow = createRemoveFlow((s) => seen.push(s), (t) => removed.push(t), post)
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const answer = async (i: number, reply: ActionReply<unknown>) => {
    expect(calls[i], `request ${i} was sent`).toBeDefined()
    calls[i]!.resolve(reply)
    await tick()
  }
  return { flow, calls, seen, removed, answer }
}

const ok: ActionReply<RemoveRepoResult> = { ok: true, data: { outcome: 'removed', path: A.path, logged: true } }
const refused = (message: string, status = 404): ActionReply<RemoveRepoResult> => ({ ok: false, status, message })

describe('remove flow', () => {
  it('opens a confirm, and Cancel or Escape closes it without a request', () => {
    const t = setup()
    t.flow.open(A)
    expect(t.flow.state()).toMatchObject({ kind: 'confirm', target: A })
    t.flow.cancel()
    expect(t.flow.state().kind).toBe('idle')
    t.flow.open(A)
    t.flow.key('Enter')
    expect(t.flow.state().kind).toBe('confirm')
    t.flow.key('Escape')
    expect(t.flow.state().kind).toBe('idle')
    expect(t.calls).toEqual([])
    expect(t.removed).toEqual([])
  })

  it('Remove posts the repo id once, then closes and reports the removal', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove()
    t.flow.remove()
    expect(t.flow.state().kind).toBe('removing')
    expect(t.calls.map((c) => [c.path, c.body])).toEqual([['remove-repo', { repoId: 'ra' }]])
    await t.answer(0, ok)
    expect(t.flow.state().kind).toBe('idle')
    expect(t.removed).toEqual([A])
  })

  it('Cancel and Escape do nothing while the remove runs', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove()
    t.flow.cancel()
    t.flow.key('Escape')
    t.flow.open(B)
    expect(t.flow.state()).toMatchObject({ kind: 'removing', target: A })
    await t.answer(0, ok)
    expect(t.removed).toEqual([A])
  })

  it('a refusal stays open with the reason, and Remove can be tried again', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove()
    await t.answer(0, refused('config unreadable', 500))
    expect(t.flow.state()).toMatchObject({ kind: 'error', target: A })
    expect(confirmView(t.flow.state())?.error).toBe("The board's config file can't be read, so nothing changed. Fix or delete config.json, then try again.")
    expect(t.removed).toEqual([])
    t.flow.remove()
    expect(t.calls).toHaveLength(2)
    await t.answer(1, ok)
    expect(t.removed).toEqual([A])
  })

  it('a repo already gone from the list says so in words', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove()
    await t.answer(0, refused('not registered'))
    expect(confirmView(t.flow.state())?.error).toBe("This repo is no longer in the board's list.")
    t.flow.open(A)
    t.flow.remove()
    await t.answer(1, refused('not on the board'))
    expect(confirmView(t.flow.state())?.error).toBe("This repo is no longer in the board's list.")
    t.flow.open(A)
    t.flow.remove()
    await t.answer(2, refused('The board restarted. Reload the page.', 403))
    expect(confirmView(t.flow.state())?.error).toBe('The board restarted. Reload the page.')
  })

  it('a reply for a confirm that was closed and opened again is dropped', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove()
    await t.answer(0, refused('config unwritable', 500))
    t.flow.cancel()
    t.flow.open(B)
    expect(t.flow.state()).toMatchObject({ kind: 'confirm', target: B })
  })
})

describe('confirm words', () => {
  it('the menu item names the repo', () => {
    expect(removeLabel('alpha-repo')).toBe('Remove alpha-repo from the board')
  })

  it('says plainly that only the board list changes', () => {
    const s: RemoveState = { kind: 'confirm', seq: 1, target: A }
    const v = confirmView(s)!
    expect(v.heading).toBe('Remove alpha-repo from the board?')
    expect(v.body).toBe("This changes only the board's list. The repo's files, pod docs, and runs are not touched. You can add it again with Add repo.")
    expect(v.path).toBe(A.path)
    expect(v.claimNote).toBeUndefined()
    expect(v.busy).toBe(false)
    expect(confirmView({ kind: 'idle', seq: 0 })).toBeUndefined()
  })

  it('a repo a port claim also lists says it stays in the sidebar while that run holds the claim', () => {
    const v = confirmView({ kind: 'confirm', seq: 1, target: { ...A, alsoClaimed: true } })!
    expect(v.claimNote).toBe('A running pod run also lists this repo through its port claim, so it stays in the sidebar until that run ends.')
  })

  it('removing disables both buttons and says so', () => {
    const v = confirmView({ kind: 'removing', seq: 2, target: A })!
    expect(v.busy).toBe(true)
    expect(v.status).toBe('Removing…')
  })

  it('renders an in-place panel, not a dialog, with Remove and Cancel', () => {
    const html = renderToStaticMarkup(createElement(RemoveConfirmView, { view: confirmView({ kind: 'confirm', seq: 1, target: A })!, onRemove: () => {}, onCancel: () => {}, onKey: () => {} }))
    expect(html).toMatch(/^<section[^>]*class="inplace remove-confirm"/)
    expect(html).not.toContain('role="dialog"')
    expect(html).toMatch(/tabindex="-1"/)
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(buttons).toEqual(['Remove', 'Cancel'])
    expect(html).toContain('not touched')
  })
})

const repo = (over: Partial<BoardRepo>): BoardRepo =>
  ({ id: 'ra', name: 'alpha-repo', path: A.path, source: 'registered', claims: [], model: { plans: [], queue: [] }, agents: [], prs: [], ...over }) as BoardRepo

describe('removeTarget', () => {
  it('offers Remove for a repo in the config, and not for one listed only through a claim', () => {
    expect(removeTarget(repo({}))).toEqual(A)
    expect(removeTarget(repo({ source: 'both' }))).toEqual({ ...A, alsoClaimed: true })
    expect(removeTarget(repo({ source: 'claim' }))).toBeUndefined()
    expect(removeTarget(undefined)).toBeUndefined()
  })

  it('offers Remove for a repo whose folder is gone', () => {
    expect(removeTarget(repo({ error: 'repo folder not found' }))).toEqual(A)
  })
})

describe('hashAfterRemove', () => {
  const run = (repoId: string, plan?: string): RunSummary => ({ repoId, repo: repoId, ...(plan ? { plan } : {}), where: '', state: 'idle' }) as RunSummary
  const runs = [run('rb', 'one'), run('ra', 'x'), run('rc', 'two'), run('ra', 'y'), run('rd')]

  it('moves to the next run of another repo after the selected one', () => {
    expect(hashAfterRemove(runs, runs[1], A)).toBe('#/rc/two')
    expect(hashAfterRemove(runs, runs[3], A)).toBe('#/rd')
  })

  it('moves back to the nearest run before it when none comes after', () => {
    const tail = [run('rb', 'one'), run('ra', 'x')]
    expect(hashAfterRemove(tail, tail[1], A)).toBe('#/rb/one')
  })

  it('clears the hash when no run is left, so the empty state shows', () => {
    expect(hashAfterRemove([run('ra', 'x'), run('ra', 'y')], run('ra', 'x'), A)).toBe('')
  })

  it('stays put when a claim keeps the repo on the board', () => {
    expect(hashAfterRemove(runs, runs[1], { ...A, alsoClaimed: true })).toBeUndefined()
  })
})
