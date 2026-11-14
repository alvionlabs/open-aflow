# Idea: Lower the desktop window's minimum width to 600 px

Status: parked

## The idea
Lower `MIN_WIDTH` in `packages/desktop/src/window-rules.ts` from 800 to 600 px, as the human wants (2026-11-14). For comparison: VS Code uses 400 px, and 600 px when its panel is at the side (`WindowMinimumSize` in `src/vs/platform/window/common/window.ts`); OpenCode's desktop app sets no minimum. Between 600 and 820 px the app then shows its narrow layout (sidebar on top), so the run header needs a narrow form first: today the Auto-continue button squeezes the title to three lines and "Wave board" takes its own line. Agent's suggestion: the Auto-continue button goes icon-only when narrow. The odd band today is 800–820 px, where the app already stacks the sidebar.

## Why it's on hold
The human: "We will change to 600px later, don't work on it now."

## What would make it worth building
After the ui-rework PRs merge, or when someone asks for a narrower window.
