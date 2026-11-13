# Idea: Show that a run is on Auto-continue

Status: planned — pod-docs/plans/ui-rework.md

## The idea

Show on the dashboard that a run's Auto-continue toggle is on. Today the only place to see it is the run's ⋯ menu. Put a small sign, such as an `auto` chip or icon, next to the state on the run card in the sidebar and in the run header. Show the same sign whatever the run's state, so you can tell at a glance which runs the board sends `continue` to by itself.

The human asked for it on 2026-11-12, during the end-to-end test of v0.1.0: they turned Auto-continue on for a task run, and then saw no sign of it anywhere but the menu.

## Why it's on hold

The v0.1.0 release comes first. The sign is something users see, so it needs a look that follows `DESIGN.md`.

## What would make it worth building

It's already wanted. Build it with the next UI work after v0.1.0, for example with [sort-runs-by-recent.md](sort-runs-by-recent.md) or [ui-rework.md](ui-rework.md).
