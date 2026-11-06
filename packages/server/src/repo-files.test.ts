import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_DOC_BYTES, readRepoFiles } from './repo-files.ts'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'open-aflow-d1-repo-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function put(rel: string, text: string | Buffer): Promise<void> {
  const full = join(repo, ...rel.split('/'))
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, text)
}

describe('reads only pod docs', () => {
  test('reads the listed files with "/" keys and leaves the rest out', async () => {
    const wanted = [
      'pod-docs/README.md',
      'pod-docs/handoff-queue.md',
      'pod-docs/plans/board-read.md',
      'pod-docs/plans/archive/old-plan.md',
      'pod-docs/sprints/server-runs.md',
      'pod-docs/sprints/archive/bootstrap-model.md',
      // The decisions (for the staging merge target) and the research reports (for the flow's Research step).
      'pod-docs/decisions.md',
      'pod-docs/research/folder-picker.md',
    ]
    for (const rel of wanted) await put(rel, `# ${rel}\n`)

    const unwanted = [
      'README.md',
      'pod-docs/features.md',
      'pod-docs/codebase-structure.md',
      'pod-docs/known-issues/x.md',
      'pod-docs/plans/notes.txt',
      'pod-docs/plans/draft.MD.bak',
      'pod-docs/plans/deep/inner.md',
      'pod-docs/plans/archive/deeper/inner.md',
      'pod-docs/sprints/archive/2025/x.md',
      'pod-docs/sprints/x.markdown',
      'docs/plans/x.md',
      'pod-docs/research/folder-picker.html',
      'pod-docs/research/archive/old.md',
    ]
    for (const rel of unwanted) await put(rel, 'nope')
    // A folder named like a doc is not a doc.
    await mkdir(join(repo, 'pod-docs', 'sprints', 'folder.md'))

    const files = await readRepoFiles(repo)
    expect(Object.keys(files).sort()).toEqual([...wanted].sort())
    for (const rel of wanted) expect(files[rel]).toBe(`# ${rel}\n`)
  })

  test('over-size files are left out; a file at the limit is read', async () => {
    await put('pod-docs/README.md', '# readme\n')
    await put('pod-docs/plans/at-limit.md', Buffer.alloc(MAX_DOC_BYTES, 'a'))
    await put('pod-docs/sprints/too-big.md', Buffer.alloc(MAX_DOC_BYTES + 1, 'a'))
    expect(MAX_DOC_BYTES).toBe(5 * 1024 * 1024)
    const files = await readRepoFiles(repo)
    expect(Object.keys(files).sort()).toEqual(['pod-docs/README.md', 'pod-docs/plans/at-limit.md'])
    expect(files['pod-docs/plans/at-limit.md']).toHaveLength(MAX_DOC_BYTES)
  })

  test('a repo without pod-docs gives {} and a missing repo throws', async () => {
    expect(await readRepoFiles(repo)).toEqual({})
    await put('pod-docs/plans/a.md', 'a')
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/plans/a.md': 'a' })
    await expect(readRepoFiles(join(repo, 'gone'))).rejects.toThrow()
  })

  test('reading leaves every file and folder as it was', async () => {
    await put('pod-docs/README.md', '# readme\n')
    await put('pod-docs/plans/a.md', 'a')
    const before = await Promise.all(['pod-docs', 'pod-docs/README.md', 'pod-docs/plans/a.md'].map((r) => stat(join(repo, r))))
    await readRepoFiles(repo)
    const after = await Promise.all(['pod-docs', 'pod-docs/README.md', 'pod-docs/plans/a.md'].map((r) => stat(join(repo, r))))
    expect(after.map((s) => [s.mtimeMs, s.size])).toEqual(before.map((s) => [s.mtimeMs, s.size]))
  })
})

