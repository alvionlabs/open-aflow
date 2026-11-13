# Idea: Clean up a leftover run

Status: parked

## The idea
A **Clean up this run** item in a leftover run's ⋯ menu. It does what pod's own cleanup does after a merge: it removes the run's worktree (`git worktree remove`), deletes the local branch with `git branch -d` (which refuses an unmerged branch), and deletes the port claim file. It uses no force. If a step fails, it stops and says which step failed. **Forget this run** ([ui-rework plan](../plans/ui-rework.md)) only deletes the claim file and leaves the worktree and branch on disk.

## Why it's on hold
The human chose Forget only on 2026-11-12. Clean up would be the board's first git write in a repo, against the rule that the board writes only the queue file ([actions.md](../feature-details/actions.md#why-its-this-way)). Worktree removal also fails often on Windows when a file is locked ([known issue](../known-issues/worktree-folder-locked-on-windows.md)).

## What would make it worth building
Leftover worktrees and branches pile up after Forget, and removing them by hand becomes a chore. It needs a decision that lets the board run these git commands.
