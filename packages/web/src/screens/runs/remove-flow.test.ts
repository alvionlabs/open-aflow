import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BoardRepo, RemoveRepoResult, RunSummary } from '@pod-board/model'
import type { ActionReply } from '../../actions-client.ts'
import { RemoveConfirmView } from './RemoveConfirm.tsx'
import { HEADER_PLACE, REMOVE_ITEM, confirmView, createRemoveFlow, hashAfterRemove, removeTarget, repoOfRun, type Post, type RemoveState, type RemoveTarget } from './remove-flow.ts'

const A: RemoveTarget = { repoId: 'ra', name: 'alpha-repo', path: 'C:/code/alpha-repo', alsoClaimed: false, runs: 2, place: HEADER_PLACE, returnTo: 'run-menu-trigger' }
const B: RemoveTarget = { repoId: 'rb', name: 'beta-repo', path: 'C:/code/beta-repo', alsoClaimed: false, runs: 1, place: HEADER_PLACE, returnTo: 'run-menu-trigger' }

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

function setup() {
  const calls: Call[] = []
  const post: Post = <T,>(path: string, body: object) =>
    new Promise<ActionReply<T>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  const seen: RemoveState[] = []
  const removed: RemoveTarget[] = []
  const done: [RemoveTarget, string | undefined][] = []
  const flow = createRemoveFlow(
    (s) => seen.push(s),
    (t, after) => {
      removed.push(t)
      done.push([t, after])
    },
    post,
  )
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const answer = async (i: number, reply: ActionReply<unknown>) => {
    expect(calls[i], `request ${i} was sent`).toBeDefined()
    calls[i]!.resolve(reply)
    await tick()
  }
  return { flow, calls, seen, removed, done, answer }
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
    expect(t.calls.map((c) => [c.path, c.body])).toEqual([['remove-repo', { repoId: 'ra', path: A.path }]])
    await t.answer(0, ok)
    expect(t.flow.state().kind).toBe('idle')
    expect(t.removed).toEqual([A])
  })

  it('keeps the next-run hash planned when Remove was pressed, though the runs and the selection change before the reply', async () => {
    const run = (repoId: string, name: string, plan: string): RunSummary => ({ repoId, repo: name, plan, where: '', state: 'idle' }) as RunSummary
    const before = [run('rb', 'beta-repo', 'one'), run('ra', 'alpha-repo', 'x'), run('rc', 'gamma', 'two')]
    const t = setup()
    t.flow.open(A)
    t.flow.remove(hashAfterRemove(before, before[1], A))
    // The new Board reaches the page first: A's run is gone and the page fell back to the first run.
    const after = [before[0]!, before[2]!]
    expect(hashAfterRemove(after, after[0], A)).toBeUndefined()
    await t.answer(0, ok)
    expect(t.done).toEqual([[A, '#/rc/two']])
  })

  it('a failed remove reports no hash to go to', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove('#/rc/two')
    await t.answer(0, refused('config unwritable', 500))
    expect(t.done).toEqual([])
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
  it('the menu item reads Remove repo', () => {
    expect(REMOVE_ITEM).toBe('Remove repo')
  })

  it('names the repo and says plainly that only the board list changes', () => {
    const s: RemoveState = { kind: 'confirm', seq: 1, target: A }
    const v = confirmView(s)!
    expect(v.heading).toBe('Remove alpha-repo?')
    expect(v.body).toBe("Only the board's list changes; its files aren't touched.")
    expect(v.runsLine).toBe('Its 2 runs leave the sidebar.')
    expect(v.path).toBe(A.path)
    expect(v.claimNote).toBeUndefined()
    expect(v.busy).toBe(false)
    expect(confirmView({ kind: 'idle', seq: 0 })).toBeUndefined()
  })

  it('counts one run in the singular', () => {
    expect(confirmView({ kind: 'confirm', seq: 1, target: B })!.runsLine).toBe('Its 1 run leaves the sidebar.')
  })

  it('a repo a port claim also lists keeps its runs: the claim note, no run count', () => {
    const v = confirmView({ kind: 'confirm', seq: 1, target: { ...A, alsoClaimed: true } })!
    expect(v.claimNote).toBe('A running pod run also lists this repo through its port claim, so it stays in the sidebar until that run ends.')
    expect(v.runsLine).toBeUndefined()
  })

  it('removing disables both buttons and says so', () => {
    const v = confirmView({ kind: 'removing', seq: 2, target: A })!
    expect(v.busy).toBe(true)
    expect(v.status).toBe('Removing…')
  })

  it('renders an in-place panel, not a dialog, with a danger Remove and a neutral Cancel', () => {
    const html = renderToStaticMarkup(createElement(RemoveConfirmView, { view: confirmView({ kind: 'confirm', seq: 1, target: A })!, onRemove: () => {}, onCancel: () => {}, onKey: () => {} }))
    expect(html).toMatch(/^<section[^>]*class="inplace remove-confirm"/)
    expect(html).not.toContain('role="dialog"')
    expect(html).toMatch(/tabindex="-1"/)
    const buttons = [...html.matchAll(/<button class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]])
    expect(buttons).toEqual([
      ['Remove', 'btn danger'],
      ['Cancel', 'btn quiet'],
    ])
    expect(html).toContain('Its 2 runs leave the sidebar.')
  })
})

