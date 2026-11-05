// Builds the Board: every registered repo plus every repo a port claim names,
// each with its run model, its pod agents, its live PRs, and its claims.
// Reads only; the one file the board writes is its config (repos-config.ts).
// The rules and why are in pod-docs/feature-details/server.md.

import path from 'node:path'
import {
  buildRepoModel,
  fixRunNames,
  handBackPr,
  parseAgentTranscript,
  stagingBranches,
  stagingPrOf,
  type ActionEntry,
  type AutoToggle,
  type AgentRun,
  type Board,
  type BoardRepo,
  type Claim,
  type GhRead,
  type PrStatus,
  type RepoModel,
  repoPathKey,
} from '@pod-board/model'
import { readClaims } from './claims.ts'
import type { GhReader } from './gh.ts'
import { ignoresCase as probeIgnoresCase, normalizeRepoPath, repoIds, sameRepoPath } from './guard.ts'
import { readRepoFiles } from './repo-files.ts'
import { loadRepos } from './repos-config.ts'
import { agentOfRepo, createAgentFileCache, createClaimedSessionScan, createSessionCwdCache, fixClaimNames, listAgentFiles, sessionFileOf, type AgentFile } from './transcript-files.ts'

export type BoardServiceDeps = {
  configFile: string
  portsDir: string
  claudeDir: string
  transcriptDays: number
  platform: NodeJS.Platform
  gh: GhReader
  now?: () => number
  ignoresCase?: (dir: string) => Promise<boolean>
  /** The action log's newest entries, read on every build. No dep, no `actions` on the Board. */
  actions?: () => ActionEntry[]
  /** The auto-continue toggles, read on every build. No dep, no `autoContinue` on the Board. */
  autoContinue?: () => AutoToggle[]
}

export type BoardService = {
  /** Reads every repo's files now. Uses gh's cached PRs; never waits on gh. */
  build(): Promise<Board>
  /** Asks gh about each readable repo's live PRs. `true` when anything gh knows changed. */
  refreshGh(board: Board): Promise<boolean>
}

type RepoEntry = { path: string; caseless: boolean; registered: boolean; claims: Claim[] }

