# Research: an updater that works when the server can't start (queue entry 118)

_Generated: 2026-11-11 · Depth: shallow · Researchers: 1 · Searches: 3 · Pages read: 0 (search summaries only)_

**Assumptions:** This is a shallow check. No official best-practice page was found. The findings come from Electron's docs and from public bug reports about other Electron apps. Nothing was found on how Slack, Discord, VS Code, or Chrome handle an update when their main part can't start.

## The problem

The updater starts only after the first server ready (`packages/desktop/src/updater-main.ts`). A second server failure shows an error box and quits (`shell-main.ts`). So a release whose server can't start on some machine can never update itself on that machine. The user must find and run the next installer by hand.

## What exists
| Name | Link | What it shows | How close |
|------|------|---------------|-----------|
| Electron `autoUpdater` docs | [electronjs.org](https://www.electronjs.org/docs/api/auto-updater) | The updater can't check in the first few seconds after the first launch. A downloaded update applies at the next start. | Timing rules for any check |
| Electron "Updating Applications" | [electronjs.org](https://www.electronjs.org/docs/latest/tutorial/updates) | The default checks at app start, then on an interval. | The normal pattern |
| go-launcher | [ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Frazvandimescu%2Fgo-launcher) | A supervisor with versioned folders and crash-based rollback. "If the new version crashes at startup, recovery logic never executes." | The principle; small project, not checked |
| Claude Desktop crash loop | [report](https://claudeissues.com/issue/48290-bug-claude-desktop-v1-2581-0-crash-loop-on-startup-both-msix-and-exe-installs-wi) | An update made every start crash. The updater couldn't deliver the fix. | The failure we want to avoid |
| Claude Desktop stuck web view | [report](https://claudeissues.com/issue/45372-bug-msix-claude-desktop-web-view-gets-permanently-stuck-on-error-page-no-user-re) | The updater replaces files but never checks that the app is healthy. No recovery path for the user. | Same gap |
| Cursor crash after update | [report 1](https://forum.cursor.com/t/cursors-auto-update-hard-crashed-my-mac-3-times-in-one-evening-heres-the-forensic-evidence/160866), [report 2](https://forum.cursor.com/t/bug-report-cursor-3-6-31-crashes-on-launch-electron-framework-code-signature-invalidated-after-auto-update/162274) | Users recovered by hand: they deleted folders or renamed the updater. | Same gap |

## Best practices
- **Keep the recovery path apart from the part that can fail.** If the updater needs the failing part, it can't fix it. — [go-launcher](https://awesome.ecosyste.ms/projects/github.com%2Frazvandimescu%2Fgo-launcher)
- **Check at app start, then on an interval.** Don't wait for the app to be healthy. — [Electron](https://www.electronjs.org/docs/latest/tutorial/updates)
- **Wait a few seconds before the first check after the first launch.** — [Electron](https://www.electronjs.org/docs/api/auto-updater)
- **Give the user a manual way out.** Every report above ended with a manual fix that the user had to find alone.

## What this means for OpenAFlow

The shell already holds the updater, and the server runs in its own process. So the shell survives a server failure. Only the start condition ties the updater to the server. The plan:

1. Start the updater when the app starts, not at the first server ready. The first check stays at 30 s, then every 6 h.
2. When the server fails for good, check at once. With an update, stay in the tray until it downloads, then ask as usual. With no update, or a failed check, quit as today. A 10-minute limit ends a stuck download.
3. The error box names the Releases page, as a manual way out.
