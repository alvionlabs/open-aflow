# Engineer view

## What it is

Screen 3. With a slice open on the wave board (`#/<repoId>/<plan>/board/<code>`), the engineer view sits under the board frame: the slice's engineer, its details (branch, files owned, tests first, last active, model, tokens), and a live tool timeline of tool names and short summaries. Covers the features.md rows Engineer view and Engineer view shows no secrets. A fix run's engineers open the same view under its agent log (`#/<repoId>/task-<slug>/agent/<id>`, or `fix-<slug>` from older pod), headed by their role and the slug, with Files owned `not listed` (a fix has no slice). Rules in `packages/web/src/screens/engineer/view.ts`, fetching in `timeline-loader.ts`; the timeline itself is built by the model's `parseAgentTimeline` and served by `GET /api/agents/:repoId/:agentId/timeline`.

## How it works

- **The engineer** is the latest-started engineer agent whose role is this slice of the shown sprint. None → `No engineer has started on this slice yet.`
- **Details:** branch (the agent's, else the slice's), files owned from the sprint doc, `Tests first` as `yes`/`no` then `<k> test files · <r> runs · last passed|failed` (unknown parts left out), last active (`s ago`, `min ago`, `h ago`, `ended HH:MM`), model, tokens. A disabled `Step in (phase 3)` button.
- **Timeline:** one row per tool call, `HH:MM`, summary, `→ ok` or `→ failed`; the server keeps the newest 300 and the view says how many earlier steps aren't shown. 404 → `No transcript found for this engineer.`; a load error keeps the last timeline under a `stale` chip.
- **Summaries** come only from the tool name, repo-relative paths, a known program and subcommand (`Bash: pnpm test`), a host for WebFetch, or a fixed word. Never prompts, assistant text, thinking, tool output, command arguments, patterns, or edit contents.
- **Loader:** fetches only when the key `{ repoId, agentId, lastAt, ended }` changes; one request in flight; an older response is dropped.

## Why it's this way

- **Names and short summaries only**, not raw output with masking: transcripts can hold secrets, and masking is never complete. Plan Key decision; checked with a planted fake secret in every field.
- **Fixed word lists for shell commands:** only programs that take subcommands show one, so `echo test` reads `echo`, not a test run. An earlier rule counted any `test` word (`runs: 4` for one real run).
- **No polling:** a transcript write moves the agent's `lastAt` on the Board, which already arrives over SSE, so each board event that moves it gives one fetch. The server caches the file by size and mtime.
- **No Open worktree button**: it's an action, and actions start in phase 2.

## Watch out

- File paths a tool touched are shown by design, so a secret that is itself a file name shows. Nothing else from the transcript should.
- Any new word added to a summary list must be safe to show. A program not on the list never shows a subcommand and never counts as a test run; `pnpm run test:unit` and `npx -p pkg vitest` don't count.
- An error isn't retried for the same key: an ended agent with a failed load stays on the note until reload or reopening the slice.
- The timeline follows `lastAt`, which moves only on records with a timestamp.
- An engineer shows only when `readDispatch` reads its sprint and slice from the dispatch (see `run-model.md`). chess-web's own prompt shape (``Build slice R1 of sprint `refresh` ``, `- Slice: R1, …`) reads nothing, so those slices say no engineer has started. The board reads only pod's field names by an agent default ([decision](../decisions.md#2026-10-20--engineer-dispatch-fields-pods-names-only-agent-default--override-anytime)); a new shape goes in `dispatch.ts` with a corpus check.
- Agents on the Board carry no `description` since plan fix 2; never show or add it back.
- An agent continued with SendMessage reads `ended` only after it hands back again, so its Last active and live timeline follow its newest turn.

## History

- 2026-10-19: added in sprint board-engineer (slice E1).
- 2026-10-19 · board-read · plan complete; review found the planted secret in no page, timeline, or Board JSON · [report](../reports/board-read.html)
- 2026-10-19 · board-read fix 2: agent descriptions dropped from `/api/board` · [#17](https://github.com/iamphduc/pod-board/pull/17)
- 2026-10-19 · board-read fix 3: engineers dispatched with unmarked or `·`-joined fields show on their slice again · [#18](https://github.com/iamphduc/pod-board/pull/18)
- 2026-10-20 · fix-show-fix-runs round 2: a continued engineer reads running again while it works, so the view's Last active and timeline follow it.
- 2026-10-20 · fix-show-fix-runs: a fix run's engineers open this view from its agent log; the view takes a heading and an optional slice instead of a wave board card.
- 2026-10-20 · board-read · final review passed at round 5; the planted secret was absent again · [report](../reports/board-read.html)
