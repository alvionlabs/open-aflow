import { describe, expect, it } from 'vitest'
import { parseAgentTimeline, type AgentTimeline, type ToolEvent } from './timeline.ts'

// Transcripts are built inline: test/no-io.test.ts scans this folder, so no file reads here.

type Block = Record<string, unknown>

const T0 = Date.parse('2026-10-19T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const ROOT = 'E:\\Projects\\open-aflow'

const assistant = (s: number | undefined, content: Block[], id = `m${s}`) => ({
  type: 'assistant',
  ...(s === undefined ? {} : { timestamp: at(s) }),
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content },
})
const user = (s: number, content: string | Block[]) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content } })
const use = (name: string, input: Block, id?: string): Block => ({ type: 'tool_use', name, input, ...(id === undefined ? {} : { id }) })
const result = (id: string, isError?: boolean, content: unknown = 'output'): Block => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  ...(isError === undefined ? {} : { is_error: isError }),
})

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const parse = (text: string, roots: string[] = [ROOT]) => parseAgentTimeline({ agentId: 'a1', jsonl: text, roots })

/** The summary of one tool call. */
const summary = (name: string, input: Block, roots?: string[]) => parse(jsonl(assistant(1, [use(name, input, 't1')])), roots).events[0]?.summary
const bash = (command: unknown) => summary('Bash', { command })

/** Runs of tool calls, one per record, each with its result. */
function runs(...calls: [name: string, input: Block, failed?: boolean][]): AgentTimeline {
  const records: unknown[] = []
  calls.forEach(([name, input, failed], i) => {
    records.push(assistant(i * 2, [use(name, input, `t${i}`)]))
    if (failed !== undefined) records.push(user(i * 2 + 1, [result(`t${i}`, failed)]))
  })
  return parse(jsonl(...records))
}

describe('events and results', () => {
  it('one event per tool_use id across streamed records; result ok, failed, or absent; no-timestamp blocks skipped', () => {
    const text = jsonl(
      user(0, 'dispatch prompt'),
      // One message streams over three records; the same tool_use block repeats.
      assistant(1, [{ type: 'text', text: 'thinking out loud' }, use('Read', { file_path: `${ROOT}\\a.ts` }, 't1')], 'm1'),
      assistant(2, [use('Read', { file_path: `${ROOT}\\a.ts` }, 't1')], 'm1'),
      assistant(3, [use('Read', { file_path: `${ROOT}\\a.ts` }, 't1'), use('Bash', { command: 'pnpm test' }, 't2')], 'm1'),
      user(4, [result('t1'), result('t2', true)]),
      assistant(5, [use('Write', { file_path: `${ROOT}\\b.ts`, content: 'x' }, 't3')]),
      user(6, [result('t3', false)]),
      assistant(7, [use('Glob', { pattern: '*' }, 't4')]),
      // No timestamp: skipped.
      assistant(undefined, [use('Grep', { pattern: 'x' }, 't5')]),
      assistant(8, [{ type: 'tool_use', name: 'TodoWrite', input: {} }, { type: 'tool_use', name: 'TodoWrite', input: {} }]),
      { type: 'assistant', timestamp: 'not a time', message: { content: [use('Edit', { file_path: 'x' }, 't6')] } },
    )
    const t = parse(text)
    const view = t.events.map(({ tool, summary, result, at: when }) => ({ tool, summary, result, at: when }))
    expect(view).toEqual([
      { tool: 'Read', summary: 'Read a.ts', result: 'ok', at: T0 + 1000 },
      { tool: 'Bash', summary: 'Bash: pnpm test', result: 'failed', at: T0 + 3000 },
      { tool: 'Write', summary: 'Write b.ts', result: 'ok', at: T0 + 5000 },
      { tool: 'Glob', summary: 'Glob', result: undefined, at: T0 + 7000 },
      { tool: 'TodoWrite', summary: 'TodoWrite', result: undefined, at: T0 + 8000 },
      { tool: 'TodoWrite', summary: 'TodoWrite', result: undefined, at: T0 + 8000 },
    ])
    expect(t.total).toBe(6)
    expect(t.agentId).toBe('a1')
    // An absent result is left out of the event, not set to undefined.
    expect(Object.keys(t.events[3]!)).not.toContain('result')
  })

  it('a tool_result before its tool_use, or for an unknown id, sets nothing', () => {
    const t = parse(jsonl(user(0, [result('t1', true), result('zz')]), assistant(1, [use('Read', { file_path: 'a' }, 't1')])))
    expect(t.events.map((e) => e.result)).toEqual([undefined])
  })

  it('events come out oldest first even when the file is out of order', () => {
    const t = parse(jsonl(assistant(5, [use('Read', {}, 'b')]), assistant(2, [use('Write', {}, 'a')])))
    expect(t.events.map((e) => e.tool)).toEqual(['Write', 'Read'])
  })
})

