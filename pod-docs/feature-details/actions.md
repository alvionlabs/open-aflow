# Actions

## What it is

Board actions change something outside the board: merge a PR that waits on you (a handed-back wave PR, a reviewed fix PR, or the final plan PR), append your answer to a queue entry that waits on you, and resume a run with `continue` or `go` (see [resume.md](resume.md)). Every merge, answer, and resume request that passes its checks goes in the action log, and so does each repo removed from the board (Remove repo, [server.md](server.md)). Server side: `packages/server/src` (the action, answer, and queue-writer modules); the routes sit behind the action guard ([server.md](server.md)). The screens are in [runs-and-pipeline.md](runs-and-pipeline.md).

## How it works

- **Target from the Board, never from the body.** A request names `repoId` and a PR number or a queue line; the server looks both up on the current Board. A PR must be in the model's `waitingPrs`, an entry must be `isAnswerable`, else `404 not waiting on you`. No `gh` command or file write runs before the checks pass. One merge per repo and PR, and one answer per repo, at a time (`409`).
- **Merge preview:** `gh pr view` gives title, head sha, mergeability, and checks for the confirm step.
- **Merge:** a fresh read first. A failed read → `failed`, no merge. A head that moved since the confirm → `stale`, no merge. Else exactly `gh pr merge <url> --merge --match-head-commit <sha>` (merge commit; never `--admin`, `--auto`, `--squash`, or `--delete-branch`), then a re-read decides the result:
  - `merged` only when GitHub says `MERGED`; `auto-merge` when auto-merge is on; `queued` only when GraphQL shows a merge-queue entry.
  - `unconfirmed` when the call succeeded but GitHub doesn't show a result yet; `failed` with gh's trimmed stderr, or `PR is closed`.
