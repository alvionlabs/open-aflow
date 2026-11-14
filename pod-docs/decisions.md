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
- **Lifecycle**: listed while its claim exists; off the list when the claim is gone. [Changed 2026-11-05](#2026-11-05--a-merged-fix-run-stays-listed-until-cleanup-human-decision): a merged PR no longer takes it off. No "recent" row.
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

The installed app's `manifest.webmanifest` uses `#000000` for `background_color` and `theme_color`, matching the new Dark default (plan `calm-dashboard`), so no white splash or browser bar shows before a dark page. `pwa.test.ts` checks them against the dark `--bg`. Chosen by the human at gate 1 of the calm-screen sprint. Superseded 2026-11-05: the manifest is removed.

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

Plan `next-step-across-runs`, reversing its Look's "Rules out: a colored fill or colored border". The human on the plain banner: "I feel that it's too subtle and also the open run button in nested inside, I think we should use the text button", then, of [draft 2](design-drafts/next-step-across-runs-look-2.html), "B looks good to me". The fill is `color-mix(in srgb, <tone> 10%, var(--bg))` and the border `color-mix(in srgb, <tone> 50%, transparent)`, with the tone `--blocked`, `--needs-you` or `--ready`; any other status keeps the plain box. The status word takes the tone, with `--fg` mixed in to reach 4.5:1 (tone 95 % blocked, 90 % needs you, 85 % ready), the title is weight 500, and "Open run" is a text button (`btn sm quiet trail`) in `--fg`. Turned down: A (no change), C (half the tint) and D (a left edge). Every other card keeps the calm-dashboard rule of no coloured fill.

## 2026-11-01 — urgent banner stacks other items and shows the count as a pill

Plan `next-step-across-runs`. The human on the muted `+1 more`: "the plus one is too subtle to notice". Of [draft 3](design-drafts/next-step-across-runs-look-3.html): "I think we should go with A". Of [draft 4](design-drafts/next-step-across-runs-look-4.html): "4 looks good to me, but we have to handle the narrow width carefully. Yes, keep counting everything". So: with `more` ≥ 1, one or two layers (never more) sit behind the banner, stepped 8 px down and right, in the top card's tone. `+N more` is a pill right before "Open run". It keeps its meaning: every other outranking item, not only the same tier (human's confirmation). Turned down: layers in each item's own status colour (draft 3 B, it needs more data from the picker), layers straight down (draft 3 C), stronger text (draft 4 option 2), and a pill inside the text (draft 4 option 3).

The narrow layout follows the banner's own width through a container query on `.urgent-slot`, not the 480 px viewport rule. Each width is measured with a long title and a long run name, so the title keeps about 20 characters on one line. With a count: the repo hides at a column of 760 px or less, and the banner stacks at 620 px or less. With no count, the banner keeps today's one line and repo, and stacks only at 520 px or less. At a 521 px column, the title shows 19 characters for `Blocked` and 18 for `Needs you`; a 528 px column (viewport 1024, sidebar 400) stays on one line.

## 2026-11-02 — ship as an Electron app for friends first, under MIT

Context: the board had one user on one machine and ran only with `pnpm dev`, and the repo is now public. [Research](research/windows-desktop-app.md) compared wrappers for a backend that must stay Node.
Decision: the human's words: "I will let my friends do this first and then go public later. Seems like electron is a better candidate." The order is Windows, then Linux, then Mac. The licence is MIT. Plan [`windows-app`](plans/windows-app.md) holds the rest.
Consequences: this reverses "the board has one user on one machine" (2026-10-21) and `app-shell.md`'s "not Tauri or Electron". There is still no npm package: friends get an installer from GitHub Releases. Friends' builds are unsigned; signing comes before a public launch.

## 2026-11-03 — Recheck and the Board's gh field (agent default — override anytime)
After a Recheck finds `gh`, the Board's `gh` field can stay `missing` for up to 30 s, until the next tick. Value in use: accept the delay.

## 2026-11-03 — toast after you answer a plan's BLOCKED (agent default — override anytime)
Answering a plan's `BLOCKED` raises its `Send continue` reply at once, so the tray dot stays on and a toast follows, as the page's card does. Value in use: keep the toast.

## 2026-11-03 — pod in the setup check (agent default — override anytime)
The setup check looks for `git`, `gh`, and `claude`. The install note and the no-runs states name pod and its install step. Value in use: no setup row for pod.