describe('relative paths', () => {
  const read = (p: string, roots?: string[]) => summary('Read', { file_path: p }, roots)

  it('cuts the worktree prefix', () => {
    expect(read('E:\\Projects\\open-aflow\\.claude\\worktrees\\board-engineer-T1\\packages\\model\\src\\x.ts')).toBe(
      'Read packages/model/src/x.ts',
    )
    expect(read('/home/me/other/.claude/worktrees/fix-a/src/y.ts', [])).toBe('Read src/y.ts')
  })

  it('cuts a root in any case, with Windows slashes', () => {
    expect(read('e:/projects/OPEN-AFLOW/pod-docs/plans/x.md')).toBe('Read pod-docs/plans/x.md')
    expect(read('E:\\Projects\\open-aflow\\README.md')).toBe('Read README.md')
    expect(read('/srv/repo/src/a.ts', ['/srv/repo/'])).toBe('Read src/a.ts')
  })

  it('gives the base name outside every root', () => {
    expect(read('C:\\Users\\me\\.ssh\\config')).toBe('Read config')
    expect(read('E:/Projects/open-aflow-other/src/a.ts')).toBe('Read a.ts')
    expect(read('/etc/hosts')).toBe('Read hosts')
    expect(read('relative/dir/file.ts')).toBe('Read file.ts')
  })

  it('cuts a long path to … and the last 59 characters', () => {
    const rest = 'packages/' + 'a'.repeat(40) + '/' + 'b'.repeat(30) + '.ts'
    const out = read(`${ROOT}\\${rest.replaceAll('/', '\\')}`)!
    expect(out).toMatch(/^Read …/)
    const shown = out.slice('Read '.length)
    expect([...shown]).toHaveLength(60)
    expect(shown).toBe('…' + rest.slice(-59))
    const sixty = 'c'.repeat(57) + '.ts'
    expect(read(`${ROOT}/${sixty}`)).toBe(`Read ${sixty}`)
  })
})

