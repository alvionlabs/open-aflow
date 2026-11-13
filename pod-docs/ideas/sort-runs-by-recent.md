# Idea: Sort the runs list by most recent activity

Status: parked

## The idea

Put the run with the most recent activity at the top of the sidebar's runs list. Today `listRuns` in `packages/model/src/runs.ts` sorts by state first (blocked, needs you, running, …), then by repo name, then by plan slug. In the 2026-11-12 end-to-end test, the human expected the task run they were working on to come to the top. It read `needs you`, so three test repos that read `blocked` stayed above it.

Research on 2026-11-12, by web search, found no formal study. It found two common patterns:

- **Recency as the default** for activity lists. For example, Featurebase's inbox shows the most recently updated items at the top.
- **Priority groups with recency inside each group** for work queues. For example, Featurebase's "Highest priority" sort, and multi-key sorts such as status, then date.

Users often ask for both, and a list should show which sort is active.

Options:

1. **Recency only.** The newest activity is on top. Urgency stays visible through the urgent banner and each card's state dot. This matches what the human expected.
2. **State groups, newest first inside each group.** It keeps blocked runs on top, but it would not have put the test run on top.

The recommendation is option 1, because the urgent banner already raises the most urgent item from any run. Pick a "last activity" time for each run, such as the newest agent write, queue change, or PR event, and keep the order stable while nothing changes.

Sources: [Featurebase inbox sorting](https://help.featurebase.app/articles/1866393-inbox-sorting), [Wrike sorting request](https://community.wrike.com/discussion/1559/add-sorting-options-for-dashboards-in-the-global-dashboard-list), [Marker.io sorting request](https://feedback.marker.io/feature-request/p/enhanced-sorting-features-for-project-dashboard), and [a Claude sidebar request to order by last activity](https://claudeissues.com/issue/90402-feature-sidebar-order-the-chats-tasks-under-an-expanded-pinned-project-by-last-a).

## Why it's on hold

The v0.1.0 release comes first. The human picks option 1 or 2, and decides what counts as activity.

## What would make it worth building

It's already wanted. Build it with the next UI work after v0.1.0, for example with [auto-continue-indicator.md](auto-continue-indicator.md).
