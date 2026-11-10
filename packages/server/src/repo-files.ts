import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RepoFiles } from '@openaflow/model'

/** Larger files are skipped: a pod doc is never this big, and the board keeps every doc in memory. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024

const SINGLE_FILES = ['pod-docs/README.md', 'pod-docs/handoff-queue.md', 'pod-docs/decisions.md']
const MD_FOLDERS = ['pod-docs/plans', 'pod-docs/plans/archive', 'pod-docs/sprints', 'pod-docs/sprints/archive', 'pod-docs/research']

/**
 * The pod docs `buildRepoModel` needs, keyed by repo-relative path with `/`:
 * the docs README, the handoff queue, the decisions (for a staging merge target),
 * the `.md` files directly in the plan and sprint folders and their `archive/`,
 * and the research reports directly in `pod-docs/research` (for the flow's Research step). Nothing else is read, and every
 * file is opened read-only. A missing repo folder throws; a missing doc or
 * folder is left out, and so is a doc whose real path, after every link on
 * the way (a symlink or junction on the file or a folder above it), is
 * outside the repo's real path. Links that stay inside the repo still work.
 */
export async function readRepoFiles(repoPath: string): Promise<RepoFiles> {
  if (!(await stat(repoPath)).isDirectory()) throw new Error(`not a directory: ${repoPath}`)
  // Resolved once, so a repo registered through a link still reads its own docs.
  const repoReal = await realpath(repoPath)
  const keys = [...SINGLE_FILES]
  for (const folder of MD_FOLDERS) keys.push(...(await mdFilesIn(repoPath, folder)))
  const files: RepoFiles = {}
  for (const key of keys) {
    const text = await readDoc(repoReal, path.join(repoPath, ...key.split('/')))
    if (text !== undefined) files[key] = text
  }
  return files
}

async function mdFilesIn(repoPath: string, folder: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(repoPath, ...folder.split('/')), { withFileTypes: true })
    // Plain files only: a folder or a symlink named `x.md` is left out.
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `${folder}/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

/** Whether `real` is inside `root`, both real paths. `relative` keeps `C:\x-other` out of `C:\x` and ignores case on win32. */
function isInside(root: string, real: string): boolean {
  const rel = path.relative(root, real)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** The file's text, or `undefined` when it is missing, outside the repo, not a plain file, or over the size limit. */
async function readDoc(repoReal: string, file: string): Promise<string | undefined> {
  let handle
  try {
    const real = await realpath(file)
    if (!isInside(repoReal, real)) return undefined
    // The real path is opened, so the checked path is the one read.
    handle = await open(real, 'r')
  } catch {
    return undefined
  }
  try {
    // Size is checked on the open handle, so a file swapped after listing can't slip past it.
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_DOC_BYTES) return undefined
    return await handle.readFile('utf8')
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}
