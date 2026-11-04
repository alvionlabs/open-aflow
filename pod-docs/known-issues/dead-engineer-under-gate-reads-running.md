# A dead engineer under a gate reads running for up to 1 hour

Severity: medium
Status: open · found 2026-11-03 · PR #81

**Who it affects:** anyone whose session dies while a `PENDING` gate 5 or 6 is open and an engineer on an unfinished slice has no end record.

**What you see:** for up to 1 hour after that engineer's last write, every view reads `running`, and the card says `An engineer is at work on this run. Answer when you can.` No banner appears. Continue isn't offered in that window.

**How to reproduce:**
1. Add a pending `gate 5` from the orchestrator to a plan.
2. Give the wave an engineer transcript with no end record, last written within the hour, then kill or lose that session.
3. The run reads `running` until `ENGINEER_QUIET_MS` (1 hour) passes, then `needs you`.

**Cause:** confirmed. The board can't tell a stopped engineer from one in a long quiet step, so a transcript that is quiet for under an hour counts as at work (`engineerAtWork` in `packages/model/src/pipeline.ts`). This protects long steps from false alarms and from a `continue` sent into a working session.

**Workaround:** answer from the card, or type `continue` in the session itself. Both still work in that hour.

**Fix idea:** detect a live session directly, for example from the process, instead of from transcript writes.

**Evidence:** the `running` reading was seen on the page with a fake transcript at 21 minutes, and at 45 and 70 minutes with an answered decision. The dead-engineer path is traced in code. The review found no normal pod path to it: a stalled engineer goes to gate 1, a `BLOCKED`, which reads first.
