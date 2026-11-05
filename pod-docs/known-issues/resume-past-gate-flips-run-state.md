# A resume past an unanswered gate flips the run's state

Severity: medium
Status: open · found 2026-11-03 · PR #81

**Who it affects:** anyone who resumes `/pod:autopilot` without answering a `PENDING` gate.

**What you see:** the run reads `running` while engineers work, then `needs you` between waves, with `PR #N · autopilot stopped` and a Merge button, while pod may be about to merge that PR.

**How to reproduce:**
1. Let autopilot halt at a `PENDING` gate, such as gate 5.
2. Resume with `/pod:autopilot` in chat, without answering the entry.
3. Watch the run between waves, when no engineer is at work.

**Cause:** confirmed in code. No skill text resolves an open `PENDING` gate on resume, so the entry stays pending. The board holds the run on it whenever no engineer is at work.

**Workaround:** answer or resolve the gate entry before you resume. Don't press Merge in that gap if pod is still running.

**Fix idea:** have `claude-pod`'s `/pod:autopilot` resolve its open `PENDING` gates on resume. This needs a change in that repo.

**Evidence:** traced in code and skill text by the review. The `running` half was seen on the page with a fake engineer under gate 5. The flip between waves has not been run.