## 2026-11-04 — Start at login leaves the tray menu (human decision)
Context: the tray menu held Open, Start at login, and Quit, and the human's install test found its labels looked misaligned.
Decision: the human's decision: the tray menu is Open and Quit. Start at login has no point in the tray, and it belongs on a settings page. That page comes later, and isn't part of this change.
Consequences: until that page exists, nothing in the app turns the login item on or off. `createLoginItem` stays for the page. A login item from an earlier version still starts the app in the tray, and only Windows' startup settings or an uninstall removes it.

## 2026-11-05 — A merged fix run stays listed until cleanup (human decision)
Context: a merged fix run left the list once no agent had written in 30 minutes, and then 30 minutes after the merge. A human who merged late, or came back late, lost the card, Continue, and the cleanup. A claim that remains after a merge means cleanup hasn't run.
Decision: the human's decision: a merged fix run stays on the list, with its card, Continue, and toast item, for as long as its claim exists, however long ago the merge was. Cleanup freeing the claim is what ends it. Safety rule: auto-continue sends `continue` only within 30 minutes of the merge, and never with no merge time. The Continue button has no such limit. A sent key never sends again.
Consequences: a run whose session crashed, or whose claim was never freed, stays listed, and the tray dot stays on. The app has no way to remove it: the human deletes the claim file `<os temp>\pod-ports\<port base>` by hand. The cheapest way to add one is a `Forget this run` item in the run's ⋯ menu that deletes that file. It isn't built. Limit: a claimed run keeps Continue while its session is inside the 30-day transcript window. Past it, the run stays listed, its steps read as run with `no transcript`, and it offers Copy with no Continue. A `fix-merged` the toggle already sent raises no toast or dot, unless that send failed to start: see 2026-11-11, a failed send raises its stop.

## 2026-11-05 — The desktop app is the only way users run Open AFlow (human decision)
Context: the page could also be installed from a browser as a PWA, and the README led with `pnpm dev`. The Windows app now exists. The human wrote: "keep the web for you as agent to test and see is brilliant".
Decision: the human's decision: users run the desktop app. The web app (`packages/web`) stays as the desktop app's interface and as the agents' test bench: they run `pnpm dev` against the mock repo, or `pnpm start`, to see and check the UI. The PWA manifest and what only it used are removed.
Consequences: no manifest file, link tag, `apple-touch-icon`, maskable icon, or `.webmanifest` content type. `icon-512.png` stays as the source of the desktop and tray icons, and `icon-192.png` as the tab icon. `/sw.js` still answers 404. The README presents the installer and keeps `pnpm dev` and `pnpm start` under Development. The 2026-10-28 manifest-colors decision no longer applies.

## 2026-11-05 — The app is Open AFlow (human decision)
Context: the repo moved from `iamphduc/pod-board` to `alvionlabs/open-aflow`. No release exists yet, so no installed copy needs a migration.
Decision: the human's decision: users see the name Open AFlow. The window, the page `<title>`, the sidebar, the tray, toasts, the Start menu, the installer, and Installed apps say Open AFlow. The exe is `Open AFlow.exe`, the installer `open-aflow-setup-<version>.exe`, the app ID `com.alvionlabs.openaflow`, and the packaged name `open-aflow`, which sets the install folder `%LOCALAPPDATA%\Programs\open-aflow` and the updater cache `%LOCALAPPDATA%\open-aflow-updater`. The shell data folder follows `app.setName` to `%APPDATA%\Open AFlow`. The update feed is the releases of `alvionlabs/open-aflow`. Agent default under this decision (override anytime): the packaged name `open-aflow`, rather than `open-aflow-desktop`; the human asked only for a matching install folder name.
Consequences: the internal names first stayed `pod-board`. The 2026-11-05 decision "No pod-board name inside the app" below renames them. Pod's own `pod-ports` folder and `/pod:*` commands keep their names. The installer doesn't clean up the old names, because no release used them. Older `pod-docs` history, reports, and sprint docs keep the old name.

