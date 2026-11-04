# A question on an archived plan shows on no board

Severity: medium
Status: open · found 2026-11-03 · real-repo check for PR #81

**Who it affects:** anyone with a pending queue entry whose plan is archived and that no port claim lists.

**What you see:** nothing. The plan isn't in the run list, so its entries appear on no card, Waiting tab, or banner, and the question waits unseen.

**How to reproduce:**
1. Archive a plan: set `Status: archived` in its plan doc.
2. Leave a `PENDING` entry to you with `plan: <slug>` in `pod-docs/handoff-queue.md`.
3. Make sure no port claim names the plan, then open the board.

**Cause:** confirmed in part. A run is listed for an archived plan only through a claim (`packages/model/src/runs.ts`), and an entry shows only on a listed run. The real case: pod writes a close-out question at or after archiving.

**Workaround:** read `pod-docs/handoff-queue.md`, or search it for `Resolution:** pending`.

**Fix idea:** list these entries somewhere that doesn't depend on a run, such as a repo-level row. Queue entry from PR #64 tracks the same gap.

**Evidence:** seen on real data. `ytb-feed`'s `paid sample run: the new prompts have met only fake models. It needs your go.`, on archived plan `creator-chapters`, showed on neither `pod-staging` nor PR #81's board.
