# Idea: OpenAFlow's own plugin and `.openaflow/` folder

Status: parked

## The idea
The second of three terminal-host plans, after [terminal-host](../plans/terminal-host.md) and before v0.1.0. The app creates `.openaflow/` in a repo from a template, and ships a renamed fork of claude-pod as its plugin, loaded with `--plugin-dir`. The hooks-only plugin from `terminal-host` folds into it. The hard-coded `pod-docs/` paths (`run-model.ts`, `repo-files.ts`, `watcher.ts`, `queue-writer.ts`, `folder-list.ts`) and other pod names (agent names, `pod-ports`, `pod-staging`, reply words) move behind the template. The New session skill list changes its prefix. `pod-docs/` stays as a watch-only fallback (decision 25). Research: [terminal-host.md](../research/terminal-host.md#openaflow-and-the-plugin). Open there: how the plugin updates, a session that loads the plugin twice, and whether the app warns when claude-pod is also installed.

## Why it's on hold
`terminal-host` comes first: the plugin needs hosted sessions to load it.

## What would make it worth building
`terminal-host` is merged. v0.1.0 waits for this plan (decision 2026-11-13).