## 2026-11-05 — No pod-board name inside the app (human decision)
Context: PR #91 renamed what users see. The packages, env vars, config folder, log prefixes, browser keys, toast scheme, token header and meta, proof lock file, and temp folder prefixes still said `pod-board`. No release exists yet.
Decision: the human's decision: "no more pod-board". The packages are `@open-aflow/*` (the root package `open-aflow`), the env vars `OPEN_AFLOW_*` with no fallback to the old names, the log prefixes `open-aflow:` and `open-aflow desktop:`, the fork messages `open-aflow:ready` and `open-aflow:stop`, the browser keys `open-aflow-theme`, `open-aflow-tab`, and `open-aflow-sidebar-width` (moved once from the old keys), the toast scheme `open-aflow-toast:`, the header `X-Open-AFlow-Token`, and the meta `open-aflow-token`. On its first start, the server copies the old config folder to the new one, without `auto-continue-owner.json`, and keeps the old folder as a backup. It copies only when the new folder doesn't exist and `OPEN_AFLOW_CONFIG_DIR` is unset. `brand.test.ts` fails if the old name comes back in shipped code, build files, or current docs. Agent default under this decision (override anytime): the config folder is `open-aflow-server`, not `open-aflow` as the human asked, because NSIS's `--delete-app-data` removes `%APPDATA%\open-aflow` (the packaged name) and `%APPDATA%\Open AFlow` (the product name). The other way out is a new packaged name, which moves the install folder.
Consequences: the server's config folder is `%APPDATA%\open-aflow-server`, `~/Library/Application Support/open-aflow-server`, or `$XDG_CONFIG_HOME/open-aflow-server`. Pod's own names stay: `pod-docs/`, `pod-ports`, `/pod:*`, `pod docs: 2`, and `iamphduc/claude-pod`. History stays: pod-docs reports, sprints, plans, research, design drafts, the handoff queue, older decisions, History rows, old PR links, and fixtures copied from real repos.

## 2026-11-09 — The GitHub repo is alvionlabs/openaflow (human decision)
Context: the local folder moved to `openaflow`. The GitHub repo was `alvionlabs/open-aflow`. No release or tag exists yet, so no installed copy reads the update feed.
Decision: the human renamed the repo to `alvionlabs/openaflow`. The update feed and the release links use the new name.
Consequences: only the repo name changes. The product names stay `open-aflow`: the packages `@open-aflow/*`, the env vars `OPEN_AFLOW_*`, the config folder `open-aflow-server`, the browser keys, the token header, and the installer and updater file names. GitHub redirects the old URL; never create a new repo named `open-aflow`, or the redirect stops.

## 2026-11-09 — The app is OpenAFlow, inside and out (human decision)
Context: the GitHub repo is `alvionlabs/openaflow`. The app still said Open AFlow, and its internal names were `open-aflow`. No release or tag exists yet, so only the human's machine has data under the old names.
Decision: the human's decision: the name is OpenAFlow, with no space, and every internal name follows it. The window, the exe `OpenAFlow.exe`, the Start menu, and Installed apps say OpenAFlow. The packages are `@openaflow/*`, the env vars `OPENAFLOW_*`, the config folder `openaflow-server`, the token header `X-OpenAFlow-Token`, the installer `openaflow-setup-<version>.exe`, and the browser keys `openaflow-*`. This replaces the names in the 2026-11-05 decisions and in the 2026-11-09 repo rename.
Consequences: no code moves the `open-aflow` data: the human's config folder was copied by hand, and the theme, tab, and sidebar width start fresh. The one-time copy from `pod-board` stays. `brand.test.ts` flags both old names in current files. The human's installed copy keeps the old name until it is uninstalled.

## 2026-11-11 — OpenAFlow hosts terminals that run claude (human decision, not in force until planned)
Context: the app is unusable without the pod plugin. Research: [terminal-host.md](research/terminal-host.md).
Decision: OpenAFlow wraps a terminal. It controls the terminal, not Claude Code. A plugin still drives the workflow. OpenAFlow creates its own `.openaflow/` folder in a repo; claude-pod is its default template for now. The terminal host follows VS Code's design.
Consequences: a spike comes first. Everything else in the research doc is a proposal until a plan takes it.

## 2026-11-11 — Quit confirms and ends running sessions (human decision, not in force until planned)
Context: with a terminal host, a session can outlive the app or end with it.
Decision: quitting the app shows a confirm dialog that ends the running sessions. Sessions are not left running in the background, because they use RAM and make the app hard to predict.
Consequences: reverses "a quit never ends a resumed `claude`".

