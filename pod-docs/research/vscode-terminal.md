# Research: what we learned from VS Code's terminal

_Generated: 2026-11-11 · Source: the VS Code repo on `main`, read through `gh api`, plus VS Code's docs · Used by: [terminal-host.md](terminal-host.md)_

OpenAFlow's terminal host follows VS Code's design (decision 3 in [terminal-host.md](terminal-host.md#decisions-human-2026-11-11)). VS Code is an Electron app with a terminal that has run at large scale for years, so its choices are tested. This file holds everything we learned from it. Add to it when we read more.

**How to read it:** rows marked _read from names only_ rest on function and event names, not on the code inside them. Read the code before a plan depends on them.

## How the terminal host works

Read from the VS Code source on `main`, 2026-11-11.

| Part | What VS Code does | File |
|---|---|---|
| Host process | The main process starts the pty host as an Electron `UtilityProcess` (`type: 'ptyHost'`, entry `vs/platform/terminal/node/ptyHostMain`). It passes the grace times and scrollback size in env. | `platform/terminal/electron-main/electronPtyHostStarter.ts` |
| Window link | Each window asks the main process for a channel (`vscode:createPtyHostMessageChannel`). The main process calls `utilityProcess.connect()` and sends the window a `MessagePort`. The window then talks to the host directly, not through the main process. | same |
| Host lifetime | The host is a child of the main process. When the main process ends, the host ends. | same |
| Heartbeat | The host beats every 5 s (`BeatInterval`). The first beat may take 20 s (`ConnectingBeatInterval`). After 6 s with no beat (5 s × 1.2), VS Code logs a warning. After about 11 s, it tells the user the host is unresponsive. The second timer avoids a false alarm after the computer wakes from sleep. | `platform/terminal/common/terminal.ts`, `node/ptyHostService.ts` |
| Host restart | If the host process ends, VS Code starts it again, up to 5 times (`MaxRestarts`). | `node/ptyHostService.ts` |
| Process start timeout | A `createProcess` call with no answer counts as unresponsive (`CreateProcessTimeout`). | same |
| Persistent process | Each terminal is a `PersistentTerminalProcess` in the host. It keeps a headless xterm buffer (`XtermSerializer`, `@xterm/addon-serialize`), so a new window can replay the screen. | `node/ptyService.ts` |
| Reconnect | After a window reload, the new window lists the host's terminals and attaches. The host sends a replay event first, then live data. | same |
| Detach | When a window detaches, a terminal that had any use stays alive for the grace time. A terminal that was never used ends at once. | `ptyService.ts` `detach()` |
| Grace time | A terminal with no window attached ends after 60 s (`GraceTime`). A second timer of 6 s (`ShortGraceTime`, commented "maximal grace time between the first and the last reconnection") starts when `reduceConnectionGraceTime()` is called; we did not read what calls it. | `terminal.ts` `LocalReconnectConstants`, `ptyService.ts` |
| Orphans | _Read from names only:_ the host fires `onProcessOrphanQuestion` and waits for `orphanQuestionReply` before it treats a terminal as an orphan. | `ptyService.ts` |
| Flow control | The host pauses the pty when 100,000 characters are sent but not acknowledged (`HighWatermarkChars`), and resumes when the window catches up. | `terminal.ts` |
| Data batching | Output is batched (`TerminalDataBufferer`) to cut the number of messages. | `ptyService.ts` |
| Auto replies | _Read from names only:_ the host can answer fixed prompts by itself (`AutoRepliesPtyServiceContribution`). | `ptyService.ts` |
| App quit | `shutdownAll()` disposes every process. The setting text says that when "the terminal process must be shut down (for example on window or application close)", the contents are restored and the process recreated next time. `serializeTerminalState` saves the screens; _we did not read who calls it at quit._ | `ptyService.ts`, `terminalConfiguration.ts` |
| Revive | On the next start, `reviveTerminalProcesses` shows the saved screen with a "restored" note, and starts a **new** process with the old environment. The old process is gone. | `ptyService.ts` |
| Revive setting | `onExit` (default): revive after quit. `onExitAndWindowClose`: also after a window close. `never`: no revive. | `terminalConfiguration.ts` |
| Quit confirm | `terminal.integrated.confirmOnExit`: `never` (default), `always`, or `hasChildProcesses`. | `terminalConfiguration.ts` |

Known field problem: Cursor and other VS Code forks report "No ptyHost heartbeat after 6 seconds" and frozen terminals, mostly over Remote SSH or on slow machines. The heartbeat finds the problem. It doesn't fix it.

## How the terminal is tested

Read from the VS Code repo on `main`, 2026-11-11.

| Layer | What runs | Where | Terminal examples |
|---|---|---|---|
| Unit | Mocha tests inside an Electron renderer, with DOM and Node APIs ("the closest to the environment in which VS Code itself ships"). The `common` and `browser` layers also run in Chromium and WebKit through Playwright. | `test/unit` | `ptyService.test.ts`: `XtermSerializer` replay keeps the screen; `attachToProcess` attaches only when the pid matches. `ptyHostService.test.ts`: `restartPtyHost` disposes old listeners. Also `terminalProcess`, `childProcessMonitor`, `autoReplies` tests. |
| API integration | Extension tests against a running VS Code | `extensions/vscode-api-tests` | `terminal.test.ts`, `terminal.shellIntegration.test.ts` |
| Smoke (UI) | Playwright drives the **real Electron app** with `_electron.launch` (`playwrightElectron.ts`). The same suites also run against the web build with `--web --browser chromium|webkit`, and `--headless` works only with `--web`. | `test/smoke`, `test/automation` | `terminal-persistence.test.ts`: "restores completed output exactly once and in order after window reload" and after detach/attach. Also input, tabs, profiles, and shell-integration suites. |

How the smoke tests read and type into a terminal:
- They do not read pixels or the DOM text of the terminal. The app has a test driver with `getTerminalBuffer(selector)` and `writeInTerminal(selector, value)`. The test polls the xterm buffer as lines of text until a check passes (`waitForTerminalText`).
- Most terminal smoke suites are skipped on Linux (`skipSuite: process.platform === 'linux'`). They run on Windows and macOS.

What this means for OpenAFlow:
- Testing the real Electron app is normal practice, not a workaround. VS Code's main UI checks run that way, and the web build is a second target.
- A small test hook in the app (read the terminal buffer as text, write to it) makes terminal checks reliable, with no screenshots.
- Our repo already starts the real Electron binary in `real-*.test.ts` files on Windows. Playwright's `_electron` would add page control to that.

## What we copy, and what we change

| VS Code | OpenAFlow | Why |
|---|---|---|
| Host as a `UtilityProcess` of the main process | Copy. A second utility process, separate from the server's | A server crash, restart, or update must not end a run. |
| Window gets a `MessagePort` to the host | Copy. `MessagePort` is the only path; no WebSocket (decision 11) | A server crash never stops the terminal view, and there is no network port to guard. |
| Heartbeat 5 s, warn at 6 s, alarm at about 11 s | Copy the numbers | They are tested at scale, with the sleep case handled. |
| Restart the host up to 5 times | Copy, but the runs in it are gone after a restart. Show them as stopped, with **Resume** | A restarted host has no ptys. |
| Headless xterm buffer per terminal, replay on attach | Copy | A window reload or reopen from the tray shows the full screen. |
| Flow control at 100,000 characters | Copy | `claude` output can be large and fast. |
| 60 s grace time after a window detaches | **Change: no grace time.** A closed window hides to the tray, and runs go on | Runs take hours. A hidden window is normal use. |
| Revive starts a new shell | **Change:** revive runs `claude --resume <session>`, and only when you press **Resume** | Claude Code keeps the conversation. Pod keeps the plan state in files. |
| `confirmOnExit` default `never` | **Change: always confirm when a run is live** | Quit ends runs (decision 4). |
| Auto replies | Not now. Auto-continue is our only automatic input | Keep automatic input small (policy). |
| Smoke tests drive the real Electron app with Playwright `_electron` | Copy for every terminal check (decision 11) | What agents test is what users run. |
| Test driver reads the xterm buffer as text (`getTerminalBuffer`, `writeInTerminal`) | Copy: a small test hook in the app | Reliable checks with no screenshots or screen parsing. |
| Web build as a second smoke target | **Change:** the browser build stays for the rest of the UI only, with no Terminal tab | Users run only the app. |
| Terminal smoke suites skipped on Linux | **Change:** run them on Linux too | Linux is a target for us; VS Code's coverage proves nothing there. |

## Not read yet

Read these before a plan depends on them:
- What calls `reduceConnectionGraceTime()` (the 6 s short grace time).
- The orphan check: `onProcessOrphanQuestion`, `orphanQuestionReply`, and `isOrphaned()`.
- Who calls `serializeTerminalState` at quit, and how long it may take.
- `AutoRepliesPtyServiceContribution`.
- The renderer side: how a window lists, attaches, and replays (`localPty:getTerminalLayoutInfo`, `reviveTerminalProcesses`).
- The test driver in the app: where `getTerminalBuffer` and `writeInTerminal` live, and how the app exposes them only to tests.
- How VS Code ends a terminal's process tree (`childProcessMonitor`, `terminalProcess.ts`).

## Sources

- [`electronPtyHostStarter.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts)
- [`ptyHostService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyHostService.ts)
- [`ptyService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts)
- [`terminal.ts` (constants)](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts)
- [`terminalConfiguration.ts` (settings)](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts)
- [Smoke test README](https://github.com/microsoft/vscode/blob/main/test/smoke/README.md)
- [Unit test README](https://github.com/microsoft/vscode/blob/main/test/unit/README.md)
- [`playwrightElectron.ts`](https://github.com/microsoft/vscode/blob/main/test/automation/src/playwrightElectron.ts)
- [`test/automation/src/terminal.ts`](https://github.com/microsoft/vscode/blob/main/test/automation/src/terminal.ts)
- [`terminal-persistence.test.ts`](https://github.com/microsoft/vscode/blob/main/test/smoke/src/areas/terminal/terminal-persistence.test.ts)
- [`ptyService.test.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/test/node/ptyService.test.ts)
- [VS Code docs: Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)
- [DeepWiki: VS Code terminal architecture](https://deepwiki.com/microsoft/vscode/6.1-terminal-architecture-and-process-management) (secondary)
- [Cursor forum: ptyHost heartbeat reports](https://forum.cursor.com/t/cursor-no-ptyhost-heartbeat-after-6-seconds-bug-report/94196)
- [Mirrored VS Code commit (ptyHost as utility process)](https://cdn04132025.gitlink.org.cn/louis_lifu/vscode/commit/708b6aa379c2c9d12c65123c8934ca5a6a29046d) (secondary)
