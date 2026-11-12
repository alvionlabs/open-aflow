# A leftover fix run can't be removed in the app

Severity: medium
Status: open · found 2026-11-05 · PR #88

**Who it affects:** anyone whose fix run stopped before its cleanup ran, for example because the session crashed or was closed.

**What you see:** the run stays in the sidebar for good, its tray dot stays on, and it adds a line to the urgent banner on every run page.

**How to reproduce:**
1. Run `/pod:task` (`/pod:fix` in pod before 0.10) and merge its PR.
2. Don't reply `continue`, and close the session.
3. The run stays listed, because its port claim file stays.

**Cause:** by the human's decision in PR #88, a merged fix run stays listed for as long as its claim exists, so a late merge still gets Continue. Only cleanup frees the claim, and the app has no other way to remove it. `Remove repo` doesn't help, because a claim file adds the repo back.

**Workaround:** press Continue if the session can still run. Otherwise delete `<os temp>\pod-ports\<port base>` by hand; the run's ⋯ menu shows the port base.

**Fix idea:** a `Forget this run` item in the run's ⋯ menu that deletes that one claim file.

**Evidence:** driven by the PR #88 reviewer. One real leftover existed on the human's machine and was removed by hand.