## 2026-11-11 — Resume is a button, never automatic (human decision, not in force until planned)
Context: after a quit, a crash, or a reboot, the hosted sessions are gone.
Decision: show a **Resume** button on each stopped run. Never resume on its own.
Consequences: none yet.

## 2026-11-11 — The terminal is a tab; the Workflow view stays (human decision, not in force until planned)
Context: with a terminal host, the run list could list terminals, sessions, or plans.
Decision: keep the UI as it is. A row is still a run. The run view with nodes and arrows is called **Workflow**, the screen to sit and watch. The terminal is a new tab in the run view, shown when the user wants to see it.
Consequences: terminals attach to a run; they are not rows. A terminal that starts before its plan exists needs a home (proposal in the research doc).

## 2026-11-11 — Outside runs are watch-only (human decision, not in force until planned)
Context: a run can start in the app's terminal or in the user's own terminal. Both use OpenAFlow's plugin, so both write `.openaflow/`.
Decision: runs started in the app get everything: Workflow, the Terminal tab, Continue, and auto-continue. Runs started in the user's own terminal are watch-only: Workflow, merge, and answer, with no Terminal tab, no Continue, and no auto-continue. Reading state never depends on whether a run is hosted.
Consequences: the old `claude -p --resume` runner is not needed. For outside runs to write `.openaflow/`, the plugin must also be installable outside the app, not only loaded with `--plugin-dir`.

## 2026-11-11 — `.openaflow/` is committed (human decision, not in force until planned)
Context: the folder can be committed, ignored, or partly ignored.
Decision: `.openaflow/` is committed, as `pod-docs/` is today.
Consequences: engineers in worktrees read the docs from their checkout, and doc changes go through PRs. Options not chosen are in the research doc under "Options considered".

## 2026-11-11 — Auto-continue waits 30 s after your typing, as a setting (human decision, not in force until planned)
Context: an automatic `continue` typed into a hosted terminal can mix with the user's own typing.
Decision: after the user types in a run's terminal, auto-continue waits before it may type. The default is 30 s, and the user can change it in a setting.
Consequences: this adds to the other send checks (toggle on, 60 s idle session, empty prompt, live terminal).

## 2026-11-11 — Scrollback is 5,000 lines per terminal, as a setting (human decision, not in force until planned)
Context: the pty host keeps each terminal's output in memory for replay and for the last screen next to Resume.
Decision: 5,000 lines per terminal by default; the user can change it in a setting.
Consequences: the spike measures the memory of one terminal at 5,000 lines.

## 2026-11-11 — Follow VS Code for the terminal link and terminal tests (human decision, not in force until planned)
Context: the window must reach the pty host, and agents must be able to test the Terminal tab. VS Code tests its terminal against the real Electron app. Research: [vscode-terminal.md](research/vscode-terminal.md).
Decision: the window talks to the pty host through `MessagePort` only, with no WebSocket. Terminal checks run against the real Electron app with Playwright `_electron` and a test hook that reads and writes the terminal as text. The browser build stays for the rest of the UI, with no Terminal tab.
Consequences: terminal checks need a display (`xvfb` on Linux), so the smoke recipe gains a step for terminal slices.

## 2026-11-11 — The terminal-host spike runs on Linux only, for now (human decision)
Context: the spike's pass bar asked for Linux and Windows 11. The spike ran on Linux. Windows needed a CI workflow or a run on a Windows machine. Results: [terminal-host-spike.md](research/terminal-host-spike.md).
Decision: run the spike on Linux only for now. No CI workflow, and no Windows run.
Consequences: the spike counts as done on Linux. Windows (ConPTY, Job Objects, packaging) stays untested; a plan that ships the terminal host on Windows must test it first.

## 2026-11-11 — Terminal host: node-pty is upstream 1.2.0-beta.18, pinned (human decision, not in force until planned)
Context: node-pty 1.1.0 has no Linux prebuilt binary; upstream 1.2.0-beta.18 has one. Research: [terminal-host-spike.md](research/terminal-host-spike.md).
Decision: use upstream `node-pty@1.2.0-beta.18`, pinned. The first slice proves it in Electron 45. If it fails, use `@lydell/node-pty`. Move to 1.2.0 stable when it ships.
Consequences: `allowBuilds` needs an entry for it.

