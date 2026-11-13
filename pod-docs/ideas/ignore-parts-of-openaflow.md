# Idea: Keep parts of `.openaflow/` out of git

Status: parked

## The idea
`.openaflow/` is committed (decision 8), as `pod-docs/` is today. Ignore only the parts written for you, such as `research/` and `reports/`, to cut commit noise. Agents keep sharing sprint docs and hand-backs through git.

## Why it's on hold
The human chose to commit the whole folder on 2026-11-11. This was the option left open in [terminal-host.md](../research/terminal-host.md) ("Still open as a later change if the noise bothers you").

## What would make it worth building
After `openaflow-plugin`, the commits from `research/` and `reports/` bother you in daily use.
