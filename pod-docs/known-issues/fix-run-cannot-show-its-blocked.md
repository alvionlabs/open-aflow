# A fix run can't show its own BLOCKED

Severity: medium
Status: open · found 2026-11-03 · PR #81

**Who it affects:** anyone running `/pod:fix` whose engineer reports `BLOCKED`.

**What you see:** the fix run's card reads `Nothing to do`. The entry only adds to the Waiting tab's count.

**How to reproduce:**
1. Start a `/pod:fix` run.
2. Add a `BLOCKED` entry to you with no `plan:` in the queue, as the skill's `Concerns` are written.
3. Open the fix run.

**Cause:** confirmed in code. The skill writes these entries with no plan, and an entry with no plan never affects a plan or fix run's state, banner, or Next step (`packages/web/src/screens/runs/next-step.ts`). A fix run has no way to claim an entry as its own.

**Workaround:** read the chat hand-back, because `/pod:fix` repeats any `BLOCKED` there, and check the Waiting tab.

**Fix idea:** have the skill write a `fix: <slug>` field on the entry, and let the fix run claim it. Some entries already carry that field. This needs a change in `claude-pod` and a small one on the board.

**Evidence:** traced in code by the review. Not run on the page.
