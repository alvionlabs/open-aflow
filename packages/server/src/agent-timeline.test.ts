import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board } from '@pod-board/model'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTimelineSource } from './agent-timeline.ts'
import { createBoardService } from './board-service.ts'
import type { GhReader } from './gh.ts'
import { projectDirName } from './transcript-files.ts'

const platform = process.platform
const NOW = Date.parse('2026-10-19T12:00:00Z')
const ts = (min: number) => new Date(NOW - 10 * 60_000 + min * 60_000).toISOString()
const gh: GhReader = { status: () => 'unknown', checkedAt: () => undefined, get: () => undefined, getBranch: () => undefined, refresh: async () => false }

const PROMPT = '- **sprint slug:** board-engineer\n- **slice code:** T1\n- **branch name:** board-engineer-T1\n'

let root: string
let repo: string
let claudeDir: string
let configFile: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pod-board-t1-tl-'))
  repo = join(root, 'repos', 'my-repo')
  claudeDir = join(root, 'claude')
  configFile = join(root, 'config', 'config.json')
  await mkdir(repo, { recursive: true })
  await mkdir(join(root, 'config'))
  await mkdir(join(root, 'ports'))
  await writeFile(configFile, JSON.stringify({ version: 1, repos: [{ path: repo }] }))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const subagents = () => join(claudeDir, 'projects', projectDirName(repo), 'session-1', 'subagents')
const line = (r: unknown) => JSON.stringify(r) + '\n'
const toolUse = (min: number, id: string, name: string, input: Record<string, unknown>) =>
  line({ type: 'assistant', timestamp: ts(min), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })

async function transcript(id: string, agentType: string, body: string): Promise<string> {
  await mkdir(subagents(), { recursive: true })
  await writeFile(join(subagents(), `agent-${id}.meta.json`), JSON.stringify({ agentType, description: `Build ${id}` }))
  const file = join(subagents(), `agent-${id}.jsonl`)
  await writeFile(file, line({ type: 'user', timestamp: ts(0), message: { role: 'user', content: PROMPT } }) + body)
  return file
}

async function setup(): Promise<{ board: Board; source: ReturnType<typeof createTimelineSource> }> {
  const service = createBoardService({ configFile, portsDir: join(root, 'ports'), claudeDir, transcriptDays: 30, platform, gh, now: () => NOW })
  const board = await service.build()
  const source = createTimelineSource({ board: () => board, claudeDir, transcriptDays: 30, now: () => NOW })
  return { board, source }
}

describe('timeline source', () => {
  test('finds only board agents', async () => {
    const file = await transcript('eng1', 'pod:engineer', toolUse(1, 't1', 'Read', { file_path: join(repo, 'src', 'a.ts') }))
    await transcript('other', 'general-purpose', toolUse(1, 't1', 'Read', { file_path: 'x' }))
    const { board, source } = await setup()
    const repoId = board.repos[0]!.id
    expect(board.repos[0]!.agents.map((a) => a.id)).toEqual(['eng1'])

    const t = await source.timeline(repoId, 'eng1')
    expect(t).toMatchObject({ agentId: 'eng1', total: 1, events: [{ tool: 'Read', summary: 'Read src/a.ts' }] })

    // A new line shows up on the next call (read fresh each time).
    await appendFile(file, toolUse(2, 't2', 'Write', { file_path: join(repo, 'b.ts') }))
    expect((await source.timeline(repoId, 'eng1'))?.events.map((e) => e.summary)).toEqual(['Read src/a.ts', 'Write b.ts'])

    expect(await source.timeline('nope', 'eng1')).toBeUndefined()
    expect(await source.timeline(repoId, 'nope')).toBeUndefined()
    expect(await source.timeline(repoId, 'other')).toBeUndefined()
    for (const bad of ['../x', '..\\x', 'a/b', '', 'x'.repeat(65), 'eng1 ']) {
      expect(await source.timeline(repoId, bad), bad).toBeUndefined()
    }

    await rm(file)
    expect(await source.timeline(repoId, 'eng1')).toBeUndefined()
  })

  test('never serves transcript text', async () => {
    // Built at run time so no token-shaped string sits in the source.
    const secret = ['plantedzz', 'fake', String(NOW % 89), 'w'.repeat(6)].join('_')
    const body = [
      line({ type: 'user', timestamp: ts(1), message: { role: 'user', content: `more prompt ${secret}` } }),
      line({
        type: 'assistant',
        timestamp: ts(2),
        message: {
          id: 'm1',
          content: [
            { type: 'text', text: secret },
            { type: 'thinking', thinking: secret },
            { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `API_KEY=${secret} curl -d ${secret} x`, description: secret } },
            { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(repo, 'a.ts'), old_string: secret, new_string: secret } },
            { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: secret } },
            { type: 'tool_use', id: 'f1', name: 'WebFetch', input: { url: `https://${secret}:p@host.example/${secret}` } },
          ],
        },
      }),
      line({ type: 'user', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: secret }] } }),
    ].join('')
    await transcript('eng1', 'pod:engineer', body)
    const { board, source } = await setup()
    const t = await source.timeline(board.repos[0]!.id, 'eng1')
    expect(t?.total).toBe(4)
    expect(JSON.stringify(board)).not.toContain(secret)
    expect(JSON.stringify(t)).not.toContain(secret)
    expect(JSON.stringify(t)).not.toContain('plantedzz')
  })
})
