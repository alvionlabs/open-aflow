# Wave board

## What it is

Screen 2, at `#/<repoId>/<plan>/board`, opened from `Open the wave board` in the run header: the run header and `Back to the run` above one column per wave of the shown sprint, one card per slice with a status dot and word, grey dependency lines with the critical path in `--fg`, and filter chips with counts. `#/…/board/<code>` opens a slice and adds the engineer view below ([engineer-view.md](engineer-view.md)). Logic lives in `packages/web/src/screens/board/board-view.ts`, line placement in `geometry.ts`, routes in `selection.ts`.

## How it works

- **Shown sprint:** the plan's current sprint, else the last sprint with a doc. None, or no slices → `Sprint <s> isn't drafted yet.` (or `No sprint with a doc yet.`).
- **Columns** take their status from the pipeline's slice log for that wave; each card's row is that log's row.
- **Card state,** first match: `blocked` → `merged` → `needs-you` (an entry that holds the run (`holdsRun`) naming the slice, or its wave's PR in `waitingPrs`) → on a live wave, a stop on the whole plan (`isPlanHeld`) → `running` (`isSliceRunning`: a `pushed` slice pod holds, or its own or its wave's fix engineer at work) → on the wave in progress with nothing of its own running, the run's state (`blocked`, `needs-you`, `running`) → `waiting`. Meta: model, confidence, minutes; or the latest entry's text cut to 60 characters; else `PR #N · you merge` (`PR #N · autopilot stopped` on a halted autopilot run); or `needs <codes>`.
- **Look:** cards are plain, compact `.card`s; state is the dot and word only, never an edge. A card on the critical path gets a `--muted` frame, the open card a `--fg` frame on `--hover`, and focus a `--focus` outline.
- **Edges:** one per dependency on a slice of this board in an earlier wave, in `--border-strong`. **Critical path:** the longest chain by slice count, in `--fg`; a tie goes to the chain whose slices come first.
- **Lines** are SVG curves from one card's right edge to the next card's left edge, redrawn on board change, resize, and once fonts load.
- **Filters:** outlined toggle chips (dot and word); with any on, other cards dim in place, lines stay, and counts never change. The set clears when the shown sprint changes.
- **Keys:** cards are buttons; click, Enter or Space opens the slice; Escape closes it. At narrow widths the board scrolls sideways inside its frame, and the page stays 375 px wide.
- **Routes:** a hash naming no run → the first run; a code not on the board → the board with no slice; the corrected hash replaces the URL.

## Why it's this way

- **Reuse the pipeline's log** rather than recompute: screens 1 and 2 can't disagree.
- **Critical path in `--fg`, cards without colored edges** ([plan Look](../plans/calm-dashboard.md#look)): the calm-dashboard look rules out colored edges and fills; white on black is the strongest mark left. It replaced the board-read accent line.
- **Slice count, not time:** there's no reliable time per slice before it runs.
- **Last sprint with a doc** when none is current: a finished plan's board is still worth seeing until its run leaves the list.
- **`merged` beats `needs-you`** on a done card ([decision](../decisions.md#2026-10-19--you-only-on-unfinished-waves)).
- **Look only, no layout change** in calm-dashboard: the dependency lines and sideways scroller depend on the layout (plan Known risks).

## Watch out

- An entry with a `slice:` but no `sprint:` or `plan:` joins no plan's queue, so it never makes a card `needs-you`.
- A done slice with a pending `→ human` note reads `merged`, and that note doesn't stop the run (`stopsRun` needs an open slice).
- A card reads `running` from an engineer only when its dispatch fields were read ([engineer-view.md](engineer-view.md)).
- `#/<repoId>/board` is plan `board`'s run, not a board. Fix runs have no wave board.
- Depends-on values are kept as written, so `needs …` can list codes that draw no line.
- Slice codes like `W1` make branch names that differ from wave heads only by case ([known issue](../known-issues/branch-names-differ-only-by-case.md)).

## History

- 2026-10-19: added in sprint board-engineer (slice W1).
- 2026-10-19: a done card reads `merged` even with a pending ask for the human (decision "`you` only on unfinished waves", sprint board-engineer wave 2 fix).
- 2026-10-19 · board-read · plan complete; checked in review at 1280 and 375 px (critical path H1 → M1 → T1 on chess-web) · [report](../reports/board-read.html)
- 2026-10-20 · board-read · final review passed at round 5; filter, keys, 375 px, and live card update checked again · [report](../reports/board-read.html)
- 2026-10-21 · merge-actions P1 · the cards of a wave whose PR waits on you read `needs you`, with `PR #N · you merge`.
- 2026-10-26 · fix-autopilot-view · fixed: an autopilot wave's cards read `needs you · PR #N · you merge`; now they read `running` while autopilot merges, and `needs you · PR #N · autopilot stopped` after a halt. Card minutes leave out idle gaps over 15 minutes.
- 2026-10-28 · calm-dashboard · look only: plain cards with a status dot and word (no colored edge), critical path in `--fg`, other lines `--border-strong`; opened from the Plan tab with `Back to the run`; final PR #54 passed review at round 1 · [report](../reports/calm-dashboard.html)
- 2026-10-30 · fix-run-flow round 5 · `geometry.ts` adds `downPath` and `headPath` beside `edgePath`; screen 1's run flow draws its connectors with all three.
- 2026-10-30 · fix-run-flow round 7 · `geometry.ts` adds `stepPath` and reshapes `backPath` as smooth-step routes for screen 1's flow; the wave board's own `edgePath` curves are unchanged.
- 2026-11-03 · fix-run-state · changed: cards read the shared rules (`stopsRun`, `isSliceRunning`), and the wave in progress with nothing of its own running takes the run's state, as the flow's card does, so the counts agree with the flow, sidebar and Log.
- 2026-11-03 · fix-run-state review round 1 · fixed: a halted run's cards read `running` on a pushed slice or a quiet engineer; a stop on the whole plan now reads first on a live wave, as in the flow. A column's status reads `running` on a wave autopilot is merging, not `PR #N open`.
- 2026-11-03 · fix-run-state review round 2 · changed: cards read `holdsRun`, so an engineer at work under a PENDING gate reads `running`; a pushed slice reads `running` only while an agent of the plan wrote within 1 h, and on a manual run not once its PR merged.
