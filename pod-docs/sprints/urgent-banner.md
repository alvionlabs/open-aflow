# Sprint: Urgent banner

_From plan: pod-docs/plans/next-step-across-runs.md · Slug: urgent-banner · Status: active · Generated: 2026-11-01_

<!-- autopilot-run: started=2026-11-01T18:09:29Z sprints=0 waves=1 -->
## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | U1 | Elsewhere picker, urgent banner on screen 1, and its docs | urgent-banner-U1 | — | pending | — | — |

One slice: the picker feeds only the banner, and the docs feed only this change, so a split would add a wave check and no parallel work. The picker stays its own pure module with table tests inside the slice.

## Shared contract

The next planner reads this. Values (palette, type, sizes) are the plan's `## Look` and the draft `pod-docs/design-drafts/next-step-across-runs-look.html` (direction B); don't restate them, use the `calm-dashboard` tokens.

### 1. Picker interface (`packages/web/src/screens/runs/elsewhere.ts`)

```ts
export type Elsewhere = {
  run: RunSummary      // the run to open
  item: NextItem       // that run's Next step card (nextSteps(run, repo, now).card)
  name: string         // runName(run, repo), as the sidebar card and run header
  repo?: string        // run.repo; absent for a plan-less row, whose name already is the repo
  more: number         // other runs that also outrank the selected card (rule 2.6)
  href: string         // hashFor(run): the pipeline view of that run
}
export function elsewhere(runs: RunSummary[], board: Board | undefined, selected: RunSummary | undefined, now: number): Elsewhere | undefined
```

`runs` is the sidebar list in sidebar order (`listRuns` order, the `runs` prop of `RunsScreen`). It is the tie-break source, so it is an input. Pure: no storage, no DOM.

### 2. What outranks, with its edges

1. **Only each run's card counts.** For each run, the picker reads `nextSteps(run, repo, now).card` only, never `rest`. A run whose repo is not on the Board, or for which `nextSteps` returns undefined, is skipped.
2. **Rank.** `blocked` 4 > `merge` 3 > `reply` 2 > `pending` 1 > `nothing` 0. An `info` item is never a card. The tiers and kinds are `nextSteps`'s; the picker adds no tier of its own.
3. **Which other cards can raise a banner.** Tiers `blocked`, `merge` and `reply` always can. A `pending` card can only when its `entry.kind` is `now`, `decision` or `before`. A pending `someday` or `other` card, or a `nothing` card, never raises a banner. Answered entries are `info` in `nextSteps`, so they never do either.
4. **Strictly higher.** A candidate shows only when its rank is strictly higher than the selected run's card rank. The selected card ranks by its tier alone: a selected pending `someday` card is still rank 1, so another run's pending `decision` doesn't outrank it. Any candidate outranks a selected `nothing` card. The same tier never shows.
5. **Which one wins.** The highest rank. Within a rank: `blocked` and `pending` hold only queue entries, so the oldest `entry.date` wins (`YYYY-MM-DD`, string order; an entry with no date sorts after every dated one), then the earlier run in `runs`. `merge` and `reply` have no dates, so the earlier run in `runs` wins.
6. **`more`.** The count of the other outranking runs, not counting the winner. A run whose card is the same item as the winner's (same `repoId` and the same `key`) isn't counted. This happens because `waitingEntries` gives an entry with no plan tag to every run of its repo.
7. **The selected run** is matched by `hashFor` equality, not object identity, and is never a candidate. No `selected`, or no `board` → `undefined`.
8. **Repeats and time.** The picker keeps no state. Each Board update over `/api/events` runs it again. The banner appears, swaps to another item, or goes away on the next render, with no animation and no dismiss. When the item is handled, or the selected run's own card rises to the same rank, the banner goes away.

### 3. Banner on screen 1 (`UrgentBanner.tsx`, `urgent-banner.css`)

