# Decisions

_Shared: you and the agents both write here, and agents must follow what it says._

> Stub — authoritative architectural decisions for your project. One entry per decision; agents link here from `handoff-queue.md` Resolution lines.

<!-- ## YYYY-MM-DD — <title>
Context: <why this came up>
Decision: <what was decided>
Consequences: <trade-offs, follow-ups> -->

## 2026-10-18 — merge target: staging
Context: `/pod:autopilot` merges unattended, and the human doesn't want commits on `main` without asking.
Decision: autopilot merges land on `pod-staging`. The human moves them to `main` after looking.
Consequences: the final plan PR targets `pod-staging`; at plan end autopilot opens a `pod-staging` → `main` PR and never merges it.

## 2026-10-18 — browser: agent-browser
Context: preflight browser check.
Decision: `agent-browser` 0.39.0 is installed; agents check pages with it.
Consequences: none.

## 2026-10-18 — run board-read before the pod-side `go` prerequisite
Context: the plan lists a claude-pod change (record `go` and the session id in the plan doc) as a prerequisite. It isn't in claude-pod yet.
Decision: proceed. The board shows "waiting for go" as unknown until pod records it.
Consequences: a follow-up in claude-pod; the parser must tolerate the field being absent.

## 2026-10-18 — repo stays private for now
Context: the plan says "Public repo; scrubbed fixtures". `/pod:init` created `iamphduc/pod-board` as private.
Decision: keep it private until the human checks the fixtures, then make it public.
Consequences: fixtures must still be scrubbed as if public.

## 2026-10-19 — light chip text: darker ink tokens
_Obsolete: the calm-dashboard Look (2026-10-28) draws a state as a dot plus a word in `--fg` or `--muted`, with no fill, so chip text no longer takes a state color and the `--*-ink` and `--*-soft` tokens are gone. See the 2026-10-28 entry below._

Context: the approved light theme's chip text fails 4.5:1 on its soft fills (queue entry from sprint server-runs, slice L1; draft `pod-docs/design-drafts/chip-contrast.html`).
Decision: keep option A as built: light chip text uses the `--*-ink` tokens (the same hue, darkened only enough to pass); dots, card edges, and fills keep the Look's colors. Dark is unchanged.
Consequences: light chip text is slightly darker than the preview; `tokens.test.ts` keeps the 4.5:1 check.

## 2026-10-19 — `you` only on unfinished waves
Context: a merged wave with a pending `→ human` queue entry showed `you`, so finished waves looked unfinished (queue entry from sprint server-runs, slice P1).
Decision: a wave step, or a slice card, that is done shows `done`, even with a pending entry for the human. `you` applies only to waves and slices not yet done. The run and the plan still show `needs-you` while any entry needs the human.
Consequences: nothing waiting on the human is hidden at the plan level; finished work reads as finished.

## 2026-10-19 — cut the speak-out fixture to a sample
Context: `packages/model/fixtures/speak-out/docs/handoff-queue.md` held about 300 KB of speak-out's internal notes, some about auth and security (queue entry from sprint bootstrap-model, slice F1).
Decision: cut it to a short sample; the board only needs it to prove the old layout reads as unsupported.
Consequences: the repo can go public without that text in the current tree (it stays in git history unless rewritten).

## 2026-10-19 — fix live-update starvation before the final review
Context: gate 3 on PR #12: steady edits (every 300 ms poll, every 150 ms native) gave no board events while they continued.
Decision: option A: one more fix engineer on `board-engineer-w2` caps the wait so a rebuild runs within about 1.5–2 s of a burst's first event, while still grouping quick edits.
Consequences: autopilot resumes after the fix merges into PR #12.