describe('tool summaries', () => {
  it('file tools show the path, or the name alone', () => {
    const p = `${ROOT}\\src\\a.ts`
    expect(summary('Read', { file_path: p })).toBe('Read src/a.ts')
    expect(summary('Edit', { file_path: p, old_string: 'a', new_string: 'b' })).toBe('Edit src/a.ts')
    expect(summary('Write', { file_path: p, content: 'x' })).toBe('Write src/a.ts')
    expect(summary('MultiEdit', { file_path: p, edits: [] })).toBe('MultiEdit src/a.ts')
    expect(summary('NotebookEdit', { notebook_path: `${ROOT}\\n.ipynb`, new_source: 'x' })).toBe('NotebookEdit n.ipynb')
    expect(summary('Read', {})).toBe('Read')
    expect(summary('Read', { file_path: 5 })).toBe('Read')
    expect(summary('Read', { file_path: '' })).toBe('Read')
  })

  it('Grep and Glob never show the pattern', () => {
    expect(summary('Grep', { pattern: 'needle' })).toBe('Grep')
    expect(summary('Grep', { pattern: 'needle', path: `${ROOT}\\packages` })).toBe('Grep in packages')
    expect(summary('Glob', { pattern: '**/*.ts' })).toBe('Glob')
    expect(summary('Glob', { pattern: '**/*.ts', path: `${ROOT}/src` })).toBe('Glob in src')
  })

  it('Task, Agent, and Skill show a well-formed name only', () => {
    expect(summary('Task', { subagent_type: 'pod:engineer', prompt: 'p' })).toBe('Task: pod:engineer')
    expect(summary('Agent', { subagent_type: 'Explore' })).toBe('Agent: Explore')
    expect(summary('Agent', { subagent_type: 'has spaces in it' })).toBe('Agent')
    expect(summary('Task', {})).toBe('Task')
    expect(summary('Skill', { skill: 'frontend-design:frontend-design', args: 'x' })).toBe('Skill: frontend-design:frontend-design')
    expect(summary('Skill', { skill: 'x'.repeat(41) })).toBe('Skill')
  })

  it('WebFetch shows the host only', () => {
    expect(summary('WebFetch', { url: 'https://Docs.Example.com:8443/a/b?q=1#h', prompt: 'p' })).toBe('WebFetch docs.example.com')
    expect(summary('WebFetch', { url: 'not a url' })).toBe('WebFetch')
    expect(summary('WebFetch', { url: 'http://[::1]/x' })).toBe('WebFetch')
    expect(summary('WebFetch', {})).toBe('WebFetch')
  })

  it('Hand-back, MCP, and odd names', () => {
    expect(summary('SubagentHandback', { message: 'report' })).toBe('Hand-back')
    expect(summary('TodoWrite', { todos: [] })).toBe('TodoWrite')
    expect(summary('WebSearch', { query: 'q' })).toBe('WebSearch')
    expect(summary('mcp__claude_ai_Claude_Docs__batch', {})).toBe('mcp__claude_ai_Claude_Docs__batch')
    expect(summary('a tool with spaces', {})).toBe('tool')
    expect(summary('x'.repeat(65), {})).toBe('tool')
    const odd = parse(jsonl(assistant(1, [{ type: 'tool_use', id: 'q', name: 7, input: {} }]))).events[0]
    expect(odd).toMatchObject({ tool: 'tool', summary: 'tool' })
    const spaced = parse(jsonl(assistant(1, [use('bad name', {}, 'q')]))).events[0]
    expect(spaced?.tool).toBe('tool')
  })
})

