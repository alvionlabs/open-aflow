# A failed auto-continue shows no toast

Severity: medium
Status: open · found 2026-11-05 · PR #88 review

**Who it affects:** users who turned on Auto-continue for a run. It is off by default.

**What you see:** the board's automatic `continue` fails, for example because `claude` isn't found. No toast arrives and no item shows in the tray dot, so the run waits and you don't know.

**How to reproduce:**
1. Turn on Auto-continue for a fix run, and make `claude` unfindable.
2. Merge its PR within 30 minutes.
3. The action log reads `failed` with `auto`, and no item or toast appears.

**Cause:** the toggle's key is saved before the send starts, so the rule "no item for a key the toggle already sent" also holds after a failure. `pod-staging` behaved the same before PR #88. A fix in PR #88 matched the failure by run, not by key, which gave a false `Send continue` toast, so it was taken out.

**Workaround:** open the run. Its card still shows the reply, and the action log shows the failure.

**Fix idea:** keep the send's result beside the key on the toggle and on `Board.autoContinue`, and raise the item until a send for that key starts. Fix runs only, unless the human changes the plan rule in `decisions.md`.

**Evidence:** driven by the PR #88 reviewer with a missing `claude` binary.