- **Where.** Only in `RunsScreen`'s `main`, for views `pipeline` and `agent` (a fix run's Log on screen 1), with a selected run. Never for view `board` (the wave board and the engineer view). It is the first child of `main`, before the error `.banners`. The plan places it as "the first child of the main column".
- **Live region.** A `role="status"` wrapper (polite), class `.urgent-slot`, is in `main` whenever a run is selected on those views. It is empty, with no box and no space, when `elsewhere` returns undefined, so screen 1 reads as today. The banner box renders inside it, so a new item is announced once.
- **Content, in order.** The status dot and word from `item.status`, then `item.title` (plain text; a `titleLink` renders as text only), then `· <repo> · <name>` muted (only `· <name>` when `repo` is absent), then `+N more` muted when `more > 0`, then "Open run".
- **"Open run".** A small secondary link-button (not `btn primary`: the Next step card keeps the page's one primary button) with the shared `arrow-right` icon. Its `href` is `Elsewhere.href`. Its accessible name is `Open run <name>`. After it is activated, focus moves to the new run's header heading.
- **Navigation only.** The banner holds no Answer, Merge, Close, Keep, Continue, Go or Copy control and no close button. It never calls an action route.
- **Class names.** A new `.urgent` block. Don't reuse `.banner` or `.banners` (the error notices; `runs-css.test.ts` pins `.banner`).

## Per-slice detail

### U1: Elsewhere picker, urgent banner on screen 1, and its docs
- **Scope:**
  - Build `elsewhere.ts` to contract items 1 and 2. Its public interface is `elsewhere()` and the `Elsewhere` type. It calls the existing `nextSteps`, `runName` and `hashFor` and changes none of them.
  - Build `UrgentBanner.tsx` and `urgent-banner.css` to contract item 3 and the plan's Look (border `--border-strong`, background `--bg`, 8 px radius, padding as the draft's `.b-bar`, one line with an ellipsis on the title on desktop; at 480 px and below the text wraps and "Open run" is full width and 44 px tall). The CSS uses only tokens (no raw colours) and only 4 px-scale spacing. It has no coloured fill or coloured border.
  - In `RunsScreen.tsx`, make a small, additive change: call `elsewhere(runs, board, selected, now)` and render the live region and the banner as the first child of `main` (contract item 3). Move focus to the run header heading after "Open run". This is glue. To make the heading focusable, the slice may give the `h1` in `RunHeader.tsx` `tabIndex={-1}` and update the existing `runs-screen.test.ts` assertions that match `<h1 class="run-name">`. Don't change `runs.css`. The banner's styles live in `urgent-banner.css`, which `UrgentBanner.tsx` imports.
  - Add `urgent-banner.css` to `SCREEN_ONE` in `runs-css.test.ts`, so the spacing-scale test covers it.
  - Docs: in `pod-docs/feature-details/runs-and-pipeline.md`, add an "Urgent banner" bullet under How it works. It covers the rank rules, the tie-break, `+N more`, placement and accessibility. Rewrite the "Turned down: a card across all runs" line under Why: the turn-down is reversed, as a banner and not a card. Add a Watch out line: a sidebar dot can read `needs you` for a run with only `someday` entries, and that run raises no banner (the dot follows state, the banner follows urgency). In Layout, qualify the "fit a 375 × 667 screen" measurement as "with no urgent banner showing". Add a History line. Append one `## 2026-11-01 — urgent items from other runs show as a banner (reverses calm-dashboard)` section at the end of `pod-docs/decisions.md`. It records the human's choice of placement B, the reversal of "no card across all runs", and the default rank and tie rules.
  - Test data: the existing `render` helper in `runs-screen.test.ts` builds a Board of one repo. For two runs, extend it to take more repos. Add a second `BoardRepo` built from the same chess-web fixture with another `id` and `name` (for example `id: 'other'`, `name: 'other-web'`), with its own queue edit. `elsewhere.test.ts` builds its Boards the same way (`loadFixture('chess-web')` plus `buildRepoModel`).
  - Out of scope: the sidebar run cards and their dots, `RunsList.tsx`, `BarMenu.tsx`, `menu-view.ts`, the wave board, notifications, tab title counts, and every file the parallel `fix-remove-repo` agent owns: `packages/server/src/{action-log.test.ts,remove-repo-routes.ts,remove-repo-routes.test.ts,repos-config.ts,repos-config.test.ts}` and `packages/web/src/screens/runs/{RemoveConfirm.tsx,action-log-view.test.ts,bar-menu.test.ts,menu-view.test.ts,remove-flow.ts,remove-flow.test.ts}`. `pod-docs/features.md` is the orchestrator's.
  - Browser checks: run against the mock repo `E:\Projects\pod-trial-mock` only, with the command in the project `CLAUDE.md`, on your own ports (base 3000: for example API 3010, web 3011), never against the real repos. To get two runs that disagree, edit the mock's `pod-docs/handoff-queue.md`: give one plan a `BLOCKED · orchestrator → human` halt and another a `PENDING` `decision:` entry. Run `agent-browser` from PowerShell, one command per call, each with a time limit (`pod-docs/known-issues/agent-browser-git-bash.md`). Stop your dev servers when done.
- **Files owned:**
  - `packages/web/src/screens/runs/elsewhere.ts` (new)
  - `packages/web/src/screens/runs/elsewhere.test.ts` (new)
  - `packages/web/src/screens/runs/UrgentBanner.tsx` (new)
  - `packages/web/src/screens/runs/urgent-banner.css` (new)
  - `packages/web/src/screens/runs/urgent-banner.test.ts` (new)
  - `packages/web/src/screens/runs/RunsScreen.tsx`
  - `packages/web/src/screens/runs/RunHeader.tsx`
  - `packages/web/src/screens/runs/runs-screen.test.ts`
  - `packages/web/src/screens/runs/runs-css.test.ts`
  - `pod-docs/feature-details/runs-and-pipeline.md`
  - `pod-docs/decisions.md`