export function createBoardService(deps: BoardServiceDeps): BoardService {
  const now = deps.now ?? Date.now
  const ignoresCase = deps.ignoresCase ?? probeIgnoresCase
  // Each transcript's AgentRun (or undefined for a non-pod agent), never its text.
  const agentRuns = createAgentFileCache((text) => parseAgentTranscript(text))
  // Which folder each session started in, from the head of its own file: its agents are placed by it.
  const sessionCwds = createSessionCwdCache()
  // An unreadable config (a half-saved edit, say) keeps the last list it read.
  let lastRegistered: string[] = []

  /** The registered paths, and whether the config file exists but couldn't be read this time. */
  async function registered(): Promise<{ paths: string[]; unreadable: boolean }> {
    const loaded = await loadRepos(deps.configFile)
    if ('repos' in loaded) lastRegistered = loaded.repos
    return { paths: lastRegistered, unreadable: 'error' in loaded }
  }

  async function safeClaims(): Promise<Claim[]> {
    try {
      return await readClaims(deps.portsDir)
    } catch {
      return []
    }
  }

  /** Registered paths then claimed ones, merged by Repo identity. The first spelling of a repo wins. */
  async function repoEntries(): Promise<{ entries: RepoEntry[]; configUnreadable: boolean }> {
    const entries: RepoEntry[] = []
    const find = async (raw: string): Promise<RepoEntry> => {
      const p = normalizeRepoPath(raw, deps.platform)
      const hit = entries.find((e) => sameRepoPath(e.path, p, deps.platform, e.caseless))
      if (hit) return hit
      const entry: RepoEntry = { path: p, caseless: await ignoresCase(p), registered: false, claims: [] }
      entries.push(entry)
      return entry
    }
    const config = await registered()
    for (const p of config.paths) (await find(p)).registered = true
    for (const c of await safeClaims()) {
      const entry = await find(c.repoPath)
      entry.claims.push({ ...c, repoPath: entry.path })
    }
    return { entries, configUnreadable: config.unreadable }
  }

  const claimedSessions = createClaimedSessionScan()

  /** The repo's pod agents. Adds its listed files to `listed`, so the build keeps their cache. */
  async function agentsOf(entry: RepoEntry, listed: AgentFile[], sessionFiles: string[]): Promise<AgentRun[]> {
    const files = await listAgentFiles(deps.claudeDir, entry.path, deps.transcriptDays, now(), { names: fixClaimNames(entry.claims), scan: claimedSessions })
    listed.push(...files)
    // One stat per session this build, however many agents it has.
    const cwdOf = new Map<string, Promise<string | undefined>>()
    const sessionCwd = (session: string) => {
      let cwd = cwdOf.get(session)
      if (!cwd) {
        const file = sessionFileOf(deps.claudeDir, entry.path, session)
        sessionFiles.push(file)
        cwd = sessionCwds.read(file)
        cwdOf.set(session, cwd)
      }
      return cwd
    }
    const runs: AgentRun[] = []
    for (const file of files) {
      try {
        const run = await agentRuns.read(file)
        const agent = run && agentOfRepo(run, await sessionCwd(file.session), entry, deps.platform)
        if (agent) runs.push(agent)
      } catch {
        // A transcript deleted between listing and reading is left out.
      }
    }
    return runs
  }

  /** What gh has answered, for the asks `refresh` makes. A head asked both ways counts as a plain head there too. */
  function readsOf(repoPath: string, numbers: number[], heads: string[], stagingHeads: string[]): GhRead[] {
    const { prRead, branchRead } = deps.gh
    if (!prRead || !branchRead) return []
    return [
      ...numbers.map((pr) => ({ pr, read: prRead(repoPath, pr) })),
      ...heads.map((branch) => ({ branch, read: branchRead(repoPath, branch) })),
      ...stagingHeads.filter((b) => !heads.includes(b)).map((branch) => ({ branch, staging: true as const, read: branchRead(repoPath, branch) })),
    ]
  }

  async function buildRepo(entry: RepoEntry, id: string, listed: AgentFile[], sessionFiles: string[]): Promise<BoardRepo> {
    const base = {
      id,
      name: pathFor(deps.platform).basename(entry.path) || entry.path,
      path: entry.path,
      ...(entry.caseless ? { caseless: true as const } : {}),
      source: entry.registered ? (entry.claims.length > 0 ? 'both' : 'registered') : 'claim',
      claims: entry.claims,
    } as const
    let model: RepoModel
    try {
      model = buildRepoModel(await readRepoFiles(entry.path))
    } catch (err) {
      return { ...base, error: folderError(err), model: buildRepoModel({}), agents: [], prs: [] }
    }
    const numbers = livePrNumbers(model, entry.claims)
    const numbered = numbers
      .map((n) => deps.gh.get(entry.path, n))
      .filter((pr): pr is PrStatus => pr !== undefined)
    // A fix run's PR or a plan's final PR, found by its head branch; it replaces the same PR found by number.
    const heads = prBranches({ model, claims: entry.claims })
    const byBranch = heads
      .map((b) => deps.gh.getBranch(entry.path, b))
      .filter((pr): pr is PrStatus => pr !== undefined)
    const found = [...numbered.filter((p) => !byBranch.some((b) => b.number === p.number)), ...byBranch]
    // A staging branch's PR to main, once a plan reached its final PR (its base may name the branch). It
    // replaces the same PR found by number (a pending gate 7 names it), which has no `branch`, so the staging
    // rules still find it; a PR a fix or plan branch found stays as it is.
    const stagingHeads = stagingBranches({ model, claims: entry.claims, prs: found })
    const staging = stagingHeads
      .map((b) => deps.gh.getBranch(entry.path, b))
      .filter((pr): pr is PrStatus => pr !== undefined && !byBranch.some((p) => p.number === pr.number))
    const prs = [...found.filter((p) => !staging.some((s) => s.number === p.number)), ...staging]
    // Before the first await after the reads above, so a read mark and its PR are from one moment.
    const ghReads = readsOf(entry.path, numbers, heads, stagingHeads)
    return { ...base, model, agents: await agentsOf(entry, listed, sessionFiles), prs, ...(ghReads.length > 0 ? { ghReads } : {}) }
  }

  return {
    async build() {
      const { entries, configUnreadable } = await repoEntries()
      const listed: AgentFile[] = []
      const sessionFiles: string[] = []
      const { ids } = repoIds(entries, deps.platform)
      const repos = await Promise.all(entries.map((e, i) => buildRepo(e, ids[i]!, listed, sessionFiles)))
      // Forget transcripts no repo listed this time: out of the day window, deleted, or their repo gone.
      agentRuns.retain(listed)
      sessionCwds.retain(sessionFiles)
      repos.sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.path, b.path))
      const board: Board = { generatedAt: now(), gh: deps.gh.status(), repos, transcriptDays: deps.transcriptDays }
      const checkedAt = deps.gh.checkedAt()
      if (checkedAt !== undefined) board.ghCheckedAt = checkedAt
      if (configUnreadable) board.configError = 'config unreadable'
      if (deps.actions) board.actions = deps.actions()
      // The toggles that are on, under each repo's id now, with the stop each last sent, so a sent stop raises no toast.
      if (deps.autoContinue) {
        board.autoContinue = deps.autoContinue().flatMap(({ path, run, lastKey }) => {
          const repo = repos.find((r) => repoPathKey(r) === path)
          return repo ? [{ repoId: repo.id, run, ...(lastKey === undefined ? {} : { lastKey }) }] : []
        })
      }
      return board
    },
    async refreshGh(board) {
      let changed = false
      // One repo at a time: the first call settles `gh auth status` for the rest.
      for (const repo of board.repos) {
        if (repo.error !== undefined) continue
        if (await deps.gh.refresh(repo.path, livePrNumbers(repo.model, repo.claims), prBranches(repo), stagingBranches(repo))) changed = true
      }
      return changed
    },
  }
}

