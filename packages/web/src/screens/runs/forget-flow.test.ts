import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildRepoModel, type AgentRun, type BoardRepo, type ForgetRunResult, type PrStatus, type RunSummary } from '@openaflow/model'
import { NEED_RELOAD, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import { ConfirmModal } from '../../components/ConfirmModal.tsx'
import {
  FORGET_ITEM,
  createForgetFlow,
  forgetTarget,
  forgetView,
  hashAfterForget,
  navigateAfterForget,
  worktreePath,
  type ForgetState,
  type ForgetTarget,
} from './forget-flow.ts'
import type { Post } from './remove-flow.ts'

const NOW = Date.UTC(2026, 10, 12, 12)
const MIN = 60_000

const T: ForgetTarget = { repoId: 'rw', run: 'task-scroll', name: 'Fix the scroll', worktree: 'C:\\code\\web\\.claude\\worktrees\\task-scroll', portBase: 3400 }

type Call = { path: string; body: object; resolve: (r: ActionReply<unknown>) => void }

function setup() {
  const calls: Call[] = []
  const post: Post = <R,>(path: string, body: object) => new Promise<ActionReply<R>>((resolve) => calls.push({ path, body, resolve: resolve as (r: ActionReply<unknown>) => void }))
  const seen: ForgetState[] = []
  const done: [ForgetTarget, string | undefined][] = []
  const flow = createForgetFlow((s) => seen.push(s), (t, after) => done.push([t, after]), post)
  const answer = async (i: number, reply: ActionReply<unknown>) => {
    expect(calls[i], `request ${i} was sent`).toBeDefined()
    calls[i]!.resolve(reply)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { flow, calls, seen, done, answer }
}

const ok: ActionReply<ForgetRunResult> = { ok: true, data: { outcome: 'removed', run: T.run, portBase: T.portBase, logged: true } }
const refused = (message: string, status = 404): ActionReply<ForgetRunResult> => ({ ok: false, status, message })

describe('forget view', () => {
  it('the menu item reads Forget this run', () => {
    expect(FORGET_ITEM).toBe('Forget this run')
  })

  it('names the run, says the worktree and branch stay, and shows the worktree path and the port base in mono', () => {
    expect(forgetView({ kind: 'confirm', seq: 0, target: T })).toEqual({
      heading: 'Forget Fix the scroll?',
      detail: 'The board stops listing this run. Its worktree and branch stay.',
      mono: ['C:\\code\\web\\.claude\\worktrees\\task-scroll', 'port base 3400'],
      confirmLabel: 'Forget',
      busy: false,
      returnFocusTo: 'run-menu-trigger',
    })
    expect(forgetView({ kind: 'idle', seq: 0 })).toBeUndefined()
  })

  it('builds the worktree path with the repo path own separator: Windows and POSIX', () => {
    expect(worktreePath('C:\\code\\web', 'task-scroll', true)).toBe('C:\\code\\web\\.claude\\worktrees\\task-scroll')
    expect(worktreePath('/home/me/web', 'task-scroll', true)).toBe('/home/me/web/.claude/worktrees/task-scroll')
    // A Windows path the config holds with forward slashes keeps them.
    expect(worktreePath('C:/code/web', 'fix-scroll', true)).toBe('C:/code/web/.claude/worktrees/fix-scroll')
  })

  it('drops a trailing separator, so no doubled one shows', () => {
    expect(worktreePath('C:\\code\\web\\', 'task-scroll', true)).toBe('C:\\code\\web\\.claude\\worktrees\\task-scroll')
    expect(worktreePath('/home/me/web/', 'task-scroll', true)).toBe('/home/me/web/.claude/worktrees/task-scroll')
  })

  it('a plan run has a worktree per slice, so it shows their folder', () => {
    expect(worktreePath('C:\\code\\web', 'alpha', false)).toBe('C:\\code\\web\\.claude\\worktrees')
    expect(worktreePath('/home/me/web', 'alpha', false)).toBe('/home/me/web/.claude/worktrees')
  })

  it('forgetting disables both buttons and says so', () => {
    const v = forgetView({ kind: 'forgetting', seq: 1, target: T })!
    expect(v.busy).toBe(true)
    expect(v.status).toBe('Forgetting…')
  })

  it('renders as the shared modal: Cancel, then a danger Forget, with both mono lines', () => {
    const html = renderToStaticMarkup(createElement(ConfirmModal, { ...forgetView({ kind: 'confirm', seq: 0, target: T })!, onConfirm: () => {}, onCancel: () => {} }))
    expect(html).toMatch(/^<dialog[^>]*class="modal confirm-modal"/)
    expect([...html.matchAll(/<p class="mono modal-mono">([^<]*)<\/p>/g)].map((m) => m[1])).toEqual([T.worktree, 'port base 3400'])
    expect([...html.matchAll(/<button class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]])).toEqual([
      ['Cancel', 'btn quiet'],
      ['Forget', 'btn danger'],
    ])
  })
})

describe('forgetTarget: only a run forgetCheck allows', () => {
  let n = 0
  const agent = (over: Partial<AgentRun>): AgentRun => ({ id: `a${++n}`, session: 's', type: 'pod:engineer', tokens: 0, ended: true, startedAt: NOW - 120 * MIN, lastAt: NOW - 90 * MIN, branch: 'task-scroll', ...over })
  const merged: PrStatus = { number: 7, state: 'merged', checks: 'pass', checkedAt: NOW, branch: 'task-scroll', mergedAt: NOW - 60 * MIN }
  const leftover = (over: Partial<BoardRepo> = {}): BoardRepo => ({
    id: 'rw',
    name: 'web',
    path: 'C:\\code\\web',
    source: 'claim',
    model: buildRepoModel({ 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n' }),
    agents: [agent({}), agent({ type: 'pod:reviewer', kind: 'fix', startedAt: NOW - 80 * MIN, lastAt: NOW - 70 * MIN })],
    prs: [merged],
    claims: [{ portBase: 3400, repoPath: 'C:\\code\\web', plan: 'task-scroll' }],
    ...over,
  })
  const run = { repoId: 'rw', repo: 'web', plan: 'task-scroll', fix: 'scroll', where: '', state: 'needs-you' } as RunSummary

  it('a leftover one-off run: its port base, its worktree, and the name it was given', () => {
    expect(forgetTarget(leftover(), run, 'Fix the scroll', NOW)).toEqual(T)
  })

  it('none for a running run, a run with two claims, no run, or no repo', () => {
    expect(forgetTarget(leftover({ agents: [agent({ ended: false, lastAt: NOW - MIN })] }), run, 'x', NOW)).toBeUndefined()
    const two = leftover().claims.concat({ portBase: 3500, repoPath: 'C:\\code\\web', plan: 'task-scroll' })
    expect(forgetTarget(leftover({ claims: two }), run, 'x', NOW)).toBeUndefined()
    expect(forgetTarget(leftover(), undefined, 'x', NOW)).toBeUndefined()
    expect(forgetTarget(undefined, run, 'x', NOW)).toBeUndefined()
    expect(forgetTarget(leftover(), { ...run, plan: undefined } as RunSummary, 'x', NOW)).toBeUndefined()
  })
})

describe('one request per confirm', () => {
  it('Forget posts {repoId, run, portBase} once, then closes and reports it', async () => {
    const t = setup()
    t.flow.open(T)
    t.flow.forget('#/ra/x')
    t.flow.forget('#/ra/x')
    expect(t.flow.state().kind).toBe('forgetting')
    expect(t.calls.map((c) => [c.path, c.body])).toEqual([['forget-run', { repoId: 'rw', run: 'task-scroll', portBase: 3400 }]])
    await t.answer(0, ok)
    expect(t.flow.state().kind).toBe('idle')
    expect(t.done).toEqual([[T, '#/ra/x']])
  })

  it('Cancel closes the confirm with no request', () => {
    const t = setup()
    t.flow.open(T)
    t.flow.cancel()
    expect(t.flow.state().kind).toBe('idle')
    expect(t.calls).toEqual([])
  })

  it('a reply after cancel is dropped: the Board came first and moved the page, which cancels', async () => {
    const t = setup()
    t.flow.open(T)
    t.flow.forget('#/ra/x')
    t.flow.cancel()
    expect(t.flow.state().kind).toBe('idle')
    await t.answer(0, ok)
    expect(t.flow.state().kind).toBe('idle')
    expect(t.done).toEqual([])
  })

  it('an old reply is dropped after the modal opened again and sent again', async () => {
    const t = setup()
    t.flow.open(T)
    t.flow.forget()
    t.flow.cancel()
    t.flow.open(T)
    t.flow.forget()
    await t.answer(0, refused('no claim'))
    expect(t.flow.state().kind).toBe('forgetting')
    await t.answer(1, ok)
    expect(t.done).toHaveLength(1)
  })

  it('a refusal stays open with its sentence, and Forget can be tried again', async () => {
    const t = setup()
    t.flow.open(T)
    t.flow.forget()
    await t.answer(0, refused('claim unremovable', 500))
    expect(t.flow.state()).toMatchObject({ kind: 'error', target: T })
    expect(forgetView(t.flow.state())!.busy).toBe(false)
    expect(t.done).toEqual([])
    t.flow.forget()
    expect(t.calls).toHaveLength(2)
    await t.answer(1, ok)
    expect(t.done).toHaveLength(1)
  })

  it('a second open while one is in flight changes nothing', () => {
    const t = setup()
    t.flow.open(T)
    t.flow.forget()
    t.flow.open({ ...T, run: 'other' })
    expect(t.flow.state()).toMatchObject({ kind: 'forgetting', target: T })
  })
})

describe('errors', () => {
  const words: [string, number, string][] = [
    ['bad request', 400, "The board couldn't read this request. Reload the page, then try again."],
    ['not on the board', 404, "This run's repo is no longer on the board."],
    ['not a run', 404, 'This run is no longer on the board.'],
    ['no claim', 404, "This run's port claim is already gone."],
    ['still listed', 404, 'The board would still list this run without its port claim, so nothing changed.'],
    ['ambiguous repo', 409, "Another repo on the board has the same id, so the board can't tell which run to forget. Nothing changed."],
    ['run is running', 409, 'This run is running again, so the board keeps it. Nothing changed.'],
    ['claim changed', 409, 'The port claim file now names another run, so nothing was deleted.'],
    ['claim unremovable', 500, "The board couldn't delete the port claim file, so the run stays."],
  ]

  it('each route word maps to a sentence', async () => {
    for (const [word, status, sentence] of words) {
      const t = setup()
      t.flow.open(T)
      t.flow.forget()
      await t.answer(0, refused(word, status))
      expect(forgetView(t.flow.state())!.error, word).toBe(sentence)
    }
  })

  it("an unknown word, or the client's own message, shows as is", async () => {
    for (const message of ['HTTP 502', NEED_RELOAD, UNREACHABLE, 'something new']) {
      const t = setup()
      t.flow.open(T)
      t.flow.forget()
      await t.answer(0, refused(message, 0))
      expect(forgetView(t.flow.state())!.error).toBe(message)
    }
  })
})

describe('hashAfterForget', () => {
  const run = (repoId: string, plan?: string): RunSummary => ({ repoId, repo: repoId, ...(plan ? { plan } : {}), where: '', state: 'idle' }) as RunSummary
  const forgotten = run('rw', 'task-scroll')
  const runs = [run('ra', 'one'), forgotten, run('rw', 'alpha'), run('rd')]

  it('the page leaves a forgotten selected run for the next run, even one of the same repo', () => {
    expect(hashAfterForget(runs, forgotten, T)).toBe('#/rw/alpha')
  })

  it('else the run before it, else no run', () => {
    expect(hashAfterForget([run('ra', 'one'), forgotten], forgotten, T)).toBe('#/ra/one')
    expect(hashAfterForget([forgotten], forgotten, T)).toBe('')
  })

  it('stays on another open run', () => {
    expect(hashAfterForget(runs, runs[0], T)).toBeUndefined()
    expect(hashAfterForget(runs, runs[2], T)).toBeUndefined()
  })

  it('the reply goes to the planned run only while the page still shows the forgotten run, the planned one, or none', () => {
    expect(navigateAfterForget(forgotten, T, '#/rw/alpha')).toBe('#/rw/alpha')
    expect(navigateAfterForget(runs[2], T, '#/rw/alpha')).toBe('#/rw/alpha')
    expect(navigateAfterForget(undefined, T, '')).toBe('')
    expect(navigateAfterForget(runs[0], T, '#/rw/alpha')).toBeUndefined()
    expect(navigateAfterForget(forgotten, T, undefined)).toBeUndefined()
  })
})