## 2026-11-11 — Automatic input: draft rule, two idle rules, one checked send path (human decision, not in force until planned)
Context: in the spike, a send after the typing wait submitted a half-typed draft. A wrong automatic send can drift the whole workflow.
Decision: a draft (input with no Enter after the newest submit) blocks every automatic send until the next submit. Idle needs both the 60 s transcript rule and the hook rule. All app-written input goes through one send path that logs each attempt and checks the next `UserPromptSubmit` prompt; on a mismatch, auto-continue turns off for that run and the app alerts you. Manual **Continue** skips only the typing wait, and when blocked shows why and offers **Open terminal**. Every automatic input is listed with its gate and tests in [automatic-input.md](research/automatic-input.md).
Consequences: a PR that adds or changes an automatic input updates `automatic-input.md` and its tests. Gaps to test before shipping: question dialogs, plan approvals, the trust prompt, subagents after `Stop`.

## 2026-11-11 — Run wrapper and stop command are text settings (human decision, not in force until planned)
Context: a child that clears its env survives quit unless the run is in a systemd scope.
Decision: two text settings, stored in the app's config folder only. Defaults on Linux: `systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope` and `systemctl --user stop openaflow-run-{runId}.scope`. Placeholders `{runId}` and `{unit}`, a full-command preview, and **Reset to default**. No shell: the app splits the arguments. The default wrapper falls back silently (logged) when it can't start; a changed wrapper that fails stops the run with an error and **Open settings**. Shown on Linux and macOS (default on Linux only); hidden on Windows, which uses a Job Object. Changes apply to new runs.
Consequences: the app's own tree, marker, and signal steps always run after the stop command.

## 2026-11-11 — Quit ends runs with SIGHUP, SIGTERM, SIGKILL (human decision, not in force until planned)
Context: real `claude` ended on SIGHUP in about 1 s; on SIGTERM it once ran past 3 s.
Decision: all runs end in parallel: SIGHUP, up to 3 s, SIGTERM, up to 3 s, SIGKILL. The app shows "Ending N runs…".
Consequences: a quit with live runs takes at most about 6 s after you confirm.

## 2026-11-11 — Keep the browser build and the pod-docs/ fallback (human decision, not in force until planned)
Context: both were open in [terminal-host.md](research/terminal-host.md).
Decision: keep the browser build as the agents' test bench for the non-terminal UI, with no Terminal tab. Keep reading `pod-docs/`, watch-only, until OpenAFlow develops itself with its own plugin; then remove it in its own plan.
Consequences: `CLAUDE.md` and the smoke recipe stay as they are.

## 2026-11-11 — A failed send raises its stop, on any run (human decision)
Context: queue entry 172. The toggle saves a stop's key before the send starts, so a send that failed to start raised no toast or dot, and the board never retries that key. The run waited, and nothing told the human.
Decision: the human's decision: the toggle keeps `lastFailed` beside `lastKey`. A send of that stop that fails to start, by the check or by a press, sets it. A send that starts clears it. While it is set, the stop is an item, on plan runs and fix runs alike.
Consequences: the item has its own key, `failed:<key>`, so the first failure of a stop sends a toast. A failed `answered` send leaves the toggle's `answeredKeys`, so the board may send it later. A send that starts and then stalls still has only its card. If the save of the mark fails, the stop stays quiet, as before.

## 2026-11-11 — A repo's first Board sends no toast (human decision)
Context: queue entry 150. About 15 toasts arrived at once when repos were added, because only the app's first Board was the toast baseline. Each added repo came on its own Board with up to 3 items, so the summary rule never applied.
Decision: the human's decision: a repo's first readable Board is its own baseline, and adding a repo sends no toast. A repo that leaves the Board and comes back is a fresh add. A repo whose id changes reads as a new repo, so its open items stay quiet.
Consequences: the tray dot and the run cards still show a new repo's items. A real new item that arrives while a repo is off the Board sends no toast when it comes back. A read error isn't a leave, because the Board still lists the repo.

