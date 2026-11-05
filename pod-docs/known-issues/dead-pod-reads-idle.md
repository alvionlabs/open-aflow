# A dead pod reads idle, and nothing says it died

Severity: low
Status: open · found 2026-11-03 · PR #81

**Who it affects:** anyone whose autopilot session ends unexpectedly, such as a crash, with a pushed slice or an engineer in progress.

**What you see:** the run reads `running` until 1 hour after its last write, then `idle`. No message says the session stopped. With an answered entry, Continue is offered. With none, the board offers no reply.

**How to reproduce:**
1. Run an autopilot plan with a pushed slice.
2. End the session, and wait 1 hour past the last agent write.
3. The run reads `idle`, with nothing about the stop.

**Cause:** confirmed in code. The board reads transcripts and docs, and a killed session writes no final record. `idle` is true, but it doesn't say why.

**Workaround:** type `continue` in the session with `claude --resume`, or start `/pod:autopilot` again.

**Fix idea:** show `session ended` when a plan has unfinished work and no agent has written within the window.

**Evidence:** tests pin the `idle` reading and the return of `continue`. An engineer quiet 70 minutes was seen on the page as `idle` with a fake transcript. A real dead session has not been run.
