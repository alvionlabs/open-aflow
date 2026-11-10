# OpenAFlow: master plan

_Written: 2026-10-18 · Updated: 2026-11-02 · Status: phases 1 and 2 built (pod plans `board-read`, `board-actions`); next is the Windows app (plan `windows-app`) · Design: [docs/design/preview.html](design/preview.html) ([published preview](https://claude.ai/artifact/H2xCmKqGwKRvvUyqCnx6P8))_

This is the long-range plan. Each phase below is built as one or more pod plans (`/pod:ship` or `/pod:plan`), because a pod plan holds at most four sprints. Start each pod plan from this file: paste its phase section into the plan interview as the brief.

## Goal

A local app that shows every [pod](https://github.com/iamphduc/claude-pod) run across your repos, lets you approve work without the chat, and later lets you watch or step into an engineer and start runs without a Claude Code session.

## Why

- Today a pod run lives in one chat. With several repos running, there's no single place to see what's running, what's blocked, and what's waiting on you.
- Approvals (merge a wave PR, answer a queue entry, reply `continue`) need the chat open.
- pod already writes everything the board needs to disk (`pod-docs/`, agent transcripts, GitHub PRs), so phase 1 needs no change to pod.
- Evidence from other tools: Vibe Kanban shut down in April 2026 after Claude Code absorbed its generic features (multi-agent, diff comments, preview). Claude Squad needs tmux and doesn't run on native Windows. So the board invests first in what is specific to pod (waves, the queue, the review, the paper trail) and treats generic session management (phases 3 and 4) as a later decision.

## Success criteria

- Phase 1: with three repos running pod, one browser tab shows each run's stage, the current wave's slices, what needs you, and each engineer's live activity, within 5 seconds of pod writing it.
- Phase 2: you can merge a wave PR and answer a `PENDING` from the board, and pod picks both up exactly as if you had done it in chat.
- The board never breaks a run: phase 1 only reads; every phase 2 action does exactly what the human would do by hand.
- Ship on Windows: a friend goes from one installer to their runs without a terminal.
- Ships on Windows first, then Linux, then Mac. Mobile and accessibility work stopped on 2026-11-02.

## Users and scope

One developer running pod on their own machine, in one or more repos: first the author, then friends, then the public. No accounts, no cloud, no team sharing.

**Out of scope for now:** hosting, multi-user access, mobile app (a phone ping comes in phase 3), editing plans or sprint docs from the board, any non-pod agent workflow.

## Look

`DESIGN.md` and `packages/web/src/theme/tokens.css` now hold the look (plan `calm-dashboard`). The text below is the first look, kept as history.

- **Thesis:** a quiet control room. Neutral slate surfaces, one cobalt accent, and state shown by colored chips and card edges, so what needs you stands out at a glance.
- **Palette (light / dark):**
  - bg `#f4f5f8` / `#0f121a`
  - panel `#ffffff` / `#171b26`
  - panel-2 `#eef0f5` / `#1e2331`
  - line `#d9dde7` / `#2c3344`
  - fg `#161a26` / `#e8eaf1`
  - muted `#5d6478` / `#9aa1b4`
  - accent `#2f55d4` / `#7e9bff`
  - Semantic colors: ok `#1d8a55` / `#4fc58a`, needs you `#b26a00` / `#f0ae47`, blocked `#c2373a` / `#f07a7c`, idle `#7a8194` / `#8b92a6`. Each has a soft background for chips; the values are in the file.
- **Fonts:** Bricolage Grotesque (display), Instrument Sans (body), JetBrains Mono (codes, numbers, logs). All on Google Fonts; self-host them in the app.
- **Screens:** runs list and pipeline (screen 1), wave board with dependency lines and the critical path (screen 2), engineer view with a live transcript (screen 3).
- **Rules:** both themes from day one; state is shown in form (chip, card edge), not only in text.

## How the board integrates with pod

The board stays a separate app. pod keeps working without it, and the board never makes pod depend on it. Integration has three layers. Each later layer is optional and degrades to the one below it.

### Layer 1: read what pod already writes (phase 1, no pod change)

| What the board shows | Where it reads it |
|---|---|
| Which repos have pod, and their layout version | `<repo>/pod-docs/README.md` → `pod docs: <N>` (the board supports version 2; it shows "update pod" for others) |
| Active runs across repos | `<temp>/pod-ports/<base>` claim files: each holds `<parent-repo> <plan-slug>` (or `fix-<slug>`) for a running plan or fix. Plus a list of repos you register, for history |
| Plan, its sprints, and port base | `pod-docs/plans/<slug>.md`: header (`Status`), `## Sprint sequence` table, `Port base:` line, `## Look` |
| Waves and slices (the board) | `pod-docs/sprints/<sprint>.md` status board: `Wave · Slice · Title · Branch · PR · Status · Confidence · Depends on`; each slice's section for **Files owned**, **Model**, **One-way door** |
| Finished sprints, per-slice time and model | `pod-docs/sprints/archive/<sprint>.md` → `## Sprint summary` and its **Slice log** |
| What needs you | `pod-docs/handoff-queue.md`: entries with `BLOCKED` / `PENDING`, `from → to` headers, `**Resolution:**` lines; resolved history in each plan's `## Queue log` |
| Decisions and defaults | `pod-docs/decisions.md` (agent defaults are marked `(agent default — override anytime)`) |
| Reports and feature notes | `pod-docs/reports/<plan>.html`, `pod-docs/feature-details/*.md` |
| Live engineer activity, tokens, last active time | Claude Code transcripts: `~/.claude/projects/<encoded repo path>/<session>.jsonl` and `.../<session>/subagents/agent-<id>.jsonl` (tool calls, timestamps, usage) |
| PRs and CI | `gh pr view <url> --json state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision` |

**Reuse pod-flow's parsers.** `claude-pod/pod-flow/hooks/model.ts` already parses these files: `parsePlan`, `parseSprint`, `parseQueue`, `readTable`, `parseDispatch`, `prState`, `tokenTotals`, and more, with tests in `model.test.ts`. Port them into the board's `model` package with their tests, then extend them. Later, move them into one shared package both use, so a format change is fixed once.

**Contract risk.** These are Markdown files written by an LLM, and their format changes with pod. To manage it:
- The board checks the docs version and refuses unknown versions.
- Its parsers are tolerant: a missing field shows as unknown, never as a crash.
- Its tests run on fixtures copied from real runs (`chess-web`, `speak-out`, `ytb-feed`, `skyscraper-view`).

### Layer 2: a run event log written by code (pod-side change, before or during phase 1)

Markdown tells the board *what is*. An event log tells it *what just happened*, exactly and immediately, without waiting for the orchestrator to update a status board.

- **Who writes it:** a small mod in the pod plugin (TypeScript, the same mechanism as pod-flow, so no shell and no Node). It writes events from code, not from the LLM:
  - `skill.prompt` for `pod:*` skills, giving run start and stage
  - `agent.spawn` and agent end for `pod:*` agents, with the slice parsed from the dispatch the way pod-flow's `parseDispatch` does
  - `tool.call` for `gh pr create` and `gh pr merge`
- **Where:** `<repo>/.claude/pod/events.jsonl`, next to pod's worktrees. The folder holds its own `.gitignore` containing `*`, so it never reaches git.
- **Format:** one JSON object per line, for example `{"t":"2026-10-18T14:03:11Z","run":"report-edit-button","session":"<id>","kind":"agent.start","agent":"pod:engineer","slice":"C1","wave":2,"sprint":"edit-history"}`. It carries a `v` field for its own format version.
- **Fallback:** mods are early access. Without the log, the board derives the same events (more slowly) from the Markdown and the transcripts. Nothing in the board requires it.

This also fixes the mapping problem: each event carries the Claude Code session id, so the board knows which transcript belongs to which run.

### Layer 3: act on a run (phase 2)

| Action | How the board does it | How pod picks it up |
|---|---|---|
| Merge a wave PR | `gh pr merge <url> --merge` (merge commit, never squash, same as pod's rule) after a confirm step | `/pod:code` checks "the last wave PR merged" when it resumes |
| Answer a `PENDING` | Appends the answer to that entry in `pod-docs/handoff-queue.md` in the parent repo, in the queue's own format | `/pod:code` and autopilot read the queue for answers at each wave |
| Resolve a `BLOCKED` | Same as above, then the run needs a resume (next row) | |
| Reply `continue` / `go` / `try` | Phase 2: shows the exact reply with a copy button and which chat to paste it in. Phase 4: the runner resumes the session itself (`claude -p --resume <session> "continue"`, with your own login) | |

pod-side work for layer 3:
- Define the answer format in the queue so pod reads a board answer the same as a chat answer. The entry gains a `**Answer (human):**` line, and pod's skills already treat the queue as the place answers come from.
- Make sure every place pod ends a turn to wait for the human has a matching disk signal the board can show: a merged PR, a queue answer, or a `go` recorded in the plan doc.

### Not chosen, and why

- **The board drives Claude Code directly (a harness):** a separate wrapper would own the whole run. That means a second product, losing the in-chat plan interview, and billing risk: Anthropic expects a distributed Agent SDK product to use an API key, while running the user's own `claude` binary with their own login is allowed. Revisit in phase 4 only.
- **The board edits pod's Markdown freely:** only the queue answer is written by the board. Plans and sprint docs stay pod's.

## Architecture

```
Claude Code + pod plugin ──writes──▶ <repo>/pod-docs/*.md, worktrees
        │                            <repo>/.claude/pod/events.jsonl   (layer 2)
        │                            ~/.claude/projects/**.jsonl       (transcripts)
        ▼
<temp>/pod-ports/<base>  (active runs)          GitHub (gh)
        │                                           │
        └──────────────▶  OpenAFlow server ◀───────┘
                          (Node, on 127.0.0.1)
                          watch files → run model → server-sent events
                                  │  ▲
                                  ▼  │ actions (phase 2)
                          Board UI in your browser
```

**Defaults to confirm in the plan interview** (record each in Key decisions):
- TypeScript everywhere, Node 22 or later, pnpm workspace with packages `model` (parsers and run model, no I/O), `server`, and `web`.
- Server: Hono or Fastify. File watching with chokidar. Live updates to the browser over server-sent events.
- Web: React + Vite. No database: state is rebuilt from files on start and kept in memory.
- Tests: Vitest for `model` (fixture-driven) and `server`, and browser checks with agent-browser per pod's rules.
- ~~Ship as `npx pod-board` later.~~ Dropped: [no npm publishing](../pod-docs/decisions.md#2026-10-21--no-npm-publishing). The board ran only with `pnpm dev` until plan `windows-app`, which adds an installer from GitHub Releases, still with no npm package.
- **Security:**
  - Bind to `127.0.0.1` only.
  - Check the `Host` header against DNS rebinding.
  - Phase 2 actions need a per-launch token in the page, so another website can't post to the board.
  - Never read or show secrets: transcripts can contain them, so the engineer view shows tool names and short summaries, not raw tool output.

**Config:** `~/.config/openaflow-server/config.json` (or the OS equivalent) lists registered repos. It's added from the UI ("Add repo" picks a folder that has `pod-docs/`).

## Phases

### Phase 0 — pod-side groundwork (in `claude-pod`, small)

Done as normal `claude-pod` PRs, not a pod plan.

1. Before phase 1: record `go` and the session id in the plan doc, so the board can show "waiting for go" from disk.
2. Before phase 2: the queue answer format (layer 3), documented in `skills/code/SKILL.md` and the queue scaffold.
3. Later, only if phase 1 shows Markdown and transcripts are too slow or ambiguous: the run event log mod (layer 2), with table tests like pod-flow's.

PR #78 (staging and evals) is merged.

### Phase 1 — see every run (pod plan `board-read`, 3 sprints)

Planned in [pod-docs/plans/board-read.md](../pod-docs/plans/board-read.md), which holds the decisions from the plan interview.

- **Sprint 1, bootstrap and model:** pnpm workspace, `model` package with pod-flow's parsers ported and tested on real-run fixtures, the run model (repo → plan → sprints → waves → slices, queue entries, PRs), and the docs-version check.
- **Sprint 2, server and screen 1:** the file watcher and run discovery (claim files plus registered repos), transcript reader (last activity, tokens, tool timeline), `gh` reader with caching, server-sent events, the runs list, and the pipeline with its per-slice log. Both themes, at 375 px.
- **Sprint 3, screen 2 and screen 3:** the wave board (dependency lines, critical path, status filters and counts), the engineer view (branch, files owned, test progress, live tool timeline), and empty and error states (repo on an old docs version, `gh` not logged in, no runs).

Verification: run it against the four existing pod repos and one live `/pod:code` run; every number on screen traces to a file or a `gh` call.

### Phase 2 — approve from the board (pod plan `board-actions`, about 2 sprints)

- Merge a wave PR (shows CI status and mergeability first, then a confirm step, then a merge commit).
- Answer and resolve queue entries.
- Copy-the-reply for `continue` / `go` / `try`.
- Action log in the UI, and the security token and host check.
- Verification: in a scratch repo running `/pod:code`, merge a wave PR and answer a `PENDING` from the board; the next wave starts with that answer in use.

### Ship on Windows (pod plan `windows-app`, 4 sprints; next)

Planned in [pod-docs/plans/windows-app.md](../pod-docs/plans/windows-app.md). The evidence is in [pod-docs/research/windows-desktop-app.md](../pod-docs/research/windows-desktop-app.md).

- **One-port server:** `pnpm start` runs the bundled server and web app on one port.
- **Outside a terminal:** tool finder, setup check, clean stop.
- **Desktop shell:** Electron window, tray, toasts, single instance, start at login.
- **Installer and updates:** per-user NSIS installer, release workflow, auto-update, install note.

After it: code signing and a public launch, then Linux, then Mac. Each is its own plan.

### Phase 3 — watch and step in, phone ping (decide after using phases 1–2)

- Engineers run as their own Claude Code sessions (the `/pod:create-wave-prompts` mode, or Claude Code workflows if a workflow agent can run `pod:engineer`), so the board can open one.
- Phone notification when a run needs you (pod already sends `PushNotification` on a halt; add Telegram or ntfy if wanted).

### Phase 4 — runs without a chat (decide later)

- A runner that starts and resumes `claude` with the user's own login. Never `--bare`, which needs an API key.
- Billing rules for headless use changed three times in 2026. Re-check Anthropic's current policy before starting.

## Risks

- **pod's file formats change.** Mitigated by the docs version, tolerant parsers, real-run fixtures, and, later, the shared parser package.
- **Mods stay early access.** Layer 2 is optional, and the board works from Markdown and transcripts alone.
- **Transcript formats are internal to Claude Code.** Read only stable fields (timestamps, tool names, usage), and fail soft.
- **Feature absorption.** Claude Code may add its own multi-agent views, as it did against Vibe Kanban. Phases 1–2 stay pod-specific to limit this.
- **Security of a local server that can merge PRs.** Covered by localhost binding, the host check, and the action token.

## Open questions

1. ~~Name: keep "Pod Board"?~~ Decided 2026-11-05: the app is OpenAFlow ([decision](../pod-docs/decisions.md#2026-11-05--the-app-is-open-aflow-human-decision)).
2. ~~npm in phase 1?~~ Decided 2026-10-21: no npm publishing; the board runs from the repo ([decision](../pod-docs/decisions.md#2026-10-21--no-npm-publishing)).
3. Phase 3 route: engineer sessions via `/pod:create-wave-prompts`, or Claude Code workflows? First test whether a workflow agent can run `pod:engineer` with its own tools and model.
4. Phone notifications: Telegram, ntfy, or only Claude Code's `PushNotification`?

## How to start (after compacting)

1. In `claude-pod`: do phase 0 item 1 (record `go` and the session id) as a small PR.
2. In this repo: run `/pod:init` (it asks before the first commit and before creating the GitHub repo).
3. Then `/pod:autopilot` (or `/pod:sprint board-read`) to build [pod-docs/plans/board-read.md](../pod-docs/plans/board-read.md).
