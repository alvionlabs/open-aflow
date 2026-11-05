// The board the server sends to the web app: every repo with its run model,
// its pod agents, its PRs, and its port claims. Types only; times are epoch ms.
// The shapes are the sprint's shared contract (pod-docs/sprints/server-runs.md).

import type { ActionEntry } from './actions.ts'
import type { RepoModel } from './run-model.ts'

/** One pod agent, read from its transcript. Never holds transcript text, tool input, or tool output. */
export type AgentRun = {
  id: string
  session: string
  type: string
  /**
   * Set when its session's own file doesn't show the session started in this repo: no readable `cwd`, or one
   * outside the repo. The agent stays listed, but the board offers no send on its session (`replySession`).
   */
  sessionUnproven?: true
  /**
   * Never set: the dispatcher's Task description is assistant-written text, and no page shows it,
   * so it stays off the Board. Optional only until the test helpers that still write it drop it.
   */
  description?: string
  sprint?: string
  slice?: string
  branch?: string
  plan?: string
  round?: number
  /** A reviewer's `kind` field: `plan` or `fix`. */
  kind?: string
  /** A reviewer's PR number, from its `PR URL` or `PR` field's GitHub pull URL. */
  pr?: number
  model?: string
  startedAt?: number
  lastAt?: number
  /**
   * When it was active: `[from, to]` spans, oldest first, split wherever two records are more than
   * IDLE_GAP_MS apart (the laptop asleep, a run left waiting). Times only. Missing on an agent with no timed record.
   */
  active?: [number, number][]
  tokens: number
  /** Its last turn handed back (or ended its turn) after its last prompt. */
  ended: boolean
  /** Set only on an agent resumed after a hand-back (SendMessage): when its last turn's prompt came. A time only. */
  resumedAt?: number
  /** Set only with `resumedAt`: each turn, from its prompt to its hand-back (absent while it works). Times and tokens only. */
  turns?: AgentTurn[]
}

/** One turn of a continued agent. `lastAt` is its last record; `tokens` the messages that finished in it. */
export type AgentTurn = { startedAt: number; endedAt?: number; lastAt: number; tokens: number }

export type AgentState = 'running' | 'ended' | 'stale'

export type PrStatus = {
  number: number
  state: 'open' | 'merged' | 'closed'
  checks: 'pass' | 'fail' | 'pending' | 'none'
  url?: string
  checkedAt: number
  /** The head branch, set when the PR was found by its branch (a fix run's `fix-<slug>`, or a plan's final PR on `<plan-slug>`). */
  branch?: string
  /** The base branch gh reports (`baseRefName`), when it reports one. */
  base?: string
  /** When it merged (ms since epoch), from gh's `mergedAt`; only on a merged PR gh gave a time for. */
  mergedAt?: number
  /** The PR's title as gh gives it; only on a PR found by its branch. */
  title?: string
}

export type GhStatus = 'ok' | 'missing' | 'logged-out' | 'unknown'

export type Claim = { portBase: number; repoPath: string; plan: string }

/**
 * One PR the server asks gh about, by number or by head branch, and whether gh has answered that ask once.
 * A failed read isn't one. A branch with no PR is. `staging`: the ask comes from another PR's base, so
 * a PR read can bring it. How the toasts use it is in pod-docs/feature-details/toasts.md.
 */
export type GhRead = { pr: number; read: boolean } | { branch: string; staging?: true; read: boolean }

export type BoardRepo = {
  id: string
  name: string
  path: string
  /** Set when the repo's file system ignores case: `repoPathKey` folds the path, as `sameRepoPath` does. */
  caseless?: true
  source: 'registered' | 'claim' | 'both'
  error?: string
  model: RepoModel
  agents: AgentRun[]
  prs: PrStatus[]
  claims: Claim[]
  /** Each PR the server asks gh about. Missing when it asks about none. */
  ghReads?: GhRead[]
}

export type Board = {
  generatedAt: number
  gh: GhStatus
  ghCheckedAt?: number
  /** Set on every build where the config file exists but can't be read; the last repo list is still used. */
  configError?: 'config unreadable'
  repos: BoardRepo[]
  /** The action log, newest first, at most 50. */
  actions?: ActionEntry[]
  /** The runs whose auto-continue toggle is on. Missing means all off. */
  autoContinue?: { repoId: string; run: string; lastKey?: string }[]
  /** POD_BOARD_TRANSCRIPT_DAYS: agents come only from transcripts written in this many days. Missing on older Boards (read as 30). */
  transcriptDays?: number
}
