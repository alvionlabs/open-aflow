import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEED_RELOAD, RESTARTED, UNREACHABLE } from '../../actions-client.ts'
import { ACTION_LIMIT_MS, createSetupGate, GATE_LIMIT_MS, readTools } from './setup-client.ts'
import type { ToolState } from './setup-view.ts'

const git: ToolState = { tool: 'git', state: 'found', path: 'C:\\Git\\git.exe', source: 'path' }
const gh: ToolState = { tool: 'gh', state: 'found', path: 'C:\\gh\\gh.exe', source: 'path' }
const claude: ToolState = { tool: 'claude', state: 'found', path: 'C:\\c\\claude.exe', source: 'path' }
const noClaude: ToolState = { tool: 'claude', state: 'missing' }
const token = () => 'tok-1'
const answer = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
const never = () => new Promise<Response>(() => {})
const firstMissing = () => vi.fn<typeof fetch>(async () => answer({ tools: [git, gh, noClaude] }))

/** A gate that has had its first answer. */
async function opened(fetchFn: typeof fetch) {
  const gate = createSetupGate({ fetch: fetchFn, token })
  gate.start()
  await vi.waitFor(() => expect(gate.state().view).not.toBe('checking'))
  return gate
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the gate', () => {
  it('a missing tool opens the setup check', async () => {
    const fetchFn = firstMissing()
    const gate = await opened(fetchFn)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('/api/tools')
    expect((init?.headers as Record<string, string>)['X-Open-AFlow-Token']).toBe('tok-1')
    const state = gate.state()
    expect(state.view).toBe('setup')
    expect(state.view === 'setup' && state.setup.tools).toEqual([git, gh, noClaude])
  })

  it('all found opens the board', async () => {
    const gate = await opened(async () => answer({ tools: [git, gh, claude] }))
    expect(gate.state()).toEqual({ view: 'board' })
  })

  it('no answer never blocks the board', async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => answer({ error: 'not found' }, 404),
      async () => answer({ error: 'bad token' }, 403),
      async () => answer({ error: 'boom' }, 500),
      async () => answer('not json'),
      async () => answer({ other: 1 }),
      async () => {
        throw new TypeError('network')
      },
    ]
    for (const reply of answers) {
      const gate = await opened(reply)
      expect(gate.state()).toEqual({ view: 'board' })
    }

    // No token on the page: nothing is sent.
    for (const none of [() => null, () => undefined, () => '']) {
      const fetchFn = firstMissing()
      const gate = createSetupGate({ fetch: fetchFn, token: none })
      gate.start()
      await vi.waitFor(() => expect(gate.state()).toEqual({ view: 'board' }))
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })

  it('a slow answer opens the board', async () => {
    vi.useFakeTimers()
    const gate = createSetupGate({ fetch: never, token })
    gate.start()
    await vi.advanceTimersByTimeAsync(GATE_LIMIT_MS - 1)
    expect(gate.state().view).toBe('checking')
    await vi.advanceTimersByTimeAsync(1)
    expect(GATE_LIMIT_MS).toBe(5000)
    expect(gate.state()).toEqual({ view: 'board' })
  })

  it('a slow body opens the board too', async () => {
    vi.useFakeTimers()
    const stuck = { ok: true, status: 200, text: () => new Promise<string>(() => {}) } as unknown as Response
    const gate = createSetupGate({ fetch: async () => stuck, token })
    gate.start()
    await vi.advanceTimersByTimeAsync(GATE_LIMIT_MS)
    expect(gate.state()).toEqual({ view: 'board' })
  })

  it('an answer after the limit changes nothing', async () => {
    vi.useFakeTimers()
    let reply!: (r: Response) => void
    const gate = createSetupGate({ fetch: () => new Promise<Response>((res) => (reply = res)), token })
    gate.start()
    await vi.advanceTimersByTimeAsync(GATE_LIMIT_MS)
    reply(answer({ tools: [git, gh, noClaude] }))
    await vi.advanceTimersByTimeAsync(10)
    expect(gate.state()).toEqual({ view: 'board' })
  })

  it('the board waits for the gate', async () => {
    let reply!: (r: Response) => void
    const gate = createSetupGate({ fetch: () => new Promise<Response>((res) => (reply = res)), token })
    expect(gate.state()).toEqual({ view: 'checking' })
    const seen: string[] = []
    gate.subscribe(() => seen.push(gate.state().view))
    gate.start()
    expect(gate.state()).toEqual({ view: 'checking' })
    reply(answer({ tools: [git, gh, noClaude] }))
    await vi.waitFor(() => expect(gate.state().view).toBe('setup'))
    expect(seen).toEqual(['setup'])

    let reply2!: (r: Response) => void
    const second = createSetupGate({ fetch: () => new Promise<Response>((res) => (reply2 = res)), token })
    second.start()
    expect(second.state().view).toBe('checking')
    reply2(answer({ tools: [git, gh, claude] }))
    await vi.waitFor(() => expect(second.state().view).toBe('board'))
  })

  it('a second start asks once', async () => {
    const fetchFn = firstMissing()
    const gate = createSetupGate({ fetch: fetchFn, token })
    gate.start()
    gate.start()
    await vi.waitFor(() => expect(gate.state().view).toBe('setup'))
    gate.start()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('Recheck', () => {
  it('all found moves to the board', async () => {
    const fetchFn = firstMissing()
    const gate = await opened(fetchFn)
    fetchFn.mockImplementation(async () => answer({ tools: [git, gh, claude] }))
    await gate.recheck()
    expect(fetchFn.mock.calls[1]![0]).toBe('/api/tools')
    expect(gate.state()).toEqual({ view: 'board' })
  })

  it('a failed Recheck keeps the rows, even on the answers that open the board on load', async () => {
    for (const reply of [
      async () => answer({ error: 'not found' }, 404),
      async () => answer('not json'),
      async () => {
        throw new TypeError('network')
      },
    ]) {
      const fetchFn = firstMissing()
      const gate = await opened(fetchFn)
      fetchFn.mockImplementation(reply)
      await gate.recheck()
      const state = gate.state()
      expect(state.view).toBe('setup')
      expect(state.view === 'setup' && state.setup.tools).toEqual([git, gh, noClaude])
      expect(state.view === 'setup' && state.setup.recheckError).toContain('Recheck failed')
      expect(state.view === 'setup' && state.setup.busy).toBe(false)
    }
  })

  it('a hung Recheck fails at its limit, which is above two registry reads', async () => {
    vi.useFakeTimers()
    const fetchFn = firstMissing()
    const gate = createSetupGate({ fetch: fetchFn, token })
    gate.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.state().view).toBe('setup')

    fetchFn.mockImplementation(never)
    const done = gate.recheck()
    await vi.advanceTimersByTimeAsync(ACTION_LIMIT_MS - 1)
    const during = gate.state()
    expect(during.view === 'setup' && during.setup.busy).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(ACTION_LIMIT_MS).toBeGreaterThan(10_000)
    const state = gate.state()
    expect(state.view === 'setup' && state.setup.recheckError).toContain(UNREACHABLE)
    expect(state.view === 'setup' && state.setup.busy).toBe(false)
  })

  it('ignores a press while another one runs', async () => {
    let reply!: (r: Response) => void
    const fetchFn = firstMissing()
    const gate = await opened(fetchFn)
    fetchFn.mockImplementation(() => new Promise<Response>((res) => (reply = res)))
    const first = gate.recheck()
    await gate.recheck()
    await gate.save('claude', 'C:\\c\\claude.exe')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    reply(answer({ tools: [git, gh, claude] }))
    await first
    expect(gate.state()).toEqual({ view: 'board' })
  })
})

describe('saving', () => {
  it('posts the path to the action route with the token, and moves to the board', async () => {
    const fetchFn = firstMissing()
    const gate = await opened(fetchFn)
    fetchFn.mockImplementation(async () => answer({ tools: [git, gh, claude] }))
    await gate.save('claude', '"C:\\c\\claude.exe"')
    const [url, init] = fetchFn.mock.calls[1]!
    expect(url).toBe('/api/actions/tool-path')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['X-Open-AFlow-Token']).toBe('tok-1')
    expect(JSON.parse(init?.body as string)).toEqual({ tool: 'claude', path: 'C:\\c\\claude.exe' })
    expect(gate.state()).toEqual({ view: 'board' })
  })

  it('an empty field posts null', async () => {
    const fetchFn = firstMissing()
    const gate = await opened(fetchFn)
    await gate.save('claude', '  ')
    expect(JSON.parse(fetchFn.mock.calls[1]![1]?.body as string)).toEqual({ tool: 'claude', path: null })
  })

  it('a refusal lands on its row; a dead token says to reload', async () => {
    const fetchFn = firstMissing()
    const gate = await opened(fetchFn)
    fetchFn.mockImplementation(async () => answer({ error: 'not a file' }, 400))
    await gate.save('claude', 'C:\\folder')
    let state = gate.state()
    expect(state.view === 'setup' && state.setup.rowErrors.claude).toBe('not a file')
    expect(state.view === 'setup' && state.setup.busy).toBe(false)

    fetchFn.mockImplementation(async () => answer({ error: 'bad token' }, 403))
    await gate.save('claude', 'C:\\c\\claude.exe')
    state = gate.state()
    expect(state.view === 'setup' && state.setup.rowErrors.claude).toBe(RESTARTED)
  })

  it('a hung save fails at its limit, on the row', async () => {
    vi.useFakeTimers()
    const fetchFn = firstMissing()
    const gate = createSetupGate({ fetch: fetchFn, token })
    gate.start()
    await vi.advanceTimersByTimeAsync(0)
    fetchFn.mockImplementation(never)
    const done = gate.save('claude', 'C:\\c\\claude.exe')
    await vi.advanceTimersByTimeAsync(ACTION_LIMIT_MS)
    await done
    const state = gate.state()
    expect(state.view === 'setup' && state.setup.rowErrors.claude).toBe(UNREACHABLE)
  })
})

describe('readTools', () => {
  it('says why it failed', async () => {
    expect(await readTools({ fetch: never, token: () => null })).toEqual({ ok: false, message: NEED_RELOAD })
    expect(await readTools({ fetch: async () => answer({ error: 'bad token' }, 403), token })).toEqual({ ok: false, message: RESTARTED })
    expect(await readTools({ fetch: async () => answer({ error: 'boom' }, 500), token })).toEqual({ ok: false, message: 'boom' })
    expect(await readTools({ fetch: async () => answer('', 404), token })).toEqual({ ok: false, message: 'HTTP 404' })
  })
})
