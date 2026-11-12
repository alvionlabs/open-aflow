# A sent answer that comes back as a stop shows no toast or dot

Severity: low
Status: open · found 2026-11-11 · code review of PR #99

**Who it affects:** users who turned on Auto-continue for a plan run. It is off by default.

**What you see:** the run waits on an answer that the board already sent once. No toast arrives, and the tray dot stays off. The run's card still offers `Send continue`.

**How to reproduce:**
1. Turn on Auto-continue for a plan run.
2. Answer the plan's `→ human` entries. The board sends `continue` for that answer, with the key `answered:<…>`.
3. Pod stops again on a new stop, and the board sends `continue` for it. The toggle's `lastKey` moves to that stop.
4. Pod stops once more with the same answered entries, because pod didn't rewrite their Resolution. The run's stop is the first `answered` key again.
5. The board doesn't send it, and no toast or dot appears.

**Cause:** traced in code. The board sends each `answered` key at most once per toggle (`answeredKeys`, in `autoSends`, `packages/model/src/auto-continue.ts`). The tray rule in `packages/desktop/src/attention.ts` (`replyKey`) hides a `continue` that it expects the board to send by itself. But `Board.autoContinue` doesn't carry `answeredKeys`, so the tray rule can't see that the board will skip this key. Nothing sends the reply, and nothing raises it. This is older than the 2026-11-11 `lastFailed` change, and it happens with no failed send.

**Workaround:** open the run, and press `Send continue` on its card.

**Fix idea:** have the tray rule and `autoSends` share one "the board sends this by itself" check. One way: carry `answeredKeys` on `Board.autoContinue`, and raise the item when the key is in that list.

**Evidence:** traced in code only, by the second `/code-review` of PR #99. Not run in the desktop app.
