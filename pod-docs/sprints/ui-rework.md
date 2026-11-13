# Sprint: UI rework

_From plan: pod-docs/plans/ui-rework.md · Slug: ui-rework · Status: active · Generated: 2026-11-12_

<!-- autopilot-run: started=2026-11-12T21:22:21-08:00 sprints=0 waves=1 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | L1 | Look: shared modal and the "what happened" list | ui-rework-L1 | — | pending | — | — |
| 1 | R1 | PR open time, review-skip marker, Merge for no-review PRs | ui-rework-R1 | — | pending | — | — |
| 1 | F1 | Forget run: model check, route, and log line | ui-rework-F1 | — | pending | — | — |
| 1 | D1 | Desktop folder bridge (preload + IPC) | ui-rework-D1 | — | pending | — | — |
| 2 | N1 | Next step card: list, merge panel closes, Sending… | ui-rework-N1 | — | pending | — | L1 |
| 2 | M1 | Runs list: last activity, newest first | ui-rework-M1 | — | pending | — | R1 |
| 2 | K1 | Remove repo and Forget in the modal; `auto` tag | ui-rework-K1 | — | pending | — | L1, F1 |
| 2 | A1 | Add repo: Windows dialog or path field; picker and folder route gone | ui-rework-A1 | — | pending | — | L1, D1 |

## Shared contract

1. **Board PR fields (R1).** `PrStatus` (`packages/model/src/board.ts`) gains two fields:
   - `openedAt?: number`: gh's `createdAt` as epoch ms, on every PR read. A missing or bad value leaves it unset.
   - `reviewSkipped?: true`: only on a PR found by branch whose body holds the exact text `skipped (--no-review)`. Pod's PR template writes that text for a `/pod:task --no-review` PR. `body` joins `LIST_FIELDS` and is reduced to this flag at parse. The text never reaches the Board or a log. Any match in the body counts.