describe('shell summaries', () => {
  it('shows the program and a known subcommand', () => {
    expect(bash('pnpm test')).toBe('Bash: pnpm test')
    expect(bash('pnpm --filter @open-aflow/server test')).toBe('Bash: pnpm test')
    expect(bash('git status')).toBe('Bash: git status')
    expect(bash('ls -la')).toBe('Bash: ls')
    expect(bash('C:\\tools\\Git.EXE log --oneline')).toBe('Bash: git log')
    expect(bash('./node_modules/.bin/vitest run')).toBe('Bash: vitest run')
    expect(summary('PowerShell', { command: "$env:OPEN_AFLOW_API_PORT='3010'; pnpm dev" })).toBe('PowerShell: pnpm dev')
  })

  it('looks for the subcommand in the next four tokens only', () => {
    expect(bash('pnpm -a -b -c -d test')).toBe('Bash: pnpm')
    expect(bash('pnpm -a -b -c test')).toBe('Bash: pnpm test')
  })

  it('skips env tokens and hides unknown programs', () => {
    expect(bash('FOO=1 BAR=2 pnpm build')).toBe('Bash: pnpm build')
    expect(bash('python3 script.py')).toBe('Bash: command')
    expect(bash('FOO=1')).toBe('Bash')
  })

  it('splits on && || ; | and newlines, three segments then …', () => {
    expect(bash('cd x && pnpm install || echo no')).toBe('Bash: cd · pnpm install · echo')
    expect(bash('git add . ; git commit -m "msg" | cat\nnode x.js')).toBe('Bash: git add · git commit · cat …')
    expect(bash('  &&  ; ')).toBe('Bash')
  })

  it('never shows quoted arguments', () => {
    expect(bash('git commit -m "fix: secret stuff"')).toBe('Bash: git commit')
    expect(bash(`echo 'hello world' "a && b"`)).toBe('Bash: echo · command')
  })

  it('only programs that take subcommands show one', () => {
    expect(bash('echo test')).toBe('Bash: echo')
    expect(bash('grep -r test src')).toBe('Bash: grep')
    expect(bash('ls test')).toBe('Bash: ls')
    expect(bash('cat test.md')).toBe('Bash: cat')
    expect(bash('mkdir -p build')).toBe('Bash: mkdir')
    expect(bash('node scripts/run.js test')).toBe('Bash: node')
  })

  it('each program shows only its own subcommands', () => {
    expect(bash('git -C test status')).toBe('Bash: git status')
    expect(bash('gh run view 12')).toBe('Bash: gh run')
    expect(bash('agent-browser --session pod-x open http://x')).toBe('Bash: agent-browser open')
    expect(bash('cargo test --release')).toBe('Bash: cargo test')
    expect(bash('go test ./...')).toBe('Bash: go test')
    expect(bash('corepack enable pnpm')).toBe('Bash: corepack enable')
  })

  it('names the test runner after exec, dlx, npx, and bunx', () => {
    expect(bash('pnpm exec vitest run')).toBe('Bash: pnpm exec vitest')
    expect(bash('pnpm --filter x exec vitest')).toBe('Bash: pnpm exec vitest')
    expect(bash('pnpm dlx jest')).toBe('Bash: pnpm dlx jest')
    expect(bash('npx --yes jest --ci')).toBe('Bash: npx jest')
    expect(bash('npx ./node_modules/.bin/vitest')).toBe('Bash: npx vitest')
    expect(bash('bunx vitest')).toBe('Bash: bunx vitest')
    expect(bash('npx tsc --noEmit')).toBe('Bash: npx tsc')
    expect(bash('npx cowsay test')).toBe('Bash: npx')
    expect(bash('pnpm exec')).toBe('Bash: pnpm exec')
  })

  it('names a known script after run', () => {
    expect(bash('npm run test')).toBe('Bash: npm run test')
    expect(bash('pnpm --filter x run build')).toBe('Bash: pnpm run build')
    expect(bash('npm run -s typecheck')).toBe('Bash: npm run typecheck')
    expect(bash('npm run my-script test')).toBe('Bash: npm run')
  })

  it('a command that is not a string gives the name alone', () => {
    expect(bash(undefined)).toBe('Bash')
    expect(bash(['pnpm', 'test'])).toBe('Bash')
  })
})

