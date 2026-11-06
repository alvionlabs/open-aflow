# The update check fails until a release exists

Severity: low
Status: open · found 2026-11-05 · installed app test

**Who it affects:** anyone running a build before the first GitHub release.

**What you see:** `desktop.log` reads `open-aflow desktop: update check failed: ERR_XML_MISSED_ELEMENT` a few seconds after each start. Nothing shows in the app.

**How to reproduce:**
1. Install a build while the repo has no release.
2. Read `desktop.log`.

**Cause:** expected, not confirmed: the updater reads the GitHub release feed, and with no release the feed has no entry to read.

**Workaround:** none needed.

**Fix idea:** check this line again after the human pushes `v0.1.0`. If it still shows, it is a real bug in the update path. If not, close this file.

**Evidence:** seen in the human's `desktop.log` at each start on 2026-11-05.
