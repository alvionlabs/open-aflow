# A claude-runner test failed once with no known cause

Severity: low
Status: open · found 2026-11-04 · PR #81

**Who it affects:** anyone running `pnpm verify`. No user-facing effect is known.

**What you see:** `claude-runner.test.ts` › `a shim run through cmd.exe never runs a same-named .bat from the repo folder` fails with no fake record within 20 s.

**How to reproduce:** not reproduced on demand. It failed once in a full `pnpm verify` on 2026-11-04, then passed 6 times alone (about 0.9 s each) and in the next full run.

**Cause:** unknown. The guess is slow process start, because the same test failed under load with its older 5 s wait. But 20 s is far above its normal time, so this isn't proven. The test sits on the path that starts `claude`, so a real problem there would matter.

**Workaround:** run the test again. The error now says whether the fake started and what the run logged, so keep that output if it fails.

**Fix idea:** read the output of the next failure before you change the wait.

**Evidence:** seen once in a real run. Don't run parallel test copies to chase it without warning the human: those runs coincided with about 159 consoles on the desktop.