describe('never keeps transcript text', () => {
  it('a planted fake secret appears nowhere in the result', () => {
    // Built at run time so no token-shaped string sits in the source.
    const secret = ['plantedzz', 'fake', String(T0 % 97), 'q'.repeat(6)].join('_')
    const text = jsonl(
      user(0, `dispatch prompt ${secret}`),
      assistant(1, [
        { type: 'text', text: `assistant says ${secret}` },
        { type: 'thinking', thinking: `thinking ${secret}` },
        use('Bash', { command: `curl -H "Authorization: Bearer ${secret}" https://x.example`, description: secret }, 'b1'),
        use('Bash', { command: `TOKEN=${secret} pnpm test` }, 'b2'),
        use('Bash', { command: `${secret} --run` }, 'b3'),
        use('PowerShell', { command: `$env:K='${secret}'; ${secret}.exe test` }, 'b4'),
        use('Bash', { command: `npx ${secret} && pnpm exec ${secret} && npm run ${secret}` }, 'b5'),
        use('Edit', { file_path: `${ROOT}\\a.ts`, old_string: secret, new_string: secret }, 'e1'),
        use('MultiEdit', { file_path: `${ROOT}\\a.ts`, edits: [{ old_string: secret, new_string: secret }] }, 'e2'),
        use('Write', { file_path: `${ROOT}\\b.ts`, content: secret }, 'w1'),
        use('Grep', { pattern: secret, glob: secret }, 'g1'),
        use('Glob', { pattern: secret }, 'g2'),
        use('WebFetch', { url: `https://user:${secret}@host.example/${secret}?k=${secret}#${secret}`, prompt: secret }, 'f1'),
        use('Task', { subagent_type: 'Explore', prompt: secret, description: secret }, 'k1'),
        use('Skill', { skill: 'tdd', args: secret }, 's1'),
        use('WebSearch', { query: secret }, 'q1'),
        use('SubagentHandback', { message: secret }, 'h1'),
      ]),
      user(2, [result('b1', false, secret), result('b2', true, [{ type: 'text', text: secret }]), result('e1', false, secret)]),
      { type: 'system', timestamp: at(3), content: secret },
    )
    const t = parse(text)
    expect(t.total).toBe(15)
    expect(JSON.stringify(t)).not.toContain(secret)
    expect(JSON.stringify(t)).not.toContain('plantedzz')
  })
})

describe('test progress', () => {
  const T = `${ROOT}\\src\\a.test.ts`
  const C = `${ROOT}\\src\\a.ts`

  it('counts runs, failed runs, the last result, and test files; test first', () => {
    const t = runs(
      ['Write', { file_path: `${ROOT}\\README.md` }],
      ['Write', { file_path: T }],
      ['Edit', { file_path: T }],
      ['Edit', { file_path: `${ROOT}\\src\\__tests__\\b.ts` }],
      ['MultiEdit', { file_path: `${ROOT}\\src\\c.spec.tsx` }],
      ['Read', { file_path: `${ROOT}\\src\\d.test.ts` }],
      ['Bash', { command: 'pnpm vitest run' }, true],
      ['Write', { file_path: C }],
      ['Bash', { command: 'pnpm --filter x test' }, false],
      ['Bash', { command: 'pnpm verify' }],
      ['Bash', { command: 'git status' }, true],
      ['PowerShell', { command: 'jest --ci' }, false],
    )
    expect(t.tests).toEqual({ testFiles: 3, runs: 3, failedRuns: 1, last: 'pass', testFirst: true })
  })

  it('counts only real test runs, not commands that merely say test', () => {
    const t = runs(
      ['Bash', { command: 'pnpm test' }, false],
      ['Bash', { command: 'echo test' }, false],
      ['Bash', { command: 'grep -r test src' }, false],
      ['Bash', { command: 'ls test' }, false],
    )
    expect(t.tests.runs).toBe(1)
    const more = runs(
      ['Bash', { command: 'cat test.md' }, false],
      ['Bash', { command: 'git -C test status' }, false],
      ['Bash', { command: 'git checkout test' }, false],
      ['Bash', { command: 'gh pr view test' }, false],
      ['Bash', { command: 'npx cowsay test' }, false],
      ['Bash', { command: 'pnpm run build' }, false],
      ['Bash', { command: 'pnpm exec tsc' }, false],
    )
    expect(more.tests.runs).toBe(0)
  })

  it('counts a test runner after exec, dlx, npx, bunx, or a test script after run', () => {
    const t = runs(
      ['Bash', { command: 'pnpm exec vitest run' }, false],
      ['Bash', { command: 'npx jest' }, true],
      ['Bash', { command: 'pnpm dlx vitest' }, false],
      ['Bash', { command: 'bunx vitest' }, false],
      ['Bash', { command: 'npm run test' }, false],
      ['Bash', { command: 'yarn run verify' }, false],
      ['Bash', { command: 'cargo test' }, false],
      ['Bash', { command: 'go test ./...' }, false],
    )
    expect(t.tests).toMatchObject({ runs: 8, failedRuns: 1, last: 'pass' })
  })

  it('last is fail when the latest finished run failed', () => {
    const t = runs(['Bash', { command: 'vitest' }, false], ['Bash', { command: 'pnpm test' }, true], ['Bash', { command: 'pnpm test' }])
    expect(t.tests).toEqual({ testFiles: 0, runs: 2, failedRuns: 1, last: 'fail' })
  })

  it('testFirst is false when a code file was edited first', () => {
    const t = runs(['Write', { file_path: `${ROOT}\\pkg.json` }], ['Edit', { file_path: C }], ['Write', { file_path: T }])
    expect(t.tests).toEqual({ testFiles: 1, runs: 0, failedRuns: 0, testFirst: false })
  })

  it('testFirst is absent with no test-file edit; config and doc files are not code', () => {
    expect(runs(['Edit', { file_path: C }]).tests).toEqual({ testFiles: 0, runs: 0, failedRuns: 0 })
    const docs = runs(
      ...['a.md', 'b.json', 'c.yaml', 'd.yml', 'pnpm.lock', 'E.MD'].map((f): [string, Block] => ['Edit', { file_path: `${ROOT}\\${f}` }]),
      ['Write', { file_path: T }],
    )
    expect(docs.tests.testFirst).toBe(true)
  })

  it('a test-looking name without a JS or TS extension is not a test file', () => {
    expect(runs(['Write', { file_path: `${ROOT}\\a.test.md` }], ['Write', { file_path: `${ROOT}\\a.test.py` }]).tests.testFiles).toBe(0)
    expect(runs(['Write', { file_path: `${ROOT}\\a.test.mjs` }]).tests.testFiles).toBe(1)
  })
})