2. **Merge for no-review PRs (R1).** `fixWaitingPr` returns an `open` PR in two cases:
   - It is reviewed (today's rule).
   - It has `reviewSkipped`, the run has an engineer turn, the newest engineer turn is `ended`, and no reviewer joined the run.

   In the second case, the run reads `needs-you`, and where reads `PR`. The Ship step reads `PR #N · you merge`, with `merge`. Round 1 reads state `skipped`, detail `skipped · --no-review`. With no flag, an ended engineer with no reviewer still reads `review · idle`. The merge routes use `waitingPrs`, so the routes need no change.
3. **Last activity and order (M1).** `runActivity(repo, run: RunSummary): number | undefined` is exported from `runs.ts`. `RunSummary` keeps its shape. It is the newest of three sources:
   - the run's agents' `lastAt`: `isPlanAgent` for a plan, `fixRunAgents` for a one-off run
   - the `date` of each queue entry whose `plan` is the run, read as `Date.parse('<date>T00:00:00Z')`
   - `openedAt` and `mergedAt` of the run's PRs: a plan's slice PRs in all its sprints, its hand-back PR, and the PR on branch `<plan-slug>`; a one-off run's `fixPr`

   An error, `update pod`, or `no active plan` row has none. `listRuns` sorts newest first. Rows with none come last. Ties go to repo name, then plan slug. State doesn't order the list, and the order never reads `now`. Selection is by hash, so a run that moves stays selected.
4. **Forget check (F1).** `packages/model/src/forget.ts` is exported from `index.ts`:
   `forgetCheck(repo: BoardRepo, run: string, now: number): { ok: true; portBase: number } | { ok: false; reason: 'not a run' | 'no claim' | 'run is running' | 'still listed' }`.
   Its checks run in this order:
   1. The run isn't in `listRuns` for this repo → `not a run`.
   2. No claim has `plan === run` → `no claim`.
   3. The run's state is `running` → `run is running`.
   4. Two or more such claims, or the run would still be listed with its claims taken out → `still listed`.
5. **Forget route (F1).** `POST /api/actions/forget-run`, behind the action guard. The body is `{ repoId: string, run: string, portBase: number }`.
   - A bad shape, or a `portBase` that isn't an integer from 1 to 65535 → `400 bad request`.
   - No repo with that id → `404 not on the board`. Two repos with that id → `409 ambiguous repo`.
   - A failed `forgetCheck` → its reason: `409` for `run is running`, `404` for the others. A `portBase` that differs from the checked one → `404 no claim`.
   - The file `<ports dir>/<portBase>` is read again. Its name is built from the integer only.
     - Missing → `404 no claim`, then a rebuild.
     - It no longer parses to this repo (`sameRepoPath`) and run → `409 claim changed`, and nothing is deleted.
   - The server deletes that one file. A delete error → `500 claim unremovable`, logged as `failed` with the error code.
   - Success: log `{ action: 'forget-run', repoId, repo, target: '<run> · port base <N>', result: 'removed' }`, rebuild, then `200 { outcome: 'removed', run, portBase, logged }` (`ForgetRunResult`).
   - Refusals aren't logged.
   - It never runs git. It never touches a worktree, a branch, the config, or a toggle. A toggle stays and sends nothing while the run is off the Board.
   - `ActionEntry` gains `{ action: 'forget-run'; result: 'removed' | 'failed' }`. These are existing result words, so the web's `OUTCOME_CLS` doesn't change.
6. **Folder route removed (A1).** `GET /api/fs/folders`, the `/api/fs/*` read guard, the `folders` dep, and `folder-list.ts` go. The path then answers 404 JSON in dev and in production, with or without the token. `web-app.ts` already 404s `/api/*`.
7. **Desktop folder bridge (D1 ↔ A1).**
   - The preload `packages/desktop/src/preload-main.ts` is bundled to `dist/preload.cjs`. Through `contextBridge`, it exposes only `window.openaflow = { pickFolder(): Promise<string | null> }`.
   - The IPC channel is `openaflow:pick-folder`. Only the window's main frame on the current server origin (`flow.origin()`) may call it. Any other caller gets a rejection with `forbidden`, and no dialog opens: another origin or port, `file:`, `about:blank`, a subframe, or a call before the server has an origin.
   - The dialog is `dialog.showOpenDialog(<app window>, { title: 'Add repo', properties: ['openDirectory'] })`. Cancel, or no path → `null`. Else the first path.
   - A call while a dialog is open → `null`. A dialog error → a rejection with `dialog failed`.
   - `webPreferences` keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`, and add `preload`.
   - The web reads the bridge only through `packages/web/src/desktop-bridge.ts`: `folderBridge(): (() => Promise<string | null>) | undefined`. In the browser build it returns undefined.
8. **Shared modal (L1)**, in `packages/web/src/components/`.
   - `Modal({ labelledBy, busy, onClose, className?, children })` is a native `<dialog>` opened with `showModal()`. That makes the page inert and turns Escape into `cancel`.
   - `cancel` and a backdrop press call `onClose`, except while `busy`. A backdrop press counts only when `backdropClose(down, click, up)` is true for all three, as in today's `add-dialog.ts`.
   - `ConfirmModal({ heading, detail, mono?: string[], notes?: string[], confirmLabel, busy, status?, error?, onConfirm, onCancel, returnFocusTo })` shows the heading, the detail, the `mono` lines, the muted notes, the status (`role=status`), and the error (`role=alert`), then Cancel (quiet) and the confirm (danger).
   - Busy disables both buttons.
   - On close, focus goes to `#returnFocusTo`, unless focus moved elsewhere.
9. **"What happened" list view (L1).** `StopList({ items: { key; label; time; state: 'done' | 'current'; note? }[] })` is an `<ol aria-label="What happened">` with a thin left rule.
   - A done item has a `--ready` ring and ` · <time>`.
   - The current item has a filled `--needs-you` dot and `— now`.
   - Text is in `--fg` or `--muted`.
   - Empty → nothing.
10. **"What happened" list rules (N1).** The list lives in `NextStepCard` state (`stop-log.ts`). Only the card's own results add items.
    - **Merge:** a `merged` reply adds `Merged PR #N · HH:MM`, and the merge panel closes. Other outcomes keep today's panel.
    - **Continue or Go:** a `started` reply adds `Sent continue · HH:MM` (or `go`). Its note is `startedText`, plus `Not saved to the action log.` when it isn't logged. A failed send adds nothing.
    - **Current item:** `pod runs` after a sent item. Otherwise it names the card's next action: the reply row's button label (`Continue`, `Go`), else the card title.
    - **Until the Board catches up:** the card can still name a PR the list shows as merged. Then the current item reads `Updating…`, and that card's Merge button is hidden.
    - **When it shows:** the list needs a done item. It resets on the first Board where the run's state leaves `running`, and on a run switch. Automatic sends add nothing.
    - **In flight:** the send button reads `Sending…`.
    - `HH:MM` is local time.
11. **`auto` tag (K1).** A sidebar card whose run is on in `Board.autoContinue` (`switchView`) shows `<span class="chip tag">auto</span>` right after its status, and its link's name gains `auto`.
12. **Checks on this host.** Run `pnpm verify`. For look checks, use the mock repo named in `CLAUDE.local.md` with the env from `CLAUDE.md`. The mock has no PRs or agents. Merge and Continue run on a fixture copy with the smoke recipe's stub `gh` and `fake-claude.mjs`. Run `agent-browser` from PowerShell, one command per call, with a time limit. Real Electron tests are `real-*.test.ts`, run by `pnpm test:electron` after `pnpm build`.

## Per-slice detail

### L1: Look: shared modal and the "what happened" list
- **Scope:** Contract items 8 and 9, with no callers yet. Existing tokens and Geist fonts only: no new colour, font, or token. The modal is centred on a dimmed page, and its panel is on `--surface`. At 375 px it fills the width less the page margin.
- **Files owned:** `packages/web/src/components/Modal.tsx` (new), `packages/web/src/components/modal.ts` (new), `packages/web/src/components/ConfirmModal.tsx` (new), `packages/web/src/components/StopList.tsx` (new), `packages/web/src/components/modal.css` (new), `packages/web/src/components/stop-list.css` (new), `packages/web/src/components/modal.test.ts` (new), `packages/web/src/components/look.test.ts` (new)
- **Success criteria:**
  - `[test] a backdrop press closes only when down, click, and up all hit the dialog — modal.test.ts › backdropClose needs all three`
  - `[test] while busy, cancel and a backdrop press don't call onClose — modal.test.ts › busy keeps the modal open`
  - `[test] the confirm is a dialog named by its heading, with mono lines, then Cancel and the danger button — modal.test.ts › confirm markup and button order`
  - `[test] busy disables both buttons; status is role=status; error is role=alert — modal.test.ts › busy and error states`
  - `[test] focus returns to returnFocusTo unless something else took it — modal.test.ts › focus goes back to the opener`
  - `[test] StopList shows done items with time, the current one with "— now", and nothing when empty — modal.test.ts › stop list items`
  - `[test] modal.css and stop-list.css use only var(--…) tokens, with text in --fg or --muted — look.test.ts › tokens only`
  - `[test] --fg and --muted reach 4.5:1 on --surface and --bg, dark and light — look.test.ts › text contrast`
  - `[manual] the modal and the list match draft picks 3 c and 6 c at desktop width and at 375 px, dark and light (a scratch page, removed after)`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### R1: PR open time, review-skip marker, Merge for no-review PRs
- **Scope:** Contract items 1 and 2: `gh.ts` fields and parsing, and the `fix-runs.ts` rule. Update the fix-run rule in `runs-and-pipeline.md`.
- **Files owned:** `packages/server/src/gh.ts`, `packages/server/src/gh.test.ts`, `packages/model/src/board.ts`, `packages/model/src/fix-runs.ts`, `packages/model/src/fix-runs.test.ts`, `packages/model/src/waiting-prs.test.ts`, `packages/server/src/action-routes.test.ts`, `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] view and list ask for createdAt; only list asks for body — gh.test.ts › PR fields ask for createdAt, and body by branch`
  - `[test] createdAt sets openedAt; null or bad text leaves it unset — gh.test.ts › openedAt from createdAt`
  - `[test] the marker anywhere in the body sets reviewSkipped; null, other text, or another case doesn't; no body text is kept — gh.test.ts › reviewSkipped from the body`
  - `[test] a flagged open PR with an ended engineer and no reviewer: needs-you, where PR, you merge with merge, Round 1 skipped — fix-runs.test.ts › no-review PR gets Merge`
  - `[test] the same PR with the engineer running or stale isn't waiting — fix-runs.test.ts › no-review PR waits while its engineer works`
  - `[test] with no flag, an ended engineer and no reviewer still read review · idle — fix-runs.test.ts › an open PR waits for its review` (kept)
  - `[test] a flagged PR with a reviewer follows the reviewed rule — fix-runs.test.ts › a reviewer overrides the skip flag`
  - `[test] waitingPrs lists it as kind task — waiting-prs.test.ts › no-review task PR is waiting`
  - `[test] merge-preview accepts it — action-routes.test.ts › no-review PR can be previewed`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### F1: Forget run: model check, route, and log line
- **Scope:** Contract items 4 and 5. Mount the route in `start-server.ts` beside `remove-repo`, and read `forget-run` lines in `action-log.ts`. No UI. Document it in `actions.md` and `server.md`, and add a smoke curl.
- **Files owned:** `packages/model/src/forget.ts` (new), `packages/model/src/forget.test.ts` (new), `packages/model/src/actions.ts`, `packages/model/src/index.ts`, `packages/server/src/forget-run-routes.ts` (new), `packages/server/src/forget-run-routes.test.ts` (new), `packages/server/src/action-log.ts`, `packages/server/src/action-log.test.ts`, `packages/server/src/start-server.ts`, `pod-docs/feature-details/actions.md`, `pod-docs/feature-details/server.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] a merged fix run with ended agents and one claim is ok with its port base — forget.test.ts › leftover fix run can be forgotten`
  - `[test] each reason in order: not listed, no claim, running agent, two claims, a live plan still listed without its claim — forget.test.ts › refusal reasons`
  - `[test] a claimed archived plan closing out can be forgotten — forget.test.ts › closing-out plan run`
  - `[test] success deletes only <ports>/<portBase>, logs forget-run removed, rebuilds, replies 200 — forget-run-routes.test.ts › forgets one claim`
  - `[test] other claim files and the repo folder stay byte-identical — forget-run-routes.test.ts › touches nothing else`
  - `[test] a bad body, or a portBase of 0, 65536, 1.5, or "../x", gives 400 and deletes nothing — forget-run-routes.test.ts › bad requests`
  - `[test] a claim rewritten to another repo or run gives 409 claim changed and stays — forget-run-routes.test.ts › claim changed`
  - `[test] a repeat after success gives 404 and logs nothing — forget-run-routes.test.ts › repeat`
  - `[test] a running run gives 409 run is running — forget-run-routes.test.ts › running run`
  - `[test] a delete error gives 500 claim unremovable, logged failed — forget-run-routes.test.ts › delete fails`
  - `[test] no token gives 403; a GET gives 404 — forget-run-routes.test.ts › behind the action guard`
  - `[test] a forget-run line is read back; an unknown result is dropped — action-log.test.ts › forget-run lines`
- **Depends on:** —
- **One-way door:** Yes. Forget deletes a run's port claim file. Pod wrote that file in the temp port claims folder, and the app can't bring it back. To undo one Forget by hand, create the file again: its name is the port base, and its one line is the repo path, a space, and the run name. The Forget modal shows all three. To remove the feature, revert the slice's merge commit.
- **Model:** opus

### D1: Desktop folder bridge (preload + IPC)
- **Scope:** Contract item 7, main-process side. The rules live in plain `folder-bridge.ts` (the sender check, one dialog at a time, and the result mapping), tested with fakes. Only `preload-main.ts`, the `ipcMain.handle` glue in `window-main.ts`, and a test probe import Electron. Bundle the preload as a second entry, and add it to the packaged files. Update `desktop.md`.
- **Files owned:** `packages/desktop/src/folder-bridge.ts` (new), `packages/desktop/src/folder-bridge.test.ts` (new), `packages/desktop/src/preload-main.ts` (new), `packages/desktop/src/window-main.ts`, `packages/desktop/src/window-rules.ts`, `packages/desktop/src/window-rules.test.ts`, `packages/desktop/src/build-config.ts`, `packages/desktop/src/build-config.test.ts`, `packages/desktop/src/bundle-desktop.test.ts`, `packages/desktop/scripts/bundle.ts`, `packages/desktop/scripts/package.ts`, `packages/desktop/scripts/real-tests.mjs`, `packages/desktop/test/bridge-probe-main.ts` (new), `packages/desktop/src/real-folder-bridge.test.ts` (new), `pod-docs/feature-details/desktop.md`
- **Success criteria:**
  - `[test] the main frame on the current origin opens one dialog with the window as parent and openDirectory — folder-bridge.test.ts › allowed caller opens the dialog`
  - `[test] cancel or no path gives null — folder-bridge.test.ts › cancel is null`
  - `[test] another port, file:, about:blank, a subframe, or no origin yet rejects with forbidden and opens nothing — folder-bridge.test.ts › refuses other callers`
  - `[test] a call while a dialog is open gives null; one dialog opens — folder-bridge.test.ts › one dialog at a time`
  - `[test] a dialog that throws rejects with dialog failed, and the next call works — folder-bridge.test.ts › dialog error`
  - `[test] webPreferences keep contextIsolation, sandbox, no nodeIntegration, and name the preload — window-rules.test.ts › window options with the preload`
  - `[test] the preload bundle imports only electron — bundle-desktop.test.ts › preload bundle`
  - `[test] the packaged files hold dist/preload.cjs — build-config.test.ts › files`
  - `[test] in real Electron the page sees exactly openaflow.pickFolder and no require — real-folder-bridge.test.ts › the page sees only pickFolder`
  - `[manual] in the desktop shell, the Windows Select Folder dialog opens in front of the app window (automation can't reach a native dialog)`
- **Depends on:** —
- **One-way door:** Yes. The app window gets its first bridge to the main process. The page can now ask Electron to open a folder dialog and read the chosen path, and nothing else. To undo, revert the slice's merge commit.
- **Model:** opus

### N1: Next step card: list, merge panel closes, Sending…
- **Scope:** Contract item 10, drawn with L1's `StopList`, plus three hooks:
  - `createMergeFlow` takes an optional `onMerged(number, at)`. With it, a `merged` reply calls it and goes `idle`.
  - `ReplyPanel` takes an optional `onSent(word, at, result)`. With it, a `started` reply shows no result block.
  - After the panel closes, focus goes to the card's primary button, else the card title (`focusAfterMerge`).

  Without the hooks, as in the Waiting tab, nothing changes except the `Sending…` label. Don't edit `runs.css` or `WaitingTab.tsx`. New rules go in `next-step.css`. Document the card in `resume.md`.
- **Files owned:** `packages/web/src/screens/runs/NextStepCard.tsx`, `packages/web/src/screens/runs/MergeConfirm.tsx`, `packages/web/src/screens/runs/merge-flow.ts`, `packages/web/src/screens/runs/merge-flow.test.ts`, `packages/web/src/screens/runs/ReplyPanel.tsx`, `packages/web/src/screens/runs/resume-flow.ts`, `packages/web/src/screens/runs/resume-flow.test.ts`, `packages/web/src/screens/runs/stop-log.ts` (new), `packages/web/src/screens/runs/stop-log.test.ts` (new), `packages/web/src/screens/runs/next-step.css` (new), `packages/web/src/screens/runs/waiting-tab.test.ts`, `packages/web/src/screens/runs/tab-panels.test.ts`, `pod-docs/feature-details/resume.md`
- **Success criteria:**
  - `[test] merged adds "Merged PR #N" with HH:MM; the current item is the card's next action — stop-log.test.ts › merged item`
  - `[test] while the card still names the merged PR, the current item reads Updating… and Merge is hidden — stop-log.test.ts › before the Board catches up`
  - `[test] started adds "Sent continue" with its note; the current item reads pod runs; not logged adds the note — stop-log.test.ts › sent item`
  - `[test] a failed send, an error, or a queued, stale, or failed merge adds nothing — stop-log.test.ts › only results that happened`
  - `[test] the list resets on the first non-running state after running, and stays while running — stop-log.test.ts › resets at a new stop`
  - `[test] with no done item there is no list — stop-log.test.ts › hidden when empty`
  - `[test] focus after a merge goes to the primary button, else the title — stop-log.test.ts › focusAfterMerge`
  - `[test] with onMerged, merged calls it once and goes idle; without it, result as today — merge-flow.test.ts › closes on merged only when asked`
  - `[test] queued, auto-merge, stale, and failed keep the panel with onMerged set — merge-flow.test.ts › other outcomes keep the panel`
  - `[test] the sending row's button reads Sending… and every send button is off — resume-flow.test.ts › Sending label`
  - `[test] the Waiting tab keeps today's merge and reply results — waiting-tab.test.ts › waiting tab keeps its results`
  - `[manual] the card with its list after a merge and after a send matches draft pick 3 c, at desktop width and at 375 px`
- **Depends on:** L1
- **One-way door:** none
- **Model:** opus

### M1: Runs list: last activity, newest first
- **Scope:** Contract item 3 in `runs.ts`, from the Board's data only. Fix tests only where they pinned the old state-first order, and name each one in the hand-back. The banner's "earlier run in the sidebar" tie now follows the new order. `runs-screen.test.ts` is K1's this wave: an order pin there goes to the wave fix. Update the order rule in `runs-and-pipeline.md`.
- **Files owned:** `packages/model/src/runs.ts`, `packages/model/src/runs.test.ts`, `packages/model/src/fix-runs.test.ts`, `packages/model/src/autopilot.test.ts`, `packages/model/src/dispatch.test.ts`, `packages/model/src/run-model.test.ts`, `packages/model/test/fixtures.test.ts`, `packages/model/test/continued.test.ts`, `packages/web/src/selection.test.ts`, `packages/web/src/screens/runs/next-step.test.ts`, `packages/web/src/screens/runs/elsewhere.test.ts`, `packages/web/src/screens/runs/run-state-agreement.test.ts`, `packages/desktop/src/attention.test.ts`, `packages/server/src/board-service.test.ts`, `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] runActivity is the newest of agent lastAt, a tagged entry date, and PR openedAt and mergedAt — runs.test.ts › activity sources`
  - `[test] a one-off run uses only its own agents and fixPr — runs.test.ts › one-off activity`
  - `[test] a newer idle run sorts above an older blocked one — runs.test.ts › newest first, not by state`
  - `[test] rows with no activity come last, by repo name — runs.test.ts › no activity last`
  - `[test] equal activity ties go to repo, then plan — runs.test.ts › ties`
  - `[test] one Board at now and now + 10 min gives one order — runs.test.ts › order ignores now`
  - `[test] a selected run that moves stays selected — selection.test.ts › selection follows the hash`
  - `[test] the banner tie still picks the earlier run in the sidebar — elsewhere.test.ts › sidebar order tie`
- **Depends on:** R1
- **One-way door:** none
- **Model:** sonnet

### K1: Remove repo and Forget in the modal; `auto` tag
- **Scope:**
  - **Remove repo:** both the header ⋯ and a sidebar card's ⋯ open L1's `ConfirmModal`. It shows `Remove <name>?`, the detail "The board stops watching this folder. No files change.", the path as a mono line, and today's runs line or claim note. Errors and navigation stay as today. Delete `RemoveConfirm.tsx` and `.remove-confirm`, and stop passing `panelFor`.
  - **Forget this run:** a danger item above Remove repo in the header's ⋯. It shows only when `forgetCheck(...).ok`. The modal shows `Forget <run name>?` and the detail "The board stops listing this run. Its worktree and branch stay.". Its mono lines are the worktree path and `port base <N>`. The path is `<repo><sep>.claude<sep>worktrees<sep><run>` for a one-off run, or that folder for a plan run, with `<sep>` from the repo path.
  - `forget-flow.ts` holds the reducer, the post, a sentence for each route word, and `hashAfterForget`: next run, else previous, else empty.
  - Contract item 11.
  - Mark the leftover-run known issue fixed.
- **Files owned:** `packages/web/src/screens/runs/RunsScreen.tsx`, `packages/web/src/screens/runs/runs-screen.test.ts`, `packages/web/src/screens/runs/RunsList.tsx`, `packages/web/src/screens/runs/run-more.test.ts`, `packages/web/src/screens/runs/BarMenu.tsx`, `packages/web/src/screens/runs/bar-menu.test.ts`, `packages/web/src/screens/runs/menu-parts.tsx`, `packages/web/src/screens/runs/RemoveConfirm.tsx` (deleted), `packages/web/src/screens/runs/remove-flow.ts`, `packages/web/src/screens/runs/remove-flow.test.ts`, `packages/web/src/screens/runs/remove-css.test.ts`, `packages/web/src/screens/runs/runs.css`, `packages/web/src/screens/runs/forget-flow.ts` (new), `packages/web/src/screens/runs/forget-flow.test.ts` (new), `pod-docs/known-issues/leftover-run-cannot-be-removed.md`
- **Success criteria:**
  - `[test] the Remove view has the heading, detail, path line, and runs line or claim note — remove-flow.test.ts › modal view`
  - `[test] the header and sidebar ⋯ open one modal; no in-place remove panel is left — runs-screen.test.ts › one remove modal`
  - `[test] Forget this run shows only when forgetCheck is ok, as a danger item above Remove repo — bar-menu.test.ts › Forget item`
  - `[test] the Forget view names the run, the worktree path for Windows and POSIX repo paths, and the port base — forget-flow.test.ts › forget view`
  - `[test] Forget posts {repoId, run, portBase} once; a reply after cancel is dropped — forget-flow.test.ts › one request per confirm`
  - `[test] each route word maps to a sentence; an unknown word shows as is — forget-flow.test.ts › errors`
  - `[test] the page leaves a forgotten selected run, and stays on another open run — forget-flow.test.ts › hashAfterForget`
  - `[test] an auto-continue run shows the auto tag after its status and in its link name; off runs and repo rows don't — run-more.test.ts › auto tag`
  - `[manual] Remove repo and Forget open the same centred modal over a dimmed page, and the auto tag sits after the status, at desktop width and at 375 px`
- **Depends on:** L1, F1
- **One-way door:** none. F1 owns the delete, and this slice asks before it runs.
- **Model:** opus

### A1: Add repo: Windows dialog or path field; picker and folder route gone
- **Scope:** `AddRepoDialog` keeps its props, so `RunsScreen` doesn't change. Pure `add-repo-flow.ts` drives it.
  - **Bridge:** `pickFolder()` runs at once, with no modal while the Windows dialog is up. `null` closes it. A path posts through `postRepo`, and a 201 closes the dialog. An error opens L1's `Modal` with `errorSentence`, the path filled in, and Add, `Choose folder…`, and Cancel.
  - **Bridge fails:** a rejection opens the modal with "Couldn't open the folder dialog. Type the path instead."
  - **No bridge:** a path field with Add and Cancel. Add is off while the field is blank. The path is trimmed, and one post runs at a time.
  - **Deleted:** the picker, `add-dialog.ts`, the `picker.css` block in `runs-css.test.ts`, and contract item 6.
  - **Docs:** the smoke recipe's Folder listing and Add repo lines, and `server.md`.
- **Files owned:** `packages/web/src/screens/runs/AddRepoDialog.tsx`, `packages/web/src/screens/runs/add-repo-flow.ts` (new), `packages/web/src/screens/runs/add-repo-flow.test.ts` (new), `packages/web/src/desktop-bridge.ts` (new), `packages/web/src/desktop-bridge.test.ts` (new), `packages/web/src/add-repo.ts`, `packages/web/src/add-repo.test.ts`, `packages/web/src/screens/runs/FolderPicker.tsx` (deleted), `packages/web/src/screens/runs/folder-picker.ts` (deleted), `packages/web/src/screens/runs/folder-picker.test.ts` (deleted), `packages/web/src/screens/runs/picker.css` (deleted), `packages/web/src/screens/runs/add-dialog.ts` (deleted), `packages/web/src/screens/runs/add-dialog.test.ts` (deleted), `packages/web/src/screens/runs/runs-css.test.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/folder-list.ts` (deleted), `packages/server/src/folder-list.test.ts` (deleted), `pod-docs/codebase-structure.md`, `pod-docs/feature-details/server.md`
- **Success criteria:**
  - `[test] folderBridge returns the function only when window.openaflow.pickFolder is one — desktop-bridge.test.ts › bridge detection`
  - `[test] with a bridge: null closes with no post; a path posts once; 201 closes — add-repo-flow.test.ts › desktop pick`
  - `[test] with a bridge: 409 shows "Already registered." with the path and Choose folder… — add-repo-flow.test.ts › desktop add error`
  - `[test] a bridge rejection shows the type-the-path message and the field — add-repo-flow.test.ts › bridge fails`
  - `[test] with no bridge: blank keeps Add off; the path is trimmed; a second Add while posting sends nothing — add-repo-flow.test.ts › browser path field`
  - `[test] GET /api/fs/folders gives 404 JSON with and without the token, also with the web app mounted — app.test.ts › folder route is gone`
  - `[test] no source imports folder-list, FolderPicker, or folder-picker — app.test.ts › picker code is gone`
  - `[manual] the browser build's path-field modal at desktop width and at 375 px`
  - `[manual] in the desktop shell, Add repo opens the Windows Select Folder dialog, and the chosen folder shows in the sidebar (automation can't reach a native dialog)`
- **Depends on:** L1, D1
- **One-way door:** none. Only the app's own page used `GET /api/fs/folders`.
- **Model:** opus