- **Answer:** the text is cleaned (control characters dropped, whitespace folded to one line, at most 2000 characters, no `**Resolution:**` or `**Answer (` of its own; see [run-model.md](run-model.md)), then appended to the end of the entry's one line as ` **Answer (human):** <text>`. The writer works on bytes: it splices that one line and keeps line endings, BOM, and other bytes as they were. It writes a temp file beside the queue, reads the queue again, and renames only if nothing changed. Results: `answered`, `changed` (entry gone, duplicated, or the file changed while saving), or `failed`.
- **Resolve (Close and Keep):** `POST /api/actions/resolve` with `repoId`, `line`, and `kind` (`close` or `keep`); any other field counts for nothing. The entry must be `isAnswerable` (`404 not waiting on you`), and the server's own `triage` of it must give a Done reason for `close` or a value for `keep` (`409` with `The board no longer reads this entry as done.` or `This entry states no value in use.`). The writer rewrites the line's `**Resolution:** pending` to `**Resolution:** <local date> — closed from the board: <reason>` or `— kept: <value>`, with the answer's path and guards; a line that no longer reads as pending is `changed`. It shares the answer's one write per repo (`409 answer in progress`). Results: `closed`, `kept`, `changed`, or `failed`, logged as `resolve` with the entry's header as the target.
- **Where you press it:** Merge and Answer sit on the Next step card, or on a row in the Waiting tab, and open in place under it; the Action log is in the Log tab. Continue and Go sit on a reply ([runs-and-pipeline.md](runs-and-pipeline.md)).
- **Path:** exactly `<repo>/pod-docs/handoff-queue.md`, whose real path must sit under the repo's real path. A missing file is never created.
- **Action log:** one JSON line per logged request in `<config dir>/actions.jsonl`, never in a repo. Merge, answer, resolve, resume, and remove-repo entries (`removed` or `failed`, the target is the repo's path) each pair an `action` with its own results; the reader drops lines that don't fit. `Board.actions` is the newest 50; after each logged action the server rebuilds the Board and sends it before it answers. A failed append gives `logged: false`.

## Why it's this way

- **`merged` only from the re-read** ([plan](../plans/board-actions.md#key-decisions)): gh's exit code doesn't say what happened; a timeout can still merge and a success can mean queued. Turned down: trusting the exit code.
- **`queued` only from a merge-queue entry:** gh 2.92's `pr view --json` has no merge-queue field, and an open PR after a successful call can also be a lagging re-read. Calling that `queued` would be false, so it reads `unconfirmed` (merge-actions wave 2 fix).
- **`--match-head-commit`:** merges only the commit you saw, so a push after the confirm (autopilot racing you, say) is refused as `stale`.
- **The board writes only the queue file, one answer line** ([plan](../plans/board-actions.md#key-decisions)): this changes phase 1's "never writes into a repo" rule as little as possible. Turned down: editing plans, sprint docs, or the entry body.
- **Build answers before pod reads them** ([decision](../decisions.md#2026-10-21--build-queue-answers-before-pod-reads-them)): the board wrote the master plan's format first; claude-pod 0.8.0+ (claude-pod #96) now reads it at wave start and on resume, so the form says to answer here, then Continue, with no chat step. On a fix run or repo row it says the next `/pod:code` wave reads it instead, since `/pod:fix` reads no answers.
- **A write by pod wins:** the re-read before the rename turns a race into `changed` instead of losing pod's line.
- **Retry only on `EPERM` and `EBUSY`:** on Windows an editor or a scanner can hold the file for a moment; other codes won't pass on a retry.

## Watch out

- Tests and smoke runs never merge a real PR (a fake gh exec; the smoke recipe checks only refusals) and never answer a real repo's queue.
- In the GraphQL call, owner and name go with `-f` (raw); `-F` would turn `123` into a number or `@file` into a file read.
- Git Bash mangles `→` in command arguments: send an answer body from a UTF-8 file (`--data-binary @body.json`).
- The answer clears nothing: the entry stays `needs you` until pod reads the line and resolves it.
- A queue body can quote `**Answer (human):**` (pod's own gate entries do). Only a marker after the entry's `**Resolution:**` is an answer.
- `actions.jsonl` sits in the watched config folder, but the filter keeps only `config.json`, so the route rebuilds the Board itself.
- The rename gives the queue a default file mode. The log is read once at start and never trimmed.

## History

- 2026-10-21 · merge-actions M1: merge-preview and merge routes, gh merge with a re-read, and the action log on the Board.
- 2026-10-21 · merge-actions wave 2 fix: `queued` only when GraphQL shows a merge-queue entry; an open PR after a successful call is otherwise `unconfirmed`.
- 2026-10-21 · queue-and-replies A1: the answer route, the queue writer, and answer entries in the action log.
- 2026-10-22 · resume-runs S1: resume entries in the action log.
- 2026-10-22 · board-actions · plan complete: merge, answer, and resume actions with one action log; final PR #33 passed review at round 2 after fix PR #34, which made a quoted answer marker count only after the Resolution · [report](../reports/board-actions.html)
- 2026-10-27 · fix-answer-note · the Answer form note now says to answer here, then Continue; claude-pod #96 reads the line, so no chat step. On a fix run or repo row it says pod reads it when a `/pod:code` run next starts a wave.
- 2026-10-28 · calm-dashboard · Merge and Answer moved to the Next step card and the Waiting tab, the Action log to the Log tab; the routes didn't change; final PR #54 passed review at round 1 · [report](../reports/calm-dashboard.html)
- 2026-10-31 · fix-queue-triage · added: the resolve route (Close and Keep) and `resolve` entries in the action log; the queue writer can rewrite an entry's pending Resolution as well as append an answer. The PRs the server asks gh about now include the staging PR a pending gate 7 entry names.
- 2026-10-31 · fix-queue-triage review round 1 · fixed: a staging PR asked by number (a pending gate 7 names it) no longer hides the same PR found by the staging branch.
- 2026-11-01 · fix-remove-repo · added: `remove-repo` entries (`removed`, `failed`) in the action log.