describe('limits and bad input', () => {
  it('400 events keep the newest 300 with total 400', () => {
    const records = Array.from({ length: 400 }, (_, i) => assistant(i, [use('Read', { file_path: `${ROOT}\\f${i}.ts` }, `t${i}`)]))
    const t = parse(jsonl(...records))
    expect(t.total).toBe(400)
    expect(t.events).toHaveLength(300)
    expect(t.events[0]!.summary).toBe('Read f100.ts')
    expect(t.events.at(-1)!.summary).toBe('Read f399.ts')
  })

  it('bad and partial lines never throw', () => {
    const good = JSON.stringify(assistant(1, [use('Read', {}, 'a')]))
    const text = [
      '{ nope',
      'null',
      '5',
      '"str"',
      '[]',
      JSON.stringify({ type: 'assistant', timestamp: at(1), message: null }),
      JSON.stringify({ type: 'assistant', timestamp: at(1), message: { content: 'text' } }),
      JSON.stringify({ type: 'assistant', timestamp: at(1), message: { content: [null, 5, 'x', { type: 'tool_use' }] } }),
      JSON.stringify({ type: 'user', timestamp: at(1), message: { content: [null, { type: 'tool_result' }] } }),
      good + '\r',
      good.slice(0, 30),
    ].join('\n')
    let t: AgentTimeline | undefined
    expect(() => (t = parse(text))).not.toThrow()
    expect(t!.events.map((e: ToolEvent) => e.tool)).toEqual(['tool', 'Read'])
    expect(() => parseAgentTimeline({ agentId: 'x', jsonl: '', roots: [] })).not.toThrow()
    expect(parseAgentTimeline({ agentId: 'x', jsonl: '', roots: [] })).toEqual({
      agentId: 'x',
      events: [],
      total: 0,
      tests: { testFiles: 0, runs: 0, failedRuns: 0 },
    })
    expect(() => parseAgentTimeline({ agentId: 'x', jsonl: 5 as unknown as string, roots: [null as unknown as string] })).not.toThrow()
  })
})
