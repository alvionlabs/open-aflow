# The desktop log tells you to press Ctrl+C

Severity: low
Status: open · found 2026-11-05 · real run test on the installed app

**Who it affects:** anyone who reads `%APPDATA%\Open AFlow\desktop.log`.

**What you see:** on Quit while a send runs, the log reads `open-aflow: waiting for 1 action to finish; press Ctrl+C again to quit now`. The desktop app has no console, so Ctrl+C means nothing there.

**How to reproduce:**
1. Press Continue on a run in the installed app.
2. Quit from the tray within a few seconds.
3. Read the last lines of `desktop.log`.

**Cause:** the server's shutdown message was written for `pnpm start` in a terminal, and the desktop shell copies the server's lines into its log.

**Workaround:** none needed. Quit still finishes on its own.

**Fix idea:** word the line for where it runs, or leave out the Ctrl+C part when the parent is the desktop shell.

**Evidence:** seen in the human's `desktop.log` at 2026-11-05 08:25:05 UTC.
