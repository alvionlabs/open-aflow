# Idea: Settings page in the desktop app

Status: parked

## The idea
A settings page in the desktop app. Its first setting is the one that starts OpenAFlow when you sign in to Windows. PR #88 took it out of the tray menu, and `createLoginItem` in `packages/desktop/src/login-item.ts` is kept for this page.

Label research on 2026-11-05: `Open at login` is the most common wording in apps on macOS and Linux, and Electron's API calls it `openAtLogin`. Windows' own word is **Startup** (Settings > Apps > Startup). The human found `Start at login` confusing, because OpenAFlow has no login of its own.

## Why it's on hold
The human chose to remove it from the tray rather than rename it, and to put it in a settings page later. Until then, the app has no switch for it. Windows Settings > Apps > Startup can still turn it off for a user of an older build.

## What would make it worth building
A second setting needs a home, or friends ask for OpenAFlow to start with Windows so they don't miss toasts.
