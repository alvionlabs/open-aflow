# Idea: Native desktop stack after Electron

Status: parked

## The idea
Replace the Electron shell and the React UI with a native UI on Windows, Linux, and macOS. GPUI with `gpui-component` is the first candidate, and Iced is the fallback.

Discord is a reference. On 2026-11-04, its CTO confirmed a Rust rebuild on GPUI that removes Electron and React Native. Discord had no release date or public test then.

A UI rewrite alone leaves the Node server running, so its memory stays. To remove Node, also rewrite the server, the file watching, and the `git`, `gh`, and `claude` process handling.

## Why it's on hold
We ship Electron now because shipping fast matters more. We have no RAM measurement of open-aflow that shows a problem. Discord's 290 MB figure is one screenshot of an early build, not a benchmark. GPUI's API still changes, and it has no built-in text input.

## What would make it worth building
All of these must be true, in this order:

1. A measurement of the installed app, with the window open and in the tray, shows RAM use that is too high.
2. Fixes to the app do not solve the problem, and Electron's UI layer is the measured cause.
3. A two-day GPUI test passes on Windows, Linux, and macOS. The test covers the hardest board screen, one tray icon, and one notification.

Discord's public build can also give real numbers for this decision.
