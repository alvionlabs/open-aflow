# Idea: Rework the run screen's UI

Status: parked

## The idea
Rework the run screen so each card has one clear job and goes away when its job is done. The human, on 2026-11-05: "This UI is so bad, we need to rework on this." Problems seen on the installed app during the windows-app test:

- The merge card was half width beside the Next step card. PR #88 fixed only the width.
- A merged PR card reads `merged` and `Merged` side by side.
- The same card says `PR #2` twice.
- The PR card stays on screen after the merge, when it has nothing left to do.
- `Continue` gives no sign that it did anything.
- The flow from Merge to Continue is hard to follow: the human had to ask what the steps were.

## Why it's on hold
The Windows app ships first. A rework is bigger than a bug fix, so it needs its own plan, with a look the human picks.

## What would make it worth building
After the first release. Start with `/pod:plan`, and list the screen's problems from daily use first.