const repo = (over: Partial<BoardRepo>): BoardRepo =>
  ({ id: 'ra', name: 'alpha-repo', path: A.path, source: 'registered', claims: [], model: { plans: [], queue: [] }, agents: [], prs: [], ...over }) as BoardRepo
const runOf = (repoId: string, name: string, plan?: string): RunSummary => ({ repoId, repo: name, ...(plan ? { plan } : {}), where: '', state: 'idle' }) as RunSummary
const ctx = (repos: BoardRepo[], runs: RunSummary[] = [runOf('ra', 'alpha-repo', 'x'), runOf('ra', 'alpha-repo', 'y')]) => ({ repos, runs, place: HEADER_PLACE, returnTo: 'run-menu-trigger' })

describe('removeTarget', () => {
  it('offers Remove for a repo in the config, and not for one listed only through a claim', () => {
    expect(removeTarget(repo({}), ctx([repo({})]))).toEqual(A)
    expect(removeTarget(repo({ source: 'both' }), ctx([repo({})]))).toEqual({ ...A, alsoClaimed: true })
    expect(removeTarget(repo({ source: 'claim' }), ctx([repo({})]))).toBeUndefined()
    expect(removeTarget(undefined, ctx([]))).toBeUndefined()
  })

  it('offers Remove for a repo whose folder is gone', () => {
    expect(removeTarget(repo({ error: 'repo folder not found' }), ctx([repo({})]))).toEqual(A)
  })

  it('counts only that repo runs, and keeps where it was opened and where focus goes back', () => {
    const runs = [runOf('ra', 'alpha-repo', 'x'), runOf('rb', 'beta-repo', 'y'), runOf('ra', 'alpha-repo', 'z'), runOf('ra', 'alpha-repo')]
    expect(removeTarget(repo({}), { repos: [repo({})], runs, place: '#/ra/x', returnTo: 'run-more-#/ra/x' })).toEqual({
      ...A,
      runs: 3,
      place: '#/ra/x',
      returnTo: 'run-more-#/ra/x',
    })
  })
})

describe('hashAfterRemove', () => {
  // A run carries its repo's name, as listRuns gives it: `ra` is A (alpha-repo).
  const run = (repoId: string, plan?: string): RunSummary => runOf(repoId, repoId === 'ra' ? A.name : repoId, plan)
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
    const only = [run('ra', 'x'), run('ra', 'y')]
    expect(hashAfterRemove(only, only[0], A)).toBe('')
  })

  it('stays put when a claim keeps the repo on the board', () => {
    expect(hashAfterRemove(runs, runs[1], { ...A, alsoClaimed: true })).toBeUndefined()
  })

  it('stays put when the open run belongs to another repo (a remove from the sidebar)', () => {
    expect(hashAfterRemove(runs, runs[0], A)).toBeUndefined()
    expect(hashAfterRemove(runs, runs[2], A)).toBeUndefined()
  })
})

describe('two repos with the same id (chess-web and chess_web)', () => {
  const dash = repo({ id: 'rx', name: 'chess-web', path: 'C:/code/chess-web' })
  const under = repo({ id: 'rx', name: 'chess_web', path: 'C:/code/chess_web' })
  const run = (name: string, plan: string): RunSummary => runOf('rx', name, plan)

  it('a run finds its own repo, not the first one with its id', () => {
    expect(repoOfRun([dash, under], run('chess_web', 'p'))).toBe(under)
    expect(repoOfRun([dash, under], run('chess-web', 'p'))).toBe(dash)
    expect(repoOfRun([dash, under], undefined)).toBeUndefined()
    expect(repoOfRun([dash], run('chess-web', 'p'))).toBe(dash)
  })

  it('Remove is not offered while the id is ambiguous, so nothing can remove the wrong repo', () => {
    expect(removeTarget(under, ctx([dash, under]))).toBeUndefined()
    expect(removeTarget(dash, ctx([dash, under]))).toBeUndefined()
    // With the sibling gone, the confirm names the selected run's repo.
    const t = removeTarget(repoOfRun([under], run('chess_web', 'p')), ctx([under], [run('chess_web', 'p')]))!
    expect(confirmView({ kind: 'confirm', seq: 1, target: t })!.heading).toBe('Remove chess_web?')
  })

  it('hashAfterRemove keeps the sibling run that shares the id', () => {
    const runs = [run('chess-web', 'a'), run('chess_web', 'b')]
    const target: RemoveTarget = { ...A, repoId: 'rx', name: 'chess-web', path: dash.path }
    expect(hashAfterRemove(runs, runs[0], target)).toBe('#/rx/b')
  })

  it('a 409 ambiguous repo reads as a plain sentence', async () => {
    const t = setup()
    t.flow.open(A)
    t.flow.remove()
    await t.answer(0, refused('ambiguous repo', 409))
    expect(confirmView(t.flow.state())?.error).toBe("Another repo on the board has the same id, so the board can't tell which one to remove. Nothing changed.")
  })
})