## 2026-11-12 — /pod:task runs are one-off runs, as fix runs are
Context: pod 0.10 renamed `/pod:fix` to `/pod:task`. Its claim and branch are `task-<slug>`, and its reviewer gets `kind: task`. OpenAFlow knew only `fix-<slug>` and `kind: fix`, so a `/pod:task` run showed nothing. This extends the 2026-10-20 "fix runs on the board" decision.
Decision: a claim `task-<slug>` that names no plan is a one-off run, with the same rules as a `fix-<slug>` run, and a `task` tag. A reviewer of `kind: task` or `kind: fix` joins either kind of run, and is never a plan's agent. An engineer's `branch name` field comes before a `branch` field.
Consequences: old `fix-<slug>` runs work as before. Reply keys stay `fix-merged:<pr>`, so saved auto-continue keys don't send again. A `Branch:` sentence in a reviewer's task text can still set its branch; the reviewer still joins its run by its PR number.

## 2026-11-13 — The auto tag in two-column sidebar cards (agent default — override anytime)
Context: in a two-column sidebar card (sidebar 324 px or wider, or stacked at 375 px), `DESIGN.md` keeps the 88 px status column for the status only, so the `auto` tag can't sit after the status as the ui-rework pick drew. As built: `pod-docs/design-drafts/ui-rework-auto-tag-two-column.png`.
Decision: keep it under the status, inside the status column. In the default 260 px sidebar it sits right after the status.
Options not chosen: widen the status column (every card's rail moves); put the tag after the title (it leaves the status it describes).

## 2026-11-13 — Forget on a run whose PR waits on your merge (agent default — override anytime)
Context: review round 1 of PR #108 found that Forget this run shows on any claim-only run that isn't running, including a `/pod:task` run whose PR waits on your merge. Forget then takes the run and its waiting PR off the board, and frees a port base a live session may still hold.
Decision: keep Forget there. The modal names the run and asks first.
Options not chosen: hide Forget while a run has a waiting PR (safer, but a stuck run with a stale PR could then never be forgotten from the app).

## 2026-11-13 — Add repo: Browse… beside the field, path errors under it (human decision)
Context: on Linux, the H2/H3 modal felt wrong: `Choose folder…` on its own row read as a second field, and a path error showed twice (a red field and a red box). The human picked from `pod-docs/design-drafts/add-repo-error-choices.html`: "1 b, 2 b", and asked for less tight spacing than 2 b drew.
Decision: `Browse…` (the folder icon) sits at the right of the path field, on its row, in the desktop app only. A path error ("already added", "not a folder") shows as red text with the alert icon under the field, with no box. A system error (try again, reload, the folder dialog failed) stays in the shared alert box above the actions; Remove repo and Forget keep the box. The modal spaces its groups 16 px apart and the actions 24 px below (the draft: 8 px and 20 px).
Options not chosen: `Choose folder…` on its own row under the field (1 a, read as a second field); a folder icon inside the field (1 c, no label, easy to miss); every error in the red box (2 a, a path error shows twice).
Consequences: the inline error text is `--danger`, not `--blocked`, because `tokens.test.ts` keeps status colours off text; in dark the two are the same red.

## 2026-11-14 — Add repo: the modal opens first, and Browse… fills the field (human decision)
Context: on Linux, the desktop app's `Add repo` opened the system folder dialog at once. Cancel there closed everything, and the path field showed only after an error. The human expected an Add repo modal first, where they can type the path or browse for it. GitHub Desktop's "Add local repository" works this way: a path field with **Choose…** beside it, then **Add repository**. Users filed bugs against picker-only flows (T3 Code, the Claude desktop app). The human picked "a, fill the field and press Add".
Decision: in the desktop app, `Add repo` opens the same modal as the browser build: an empty path field with focus, `Browse…` beside it, then Cancel and Add. `Browse…` opens the folder dialog. A picked folder fills the field, clears any error, and posts nothing; focus moves to Add. Cancel in the folder dialog leaves the modal as it was, with focus on `Browse…`. A dialog that fails shows its message in the alert box and keeps the modal. After a failed dialog or a refused Add, focus goes to the field (agent default: Add is off while busy, so it loses focus). `DESIGN.md` "Forms and errors" now says: open a form with its field first, and a picker button never submits by itself.
Options not chosen: open the folder dialog at once, as before (no way to type a path, and Cancel closes everything); `Browse…` adds the picked folder at once (b: one press less, but the path is never shown before it posts, and it breaks the form rule).
Consequences: adding a repo by picking takes one more press (Add, or Enter). A dialog failure puts focus in the field, so you can type the path at once.