describe('links that point outside the repo', () => {
  let outside: string

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'open-aflow-d1-outside-'))
  })

  afterEach(async () => {
    // `rm` doesn't follow links, so a junction left in `repo` never empties `outside`.
    await rm(outside, { recursive: true, force: true })
  })

  async function putOutside(rel: string, text: string): Promise<string> {
    const full = join(outside, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, text)
    return full
  }

  /** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
  async function linkFolder(target: string, rel: string): Promise<void> {
    const at = join(repo, ...rel.split('/'))
    await mkdir(join(at, '..'), { recursive: true })
    await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  }

  /** A file symlink, or false when this machine won't make one (Windows without admin rights or developer mode). */
  async function linkFile(target: string, rel: string): Promise<boolean> {
    const at = join(repo, ...rel.split('/'))
    await mkdir(join(at, '..'), { recursive: true })
    try {
      await symlink(target, at, 'file')
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
      throw err
    }
  }

  test('a linked pod-docs/ folder pointing outside: its docs are skipped', async () => {
    await putOutside('docs/README.md', 'secret readme')
    await putOutside('docs/handoff-queue.md', 'secret queue')
    await putOutside('docs/plans/x.md', 'secret plan')
    await linkFolder(join(outside, 'docs'), 'pod-docs')
    expect(await readRepoFiles(repo)).toEqual({})
  })

  test('a linked plans/ or archive/ folder pointing outside: its docs are skipped, the rest read', async () => {
    await put('pod-docs/README.md', '# readme\n')
    await putOutside('plans/x.md', 'secret plan')
    await putOutside('archive/y.md', 'secret sprint')
    await linkFolder(join(outside, 'plans'), 'pod-docs/plans')
    await linkFolder(join(outside, 'archive'), 'pod-docs/sprints/archive')
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/README.md': '# readme\n' })
  })

  test('a linked research/ folder pointing outside: its reports are skipped', async () => {
    await put('pod-docs/README.md', '# readme\n')
    const outside = await mkdtemp(join(tmpdir(), 'open-aflow-research-out-'))
    try {
      await writeFile(join(outside, 'secret.md'), 'outside')
      await mkdir(join(repo, 'pod-docs'), { recursive: true })
      await symlink(outside, join(repo, 'pod-docs', 'research'), 'junction')
      const files = await readRepoFiles(repo)
      expect(Object.keys(files)).toEqual(['pod-docs/README.md'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a linked doc file pointing outside is skipped', async (ctx) => {
    const target = await putOutside('secret.md', 'secret')
    if (!(await linkFile(target, 'pod-docs/README.md'))) {
      ctx.skip('this machine cannot make file symlinks (Windows without admin rights or developer mode)')
    }
    await linkFile(target, 'pod-docs/handoff-queue.md')
    expect(await readRepoFiles(repo)).toEqual({})
  })

  test('a folder linked to another place inside the repo is still read', async () => {
    await put('shared-plans/x.md', 'inside plan')
    await linkFolder(join(repo, 'shared-plans'), 'pod-docs/plans')
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/plans/x.md': 'inside plan' })
  })

  test('a doc file linked to another place inside the repo is still read', async (ctx) => {
    await put('docs/readme-source.md', 'inside readme')
    if (!(await linkFile(join(repo, 'docs', 'readme-source.md'), 'pod-docs/README.md'))) {
      ctx.skip('this machine cannot make file symlinks (Windows without admin rights or developer mode)')
    }
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/README.md': 'inside readme' })
  })

  test('a repo reached through a link still reads its own docs', async () => {
    await put('pod-docs/README.md', '# readme\n')
    const via = join(outside, 'via')
    await symlink(repo, via, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await readRepoFiles(via)).toEqual({ 'pod-docs/README.md': '# readme\n' })
  })

  test('a sibling folder whose name starts with the repo name counts as outside', async () => {
    // `C:\x` vs `C:\x-other`: a plain prefix check would let this through.
    const sibling = `${repo}-other`
    await mkdir(join(sibling, 'plans'), { recursive: true })
    await writeFile(join(sibling, 'plans', 'x.md'), 'sibling plan')
    try {
      await linkFolder(join(sibling, 'plans'), 'pod-docs/plans')
      expect(await readRepoFiles(repo)).toEqual({})
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })
})
