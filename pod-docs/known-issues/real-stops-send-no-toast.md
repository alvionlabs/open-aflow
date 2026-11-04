# Some real stops send no desktop toast

Severity: medium
Status: open · found 2026-11-04 · merge of `pod-staging` into PR #81

**Who it affects:** desktop app users who rely on toasts while the window is closed.

**What you see:** the run reads `needs you` on the board, but no toast appears, so you may not notice it until you open the app.

**How to reproduce:**
1. Run the desktop app with a plan that has no engineer at work.
2. Add a pending `gate 5`, a plain question from the orchestrator, or an `ask:` entry for that plan.
3. The board reads `needs you`, and no toast arrives.

**Cause:** confirmed in code. `packages/desktop/src/attention.ts` keeps only the `blocked`, `merge`, and `reply` tiers, and these stops are in the `pending` tier. `toasts.md` calls this a trade-off for a pending decision, written before these entries counted as stops. `pod-staging` already behaved this way, except that `ask:` is new.

**Workaround:** open the app and look at the sidebar.

**Fix idea:** send a toast for pending items that hold the run (`holdsRun`), and keep quiet on ones that don't.

**Evidence:** traced in code only. Not run in the desktop app.