/**
 * The PRs the board asks gh about: per plan that isn't archived, the open PRs
 * of its current sprint's slices, plus its hand-back PR (the model's `handBackPr`). An archived plan a
 * claim names (pod archives it before the final merge) gives its hand-back PR too. Then the staging PR each
 * pending gate 7 entry names, so its merged state can make the entry Done (queue-triage.ts); once each, and
 * only while the entry is pending (a merged PR is final in the gh cache, so it is asked once). In first-seen order.
 */
export function livePrNumbers(model: RepoModel, claims: Pick<Claim, 'plan'>[] = []): number[] {
  const numbers = new Set<number>()
  for (const plan of model.plans) {
    if (plan.status === 'archived') {
      const handBack = claims.some((c) => c.plan === plan.slug) ? handBackPr(plan) : undefined
      if (handBack !== undefined) numbers.add(handBack)
      continue
    }
    const sprint = plan.sprints.find((s) => s.slug === plan.currentSprint)
    for (const slice of sprint?.waves.flatMap((w) => w.slices) ?? []) {
      if (slice.pr.state === 'open' && slice.pr.number !== undefined) numbers.add(slice.pr.number)
    }
    const handBack = handBackPr(plan)
    if (handBack !== undefined) numbers.add(handBack)
  }
  for (const e of model.queue) {
    const staging = e.isPending ? stagingPrOf(e) : undefined
    if (staging !== undefined) numbers.add(staging)
  }
  return [...numbers]
}

/**
 * The plan branches the board asks gh about by head, for a final PR pod opened before it wrote the
 * hand-back: per plan in its final review or close-out with no pending hand-back (that PR is asked by
 * number). In close-out: an archived or done plan a claim names, or any other plan with every sprint
 * done. Any PR on the branch counts, whatever its base (a plan doc doesn't record its merge-target).
 */
export function finalPrBranches(model: RepoModel, claims: Pick<Claim, 'plan'>[] = []): string[] {
  const finished = new Set(['archived', 'done'])
  return model.plans
    .filter((plan) => {
      if (handBackPr(plan) !== undefined) return false
      if (finished.has(plan.status)) return claims.some((c) => c.plan === plan.slug)
      return plan.sprints.length > 0 && plan.sprints.every((s) => s.status === 'done')
    })
    .map((plan) => plan.slug)
}

/** The head branches gh is asked about: each fix run's, then each final PR's. */
const prBranches = (repo: Pick<BoardRepo, 'model' | 'claims'>) => [...fixRunNames(repo), ...finalPrBranches(repo.model, repo.claims)]

function folderError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'repo folder not found'
  if (code === 'ENOTDIR' || (err instanceof Error && err.message.startsWith('not a directory'))) return 'not a directory'
  return 'repo folder unreadable'
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