## 2026-10-19 — one more fix before the final merge
Context: gate 2 on PR #15: round 2 found that the loose `plan slug` match reads prose, so a reviewer prompt quoting "`plan slug:` field" reads `plan=field`.
Decision: option A: one more fix engineer on `board-read`, then a round 3 review, and merge only when everything checks out. The fix also drops the dispatch `description` from `/api/board` (the reviewer's "now" hardening item).
Consequences: autopilot resumes; the final merge waits for a passing round 3.

## 2026-10-19 — fix the dispatch-field regression, with a corpus check
Context: round 3 on PR #15 found that #17 reads dispatch fields only from dash-list items, so 104 of 444 real pod transcripts lost fields they read before (engineers show as not started).
Decision: option A: one more fix. A field counts when its name starts a line, a list item, or a `·`-separated part, with or without bold; never mid-sentence or inside backticks. Before it is accepted, every real `pod:*` transcript on this machine is read before (#17's parent, 5d785be) and after, and every change must be explained as intended. Then a round 4 review.
Consequences: autopilot resumes; the merge waits for a passing round 4.

## 2026-10-19 — one last fix: drive paths and fenced blocks
Context: round 4 on PR #15 found that `Plan: E:/…/plans/x.md` reads `plan: "E"` (a drive letter isn't treated as a path), and that fenced code blocks aren't skipped like inline backticks.
Decision: option A: one more small fix for both, with the same corpus check against the current reader, then round 5 and the merge.
Consequences: chess-web's own engineer prompt shape stays unread for now (a separate product choice, still in the queue).

## 2026-10-20 — engineer dispatch fields: pod's names only (agent default — override anytime)
Context: chess-web's `ui-refresh` orchestrator wrote its own engineer prompt shape (``Build slice R1 of sprint `refresh` (plan `ui-refresh`)``, `- Slice: R1, branch `refresh-R1``), so the board reads no fields for its 11 engineers and the run shows `idle` (round 4 and 5 reviews on PR #15).
Decision: the board reads only the field names pod's `agents/engineer.md` defines (`sprint slug`, `slice code`, `branch name`, plus the plan fields). Hand-written shapes aren't guessed.
Consequences: runs dispatched in another shape show their engineers as not started. To change it, add that shape to `packages/model/src/dispatch.ts` with a corpus check, or fix the dispatching side to use pod's names.

## 2026-10-20 — fix runs on the board
Context: the board built runs only from plan docs, so a `/pod:fix` run was invisible: its repo read `no active plan · idle` while the fix engineer worked. Agents tied to no plan (researchers, scouts, stray engineers) showed nowhere. The human approved this design.
Decision:
- **Fix runs are runs.** A claim `<repo> fix-<slug>` whose name matches no plan doc is a fix run, in the same runs list with a `fix` tag chip and the row text `fix · <slug> · <where>`, where `<where>` is `build`, `review`, `fix pass`, `review round 2`, or `PR`. A claim that matches a plan keeps the plan behaviour; a claim not named `fix-…` stays ignored.
- **State**, first match: an agent of the run running → `running`; its PR open and reviewed (the run's agent that wrote last is a reviewer that ended; last write, not start, because an engineer continued for the fix pass keeps its first start) → `needs-you`; else `idle`. An open PR whose review hasn't run since the last engineer or fix pass reads where `review`, state `idle`, and Ship `PR #N · after review`: the PR isn't the human's to merge until the review is done (round 1 review fix, like a plan's final PR waiting for its hand-back).
- **Pipeline**: Build (Engineer, Fix pass), Review (Round 1, Round 2), Ship (the PR found by head branch `fix-<slug>` through the cached `gh` reader: `after review`, `you merge`, `merged`, or `closed`). A closed PR found by branch is asked about again every 30 s while the claim lasts, so a reopen or a new PR shows; only `merged` is final. An agent log (role, round, start → end, state) replaces the slice log; each engineer opens the engineer view at `#/<repoId>/fix-<slug>/agent/<id>`. No wave board tab.
- **Matching**: engineers by their dispatch `branch` field; reviewers by `kind: fix` plus the `branch` field or the PR number from a `PR URL`/`PR` field. Fields only, as in `dispatch.ts`: prose such as `Review PR <url>, branch …` is not read (the 2026-10-20 "pod's names only" default). An engineer that started after the first review is the fix pass; a reviewer's round is its `round` field, else 2 after a fix pass, else 1.
- **Lifecycle**: listed while its claim exists; off the list when the claim is gone, or when its PR merged and none of its agents wrote in the last 30 minutes (`STALE_MS`, as for a close-out). No "recent" row.
- **Title line**: the slug only, not the engineer's task text. The task text is orchestrator-written prompt text that often quotes findings, paths, and pasted output; the board serves no prompt text (`AgentRun` holds none, and the "Engineer view shows no secrets" row plants a secret in the prompt). The human can ask for a safe task line later.
- **Other activity**: agents tied to no run (not an agent of any plan in the repo, not one of a listed fix run's) show in a quiet strip on the repo's view: role, one dispatch field (branch, else plan, else sprint), the last write's time, and a state chip. Only those that wrote in the last 2 hours, the newest 8. It counts as no run and no `needs you`.
- The human's main-session chat isn't read.
- **Continued agents** (round 2 review fix): pod's `/pod:fix` sends the fix pass and round 2 to the same agents with SendMessage. An agent reads `ended` only when its last hand-back comes after its last prompt, and each coordinator resume starts a new turn, so the resumed engineer is the fix pass and the resumed reviewer is round 2, each with its own times.
Consequences: fix reviewers dispatched only in prose (ytb-feed's `kind: fix. Review PR <url>, branch …` shape, the live `fix-feed-infinite-scroll` one included) don't join their run: the Review step reads `not started` and they show under Other activity. Writing `PR:` and `Branch:` as fields (as chess-web's and pod-board's fix reviews do) fixes it. A fix run's agents show under Other activity for 2 hours after its claim goes.

## 2026-10-21 — find a plan's final PR by its branch, any base (agent default — override anytime)
Context: pod opens the final PR at plan-complete step 1, before it writes the hand-back, so Ship read `Final PR · not open yet` through the final review and the report. A plan doc doesn't record its merge-target, and real final PRs target different bases: chess-web's `ui-polish` → `ui-polish-staging` (#91), pod-board's `board-read` → `pod-staging` (#15).
Decision: before the hand-back, the final PR is any PR whose head is `<plan-slug>`, whatever its base: the open one, else the newest (the fix runs' `gh pr list --head` rule). The board asks only for plans in their final review or close-out with no pending hand-back: an archived or `done` plan while a claim names it, or any other plan with every sprint done. Open reads `PR #N · after review` (wait), merged `merged PR #N`, closed `PR #N · closed` (blocked). Once the hand-back exists, its PR wins.
Consequences: an older PR from a reused plan slug can show until the new final PR opens. To filter by base, pod would need to write the merge-target into the plan doc.

## 2026-10-21 — no npm publishing
Context: the master plan planned `npx pod-board` for phase 2. The repo is private (2026-10-18), and the board has one user on one machine.
Decision: don't publish to npm. Plan `board-actions` has no packaging sprint; the board keeps running from the repo.
Consequences: no public package. Revisit if the repo goes public or someone else wants to run it.

## 2026-10-21 — a Continue toggle per run
Context: copy-the-reply still sends the human to the chat to type `continue`.
Decision: each run gets a Continue toggle, off by default. On, the board resumes the run's orchestrator session with `continue` whenever pod waits only for `continue`. Off, a Continue button does it once. The board uses the human's own `claude` login, never an API key or `--bare`.
Consequences: needs a check of Anthropic's current rules for headless use, and of what happens when the session is also open in a terminal, before it's built (plan `board-actions`, sprint `resume-runs`). Copy-the-reply stays as the fallback.

## 2026-10-21 — `go` only from a button
Context: the human doesn't want building to start from a guess while planning is still going on.
Decision: the board never sends `go` on its own, not even with the Continue toggle on. A Go button sends it only when the human presses it. The same holds for `try` and for queue answers.
Consequences: the board never infers "waiting for go" from transcripts; the Go button is shown on a plan whose sprints haven't started, and the human decides.

## 2026-10-21 — build queue answers before pod reads them
Context: sprint `queue-and-replies` was planned to wait for claude-pod's `**Answer (human):**` queue format. claude-pod doesn't have it yet, and the human wants all hand-offs on the board website.
Decision: build the board side now against the master plan's format: a `**Answer (human):** <text>` line on the entry in `pod-docs/handoff-queue.md`. The claude-pod change (pod reads the line like a chat answer) goes to the claude-pod agents in parallel.
Consequences: until claude-pod reads the line, an answer written from the board sits in the queue unread, and pod still waits for the chat. The board says so where you answer. End-to-end verification of answers waits for the claude-pod change. If claude-pod settles on a different format, the board's writer follows it.
Update 2026-10-27: claude-pod #96 (pod 0.8.0+) reads the line at wave start and on resume, so the form now says to answer here, then Continue, with no chat step. On a fix run or repo row, which `/pod:fix` or no run handles, it says the next `/pod:code` wave reads it.

## 2026-10-22 — a closed hand-back PR still counts as waiting (agent default — override anytime)
Context: a plan's final PR whose hand-back is pending but whose PR was closed (not merged) still reads `you merge` and offers Merge, which then fails with `PR is closed` (sprint merge-actions, P1).
Decision: keep it waiting. A closed final PR is rare and needs the human anyway; the board shows gh's `PR is closed` when Merge is pressed.
Consequences: to change it, make `finalWaitingPr` in `packages/model/src/pipeline.ts` skip a hand-back PR gh reports closed.

## 2026-10-22 — only listed runs show their queue entries (agent default — override anytime)
Context: pending `→ human` entries of a plan that isn't on the runs list (archived or finished) show in no Waiting on you list (sprint queue-and-replies, U2). Examples: chess-web `board-feel` and `post-game-review`; pod-board's own `board-read` entries.
Decision: keep the rule: a listed run shows its own entries, and a fix run or repo row shows entries joined to no plan.
Consequences: those older entries can be answered only in the chat or by editing the queue. To change it, list them on the repo row in `packages/web/src/screens/runs/queue-view.ts`.

## 2026-10-22 — headless resume is allowed for your own use (agent default — override anytime)
Context: the board resumes the orchestrator with `claude -p --resume <session> continue`. Anthropic's support page says "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits", and the legal page allows "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription"; the Consumer Terms forbid scripted access unless Anthropic "explicitly permit[s] it", and steer products built on the Agent SDK to API keys (sources in `pod-docs/research/resume-spike.md`).
Decision: allowed for one person's own tool on their own subscription. The board never uses an API key or `--bare`, and auto-continue is off by default.
Consequences: reread the rules before offering pod-board to anyone else, and when `--bare` becomes the default for `-p` (the headless docs say it will).

## 2026-10-22 — no CI
Context: the GitHub Actions runs (three-OS `verify` plus `secrets` on every PR and every push to `pod-staging`) went over the account's Actions limit.
Decision: remove `.github/workflows/pod-ci.yml` and disable the `pod-ci` workflow on GitHub. `## CI` in `codebase-structure.md` is `none`.
Consequences: nothing checks PRs on a clean machine or scans for secrets. Run `pnpm verify` locally before merging. Under `/pod:autopilot`, merges rest on the wave check alone. To bring CI back, restore the file from git history and run `gh workflow enable pod-ci`.

## 2026-10-22 — public repo, Windows-only CI (replaces "no CI")
Context: "no CI" (above) removed the workflow because of the Actions limit. The human then made the repo public, where standard GitHub runners are free, and is developing for Windows first.
Decision: `pod-ci` runs only `verify` on `windows-latest`. No macOS or Linux run and no secret scan.
Consequences: macOS and Linux breakage (such as temp-path differences) and committed secrets are no longer caught by CI, and the repo is public. Add `ubuntu-latest`/`macos-latest` back to the matrix before shipping to those systems; restoring the `secrets` job from git history is cheap.

## 2026-10-23 — no size cap on transcripts
Context: the security review asked for a byte cap on transcript reads (`transcript-files.ts`), since a huge file can use a lot of memory. On this machine agent transcripts reach 25 MB and sessions 136 MB.
Decision: no size cap on transcripts. A hard cap would hide real agents or show the wrong state for them.
Consequences: a read takes about 2–3× the file's size in memory for a moment; the parsed run is cached after, keyed by size and mtime. Switch to a line-by-line reader only if the board gets slow or heavy.

## 2026-10-23 — continue on answered queue entries
Context: claude-pod #96 makes pod read ` **Answer (human):**` lines at each wave start and on resume. A run stopped at a halt or a decision gate doesn't resume by itself, so answering on the board left it waiting with no reply offered.
Decision: once at least one pending `PENDING` or `BLOCKED` entry of a plan routed `→ human` has an answer, no pending `BLOCKED` of it routed `→ human` is unanswered, and no agent runs, the board offers `continue` with signal `answered`, and it is sendable: the Continue button and auto-continue may send it. Your answer is the same consent as a merge. Only an unanswered `BLOCKED` holds it back: a `BLOCKED` halts pod, while a `PENDING` only defers and pod uses the value in use, and a repo's queue keeps many open `PENDING → human` entries (this one had 32), so waiting for all of them would almost never fire. Any other reply wins over it, and its key is a hash of the answered lines, so auto-continue sends once per set of answers.
Consequences: a toggled run resumes on its own once you answer; pod may stop again if a `BLOCKED` cause is still there, and that new entry is a new stop. Fix runs get none (no entry joins them). Auto-continue sends each `answered` key at most once per toggle, so a pod that never rewrites the Resolution isn't sent the same answers at every stop.

## 2026-10-26 — answer only entries routed to you
Context: the board showed Answer on every pending `BLOCKED`, including ones between agents (`engineer → orchestrator`). An answer there was saved but did nothing: `continue` counts only `→ human` entries, and the agents resolve their own entries or write a new one `→ human`.
Decision: Answer shows only on entries routed `→ human`, and the answer route refuses the rest. A `BLOCKED` between agents is still listed in Waiting on you, without the button.
Consequences: to step into an agent-to-agent block, use the chat, or edit the queue by hand.

## 2026-10-26 — autopilot runs show their wave PRs as autopilot's (agent default — override anytime)
Context: under `/pod:autopilot`, pod merges each wave PR itself once it clears the policy's bar, and halts when it doesn't. The board read every handed-back wave as `PR #N · you merge` with a Merge button, so on pod-trial's run, halted at gate 3 because PR #9 had no passing CI, it invited the human to merge past the CI gate. It also showed a `Go · not recorded yet` step that autopilot never records.
Decision: a plan whose active sprint doc (the plan doc while no sprint doc is active) has a line starting `<!-- autopilot-run` is an autopilot run; only its presence counts. Not halted, its waiting wave PR reads `PR #N · autopilot merges` (live, no Merge, not waiting on you, run `running`), and the run gets no `wave-waiting`, `wave-merged`, `sprint-done`, or `not-started` reply, so auto-continue never sends `continue` between its waves. Stopped (a pending `BLOCKED` from the orchestrator, or a pending `PENDING · orchestrator → human` whose entry starts with its gate, `gate 1`–`gate 7` or one of the policy's gate names, any case, maybe in bold or after `Autopilot`: gates 5–7 halt with PENDING, pod has filed gate 3 that way too, gate 6 withholds a mergeable PR for the human, and every halt names its gate first; the orchestrator's other PENDING notes to the human, such as `now: …`, `someday: …`, an agent default, or a note that names a gate mid-sentence, don't count), the step reads `PR #N · autopilot stopped` with Merge (the human's merge at gate 6, an override at gate 3; the confirm shows the checks), and only `answered` moves it on. The run state still reads `blocked` only for a BLOCKED; a PENDING stop reads `needs-you`. No Go step. `/pod:code` runs are unchanged; the final-PR replies stay for both.
Consequences: a `/pod:code` resume of a run autopilot started reads as autopilot until the marker leaves the sprint doc, so its wave PRs show no Merge until a halt; merge those on GitHub, or delete the marker line.

## 2026-10-26 — slice times skip idle gaps over 15 minutes (agent default — override anytime)
Context: slice, wave, and fix-run minutes ran from the first record to the last, so pod-trial's F1 read 1195 min: the PC slept for two gaps of 180 and 997 minutes between about 17 minutes of work.
Decision: a gap over 15 minutes between two records is idle and doesn't count. A foreground tool call runs at most 10 minutes (the Bash tool's limit), and one that runs to it writes its result about 10.02 minutes after the call, so 15 minutes leaves headroom over that and Claude Code's 600 s stall watchdog; a laptop asleep leaves gaps of hours. A gap that ends in the result of the tool call the agent was waiting on counts up to 30 minutes. Agents' spans join as one stream: overlapping engineers count once, and the gap from one agent's last record to the next one's first counts only within 15 minutes. A live agent's time runs to now only while its last record is within 15 minutes. Tokens are unchanged.
Consequences: a wait over 15 minutes that doesn't end in a tool result (a background task's notification), or a tool call over 30 minutes, counts as idle, so times can read low; a laptop that sleeps under 15 minutes counts as work. Times across many agents (two engineers a minute apart) can read a minute higher than the old per-turn sum.

## 2026-10-26 — an autopilot plan's final PR reads `you merge`
Context: pod writes the `autopilot-run` marker only in sprint docs, so once a plan's last sprint is archived the board can't tell it ran on autopilot, and its final PR reads `PR #N · you merge` with Merge. The options were to read the marker from the archived sprint docs, or to ask claude-pod to keep it in the plan doc.
Decision: keep `you merge` on the final PR. It is right at gate 2 (review still failing) and at gate 7 (the staging PR), where the human merges; it is wrong only while autopilot is about to merge a final PR that passed review.
Consequences: in that window, Merge on the board races autopilot to the same merge. Revisit if pod writes the marker in the plan doc.

## 2026-10-28 — states are dots plus words; the ink tokens go
Context: the calm-dashboard plan's Look (draft `pod-docs/design-drafts/calm-dashboard-look-3.html`) replaces the board-read look: black and white, Geist fonts, no colored card edges or fills, dark first (sprint calm-screen, slice L1).
Decision: every state is a dot in its status color plus a word in `--fg` or `--muted`; status colors and `--faint` are never a text color (`tokens.test.ts` checks every CSS file under `packages/web/src`). This makes the 2026-10-19 "light chip text: darker ink tokens" decision obsolete. Nothing stored for the theme reads as Dark.
Consequences: an error or a merge reason is plain text with a colored dot before it. The `--*-ink` and `--*-soft` tokens, and the other board-read names, are gone; screens use only the new tokens.

## 2026-10-28 — app manifest colors follow the Dark default

The installed app's `manifest.webmanifest` uses `#000000` for `background_color` and `theme_color`, matching the new Dark default (plan `calm-dashboard`), so no white splash or browser bar shows before a dark page. `pwa.test.ts` checks them against the dark `--bg`. Chosen by the human at gate 1 of the calm-screen sprint.

## 2026-10-28 — Next step card wording (agent default — override anytime)

Plan `calm-dashboard`. Answer items: the title is the entry body cut to 80 characters; the detail is "The run is stopped until you answer." (`BLOCKED`) or "pod goes on with the value in use until you answer." (`PENDING`). PR items: `Merge PR #N` with "Wave W of <sprint> is handed back to you.", "The plan's final PR is reviewed and waits for you." or "The fix PR is reviewed and waits for you." Reply items: `Send <word>` with the reply row's reason. Change it in `packages/web/src/screens/runs/next-step.ts`.

## 2026-10-28 — an autopilot halt and a waiting PR on the Next step card (agent default — override anytime)

Plan `calm-dashboard`. A `BLOCKED` autopilot halt takes the card. A `PENDING` gate stop (for example gate 6, a PR held back for you to merge) lets the PR take the card, and the halt is listed in the Waiting tab. Pinned by `next-step.test.ts › autopilot`.

## 2026-10-28 — the no-session note sits behind "Run it yourself" (agent default — override anytime)

Plan `calm-dashboard`. On a reply, the card shows only `Copy continue` (or Continue / Go) and `Run it yourself`; the "No pod session found for this run…" note sits behind `Run it yourself` with the session line and the `cd` / `claude --resume` commands. Change it in `packages/web/src/screens/runs/ReplyPanel.tsx`.

## 2026-10-28 — folder picker Add with a partly typed name (agent default — override anytime)

Plan `calm-dashboard`. Add posts a folder only when the typed text ends in a separator, or its last part is a listed folder's whole name (any case); otherwise Add is disabled, and the footer shows the exact path Add will post. Posting the open folder instead would silently add the parent of what you typed. Change it in `packages/web/src/screens/runs/folder-picker.ts`.

## 2026-10-28 — Add repo opens a modal dialog from the sidebar

The human asked for the old full-height sidebar back, with Add repo at its bottom opening the folder picker in a dialog. That dialog is the one exception to the calm-dashboard Look's "controls open in place, never a modal" rule. The ⋯ menu sits at the right end of the run header (fix PR https://github.com/iamphduc/pod-board/pull/56).

## 2026-11-01 — urgent items from other runs show as a banner (reverses calm-dashboard)

Plan `next-step-across-runs`. The human picked placement B, a banner above the run: "If it's urgent, I think the B should be the right way to show for user." This reverses calm-dashboard's "Turned down: a card across all runs": the item shows as one line at the top of screen 1's main column, not as a card, and it only navigates (`Open run`); the selected run's Next step card keeps the one primary button. Default rules, agent defaults (override anytime): only each run's card counts; rank `blocked` > `merge` > `reply` > `pending` (kinds `now`, `decision`, `before` only) > `nothing`; it shows only when strictly higher than the selected card's tier; ties go to the oldest entry date in `blocked` and `pending` (undated last), then to the earlier run in the sidebar; `+N more` counts the other outranking items, a shared entry once. Pinned by `packages/web/src/screens/runs/elsewhere.test.ts`.

## 2026-11-01 — urgent banner hides the repo on phones (agent default — override anytime)

Plan `next-step-across-runs`. At 480 px and below the banner shows `· <run name>` without `· <repo>`, as the look draft's 375 px shot does. To show the repo there too, drop the `.urgent-at { display: none }` rule in `packages/web/src/screens/runs/urgent-banner.css`.

## 2026-11-01 — urgent banner `+N more` counts distinct items (agent default — override anytime)

Plan `next-step-across-runs`. Two runs of one repo that share one unjoined queue entry count once in `+N more`, even when another run wins. Counting runs instead is a one-line change in `packages/web/src/screens/runs/elsewhere.ts`.

## 2026-11-01 — a selected someday card still ranks as pending (agent default — override anytime)

Plan `next-step-across-runs`. When the selected run's Next step card is a pending `someday` or `other` entry, it ranks as `pending`, so another run's pending `decision` raises no banner; only blocked, merge and reply do. The other reading treats such a card as "Nothing to do".

## 2026-11-01 — urgent banner cuts the title first on mid-width screens (agent default — override anytime)

Plan `next-step-across-runs`. From 800 to 1024 px the title ends in an ellipsis while `· <repo> · <name> +N more` stays whole (up to half the line), as the Look says ("the title gives way first").

## 2026-11-01 — urgent banner tinted by status (human reversed "no coloured fill or border" for the banner only)

Plan `next-step-across-runs`, reversing its Look's "Rules out: a colored fill or colored border". The human on the plain banner: "I feel that it's too subtle and also the open run button in nested inside, I think we should use the text button", then, of [draft 2](design-drafts/next-step-across-runs-look-2.html), "B looks good to me". The fill is `color-mix(in srgb, <tone> 10%, var(--bg))` and the border `color-mix(in srgb, <tone> 50%, transparent)`, with the tone `--blocked`, `--needs-you` or `--ready`; any other status keeps the plain box. The status word takes the tone, the title is weight 500, and "Open run" is a text button (`btn sm quiet trail`) in `--fg`. Turned down: A (no change), C (half the tint) and D (a left edge). Every other card keeps the calm-dashboard rule of no coloured fill. The tone is set in CSS with `:has()` on the status class, not with a class from the TSX as first asked, because `runs-screen.test.ts` pins the exact markup `<div class="urgent">`.