- **Success criteria:**
  - `[test]` Another run's blocked card outranks a selected pending `decision` card; the result names that run, its card item, its name, repo and href — elsewhere.test.ts › blocked elsewhere outranks a pending decision
  - `[test]` Each rank step shows: merge over reply, reply over pending (`now`, `decision`, `before`), blocked over merge (a table over every pair) — elsewhere.test.ts › rank table
  - `[test]` The same tier never shows (blocked vs blocked, merge vs merge, pending decision vs pending now) — elsewhere.test.ts › same tier shows nothing
  - `[test]` A selected `nothing` card is outranked by any action card, including another run's merge — elsewhere.test.ts › nothing to do is outranked by any action
  - `[test]` A pending `someday` or `other` card elsewhere never shows, even over a selected `nothing` card; an answered entry never shows — elsewhere.test.ts › someday, other and answered never raise a banner
  - `[test]` A selected pending `someday` card is still rank pending: another run's pending `decision` doesn't show, and its merge does — elsewhere.test.ts › selected someday card ranks by tier
  - `[test]` Only the card counts: a run whose card is a merge but whose `rest` holds a blocked-tier item ranks as merge — elsewhere.test.ts › only each run's card counts
  - `[test]` Within blocked and pending, the oldest entry date wins; an undated entry loses to a dated one; on equal dates the earlier sidebar run wins — elsewhere.test.ts › oldest entry wins, then sidebar order
  - `[test]` Within merge and reply, the earlier run in `runs` wins, whatever its PR number — elsewhere.test.ts › merge and reply tie by sidebar order
  - `[test]` With three runs outranking, the highest wins and `more` is 2 — elsewhere.test.ts › counts the other outranking runs
  - `[test]` Two runs of one repo whose card is the same unjoined entry count once in `more` — elsewhere.test.ts › a shared entry counts once
  - `[test]` The selected run is matched by `hashFor` (a copy of the selected summary is still excluded); no selected run or no Board gives undefined; a run whose repo is missing is skipped — elsewhere.test.ts › selected run, missing board and missing repo
  - `[test]` A plan-less repo row that outranks gives its name with no separate `repo` — elsewhere.test.ts › a repo row names itself once
  - `[test]` The banner markup: a status dot and word with the item's status class, the title, the muted repo and name, `+2 more` when `more` is 2 and no count when it is 0 — urgent-banner.test.ts › renders the item, its run and the count
  - `[test]` "Open run" links to the href, is named `Open run <name>`, carries the `arrow-right` SVG icon and no text glyph, and is not `btn primary` — urgent-banner.test.ts › open run is a named secondary link
  - `[test]` The banner holds no Answer, Merge, Close, Keep, Continue, Go or Copy control, no close button, and no form — urgent-banner.test.ts › navigation only
  - `[test]` urgent-banner.css uses no raw colour values (only `var(--…)` tokens from the Look list), has no status-colour fill or border, uses 8 px corners, gives `.urgent-slot` no padding, margin, border, gap or min-height (so an empty slot takes no space), and at max-width 480 px makes the button full width and at least 44 px tall — urgent-banner.test.ts › css tokens, radius and phone button
  - `[test]` The spacing-scale test covers urgent-banner.css, and it passes — runs-css.test.ts › puts every gap, padding and margin on the 4 px scale, but for the listed exceptions
  - `[test]` With two repos (X selected with a pending decision, Y with a BLOCKED halt), screen 1 shows the banner as the first child of `main`, before `.banners` and the run header, inside the `.urgent-slot` `role="status"` region, naming Y; the page still has exactly one `btn primary` — runs-screen.test.ts › urgent banner shows another run's halt above the header
  - `[test]` With nothing outranking, the `.urgent-slot` region is empty, no `.urgent` box renders, and the error banners and run header follow it in today's order — runs-screen.test.ts › no banner when nothing outranks
  - `[test]` The wave board view (`view: 'board'`) has no banner even when another run is blocked; the `agent` view has it — runs-screen.test.ts › banner only on screen 1 views
  - `[manual]` On the mock repo, with X selected, adding a `BLOCKED` halt for Y to the mock's queue shows the banner within 5 seconds with no reload; "Open run" selects Y, focus lands on Y's header heading, Y's card shows the halt with Answer, and the banner is gone — mock repo at 1440 px, keyboard only (Tab to "Open run", Enter)
  - `[manual]` The banner at 1440 px and 375 px, dark and light: one line with an ellipsis on desktop; at 375 px the text wraps and "Open run" is full width and 44 px tall; no sideways scroll; it matches the draft's direction B; the icon and label balance on their ink (project `CLAUDE.md` button rules) — mock repo, both themes from the ⋯ menu
  - `[manual]` With 820 px and below the banner sits at the top of the main column, below the stacked sidebar — mock repo at 800 px
  - `[manual]` A screen reader announces the banner once when it appears, and not again on Board updates that don't change it — NVDA or Narrator on the mock repo
- **Depends on:** —
- **One-way door:** none. The change is web-only and additive: no stored data, no route, no Board JSON change, no auth. Removing the banner is a revert.
- **Model:** opus
