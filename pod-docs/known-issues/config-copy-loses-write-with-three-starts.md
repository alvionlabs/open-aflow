# A rare config-copy case loses one write

Severity: low
Status: open · found 2026-11-05 · PR #92 final review

**Who it affects:** someone moving from the old config folder from before the rename whose copy fails once, while several copies of the app run. Only the human has an old folder, and the copy runs once per machine.

**What you see:** a repo added in one copy of the app is missing after the next start.

**How to reproduce:**
1. Deny read on the old `auto-continue.json`, and start A. A logs `could not copy …` and runs on the old folder. Remove the deny.
2. Start B. B logs `in use by process <A>` and also runs on the old folder.
3. Stop A, then start C. C copies the old folder and runs on `openaflow-server`.
4. Add a repo through B. It answers 201, but the write goes only to the old folder.
5. Stop B and C, then start D. D doesn't list B's repo.

**Cause:** only the auto-continue owner marks the old folder as in use. When A stops, `release()` deletes the owner file, so the folder reads as free while B still runs on it.

**Workaround:** add the repo again. The old folder keeps it as a backup.

**Fix idea:** each server running on the old folder writes its own marker there and removes it at stop. A start doesn't copy while any marker names a live process.

**Evidence:** driven by the PR #92 reviewer on the real bundle with temp folders. The human chose to merge without it, because it isn't critical.
