# Research: OpenAFlow as a terminal host

_Generated: 2026-11-11 · Depth: deep on session life, shallow on the rest · Sources: VS Code source on `main`, Claude Code legal page, node-pty README, news on Anthropic's 2026 policy_

**Status:** direction chosen by the human. Not planned yet. The next step is the spike in [Spike](#spike). This doc replaces the parked idea [cli-runner.md](../ideas/cli-runner.md).

## Summary

OpenAFlow stops depending on the pod plugin being installed. It hosts its own terminals. Each terminal runs the real, unmodified `claude` CLI with your own login. OpenAFlow controls the terminal; it does not control Claude Code. A plugin still drives the workflow, and writes its state to a `.openaflow/` folder in each repo. claude-pod is the default template for that plugin and folder.

Session life copies VS Code's pty host. A separate Electron utility process holds the terminals. It outlives a closed window and a server restart, but not an app quit. Quit asks first, then ends every run. After a quit, a crash, or a reboot, each run shows a **Resume** button. Nothing resumes on its own.

## Decisions (human, 2026-11-11)

These are the human's words. They are recorded in [decisions.md](../decisions.md), and are not in force until a plan takes them.

1. **Terminal wrapper.** OpenAFlow controls a terminal, not Claude Code. A plugin still drives the workflow.
2. **Own folder.** OpenAFlow creates `.openaflow/` in a repo. claude-pod is its default template for now.
3. **Follow VS Code's design** for the terminal host.
4. **Quit confirms and ends runs.** Quitting the app shows a confirm dialog that ends the running sessions. Leaving them running uses RAM and makes the app hard to predict.
5. **Resume is a button.** Show **Resume** buttons. Never resume on its own.
6. **The UI stays as it is.** A row in the list is still a run of the workflow. The run view with nodes and arrows is called **Workflow**: the screen you sit and watch to see how a run is going. The terminal is a new tab in the run view, for when you want to see it. It is not a new kind of row.
7. **Hosted runs only.** The app tracks only runs started in its own terminals. A run you start in your own terminal, outside the app, is ignored: outside the app the workflow plugin is not loaded, so nothing writes `.openaflow/` and the app has nothing to track.

## Proposals (not decided)

Everything else in this doc is a proposal for the plan to confirm. The main ones:

- No Agent SDK, no API key, and no `-p` for hosted runs. Never `--bare`.
- The workflow plugin is a renamed fork of claude-pod.
- The quit dialog's default button is **Cancel**.
- An app update never restarts the app while a run is live.
- Auto-continue stays, as a toggle that is off by default. See [Policy](#policy).

## Policy

Source: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (no last-updated date on the page; read 2026-11-11).

**Allowed by name.** The page's "Authentication and credential use" section first says what is banned (table below). Then it lists exceptions. The second exception reads: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above." Our reading: a terminal host on your own machine is this case.

**Scripts are supported.** The [authentication page](https://code.claude.com/docs/en/authentication) supports subscription login for "CI pipelines, scripts, or other environments where interactive browser login isn't available" (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`). It also says "Renewing early matters most for sessions that run unattended." It says nothing about third-party wrappers. We don't need the token: you sign in with `/login` inside the terminal.

**Banned, and the rules that keep us out of it:**

| The page bans | Our rule |
|---|---|
| Third-party apps that "offer Claude.ai login into their own applications" | You sign in inside the terminal, through Claude Code's own flow. The app shows no login of its own. |
| Apps that "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users" | The app sends no request to Anthropic. Only `claude` does. |
| Apps that "collect, store, or intermediate Claude.ai credentials or session tokens" | The app never reads `~/.claude/.credentials.json` or any token. It reads transcripts only. The env filter that drops `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_*` stays. |
| Running Claude Code other than "as published by Anthropic" | Start the installed binary. Never patch it, wrap its network, or turn off an auth method. |
| Agent SDK products on subscription login | We don't use the Agent SDK. |

**Grey area: auto-continue.** The page says nothing about automated keystrokes into an interactive session. It does say plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK." Long unattended runs push against that wording. Background: in 2026 Anthropic blocked subscription use in third-party harnesses (January), wrote the ban into its docs (February), and billed harness use separately (April 4). Our reading of those secondary sources, which disagree on details: the actions targeted apps that took the subscription token, not apps that run the CLI.

**Rules for auto-continue:**
- Off by default, per run, as today.
- Every automatic send is logged, as today.
- Check the legal page again before each release. If it bans automated input, remove auto-continue and keep manual send.

## How VS Code does it

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

## What we copy, and what we change

| VS Code | OpenAFlow | Why |
|---|---|---|
| Host as a `UtilityProcess` of the main process | Copy. A second utility process, separate from the server's | A server crash, restart, or update must not end a run. |
| Window gets a `MessagePort` to the host | Copy for the desktop. The browser build (`pnpm dev`, `pnpm start`) uses a WebSocket through the server instead | The browser build is the agents' test bench and has no Electron. |
| Heartbeat 5 s, warn at 6 s, alarm at about 11 s | Copy the numbers | They are tested at scale, with the sleep case handled. |
| Restart the host up to 5 times | Copy, but the runs in it are gone after a restart. Show them as stopped, with **Resume** | A restarted host has no ptys. |
| Headless xterm buffer per terminal, replay on attach | Copy | A window reload or reopen from the tray shows the full screen. |
| Flow control at 100,000 characters | Copy | `claude` output can be large and fast. |
| 60 s grace time after a window detaches | **Change: no grace time.** A closed window hides to the tray, and runs go on | Runs take hours. A hidden window is normal use. |
| Revive starts a new shell | **Change:** revive runs `claude --resume <session>`, and only when you press **Resume** | Claude Code keeps the conversation. Pod keeps the plan state in files. |
| `confirmOnExit` default `never` | **Change: always confirm when a run is live** | Quit ends runs (decision 4). |
| Auto replies | Not now. Auto-continue is our only automatic input | Keep automatic input small (policy). |

## Design

### Processes

```
Desktop:
Electron main ──starts──▶ server (utilityProcess, exists today)
      │                    reads .openaflow/ + transcripts, gh, model, API
      └──starts──▶ pty host (utilityProcess, new)
                     node-pty ──▶ claude (one per run, unmodified, your login)
                     headless xterm buffer per run
window ◀──MessagePort──▶ pty host

Browser build (pnpm dev / pnpm start, no Electron):
server ──starts──▶ pty host (plain Node child process, same code)
browser ◀──WebSocket──▶ server ◀──▶ pty host
```

- Agents test in the browser build, so the host must also start as a plain Node child process, as `server.mjs` already runs alone. The host code must not import `electron`, the same rule `packages/desktop` has today.
- The pty host does only terminal work: start, write, resize, kill, list, replay, heartbeat. It has no knowledge of plans, PRs, or pod.
- The host keeps a small, stable message protocol. Logic stays in the server and UI.
- The server tells the host what to start. The host tells the server when a process exits.

### Security

A terminal channel lets anyone who reaches it type commands on the machine. It needs at least the guards the action routes have today, carried over from [cli-runner.md](../ideas/cli-runner.md):

- The server and host bind to `127.0.0.1` only. The desktop host takes no network port at all: it talks through `MessagePort` only.
- The WebSocket upgrade (browser build) checks the loopback `Host`, the `Origin`, and the per-launch session token before it accepts. A failed check closes the socket with no terminal data sent.
- The host takes commands only from the main process and the server. A window can write to and resize a terminal, but it cannot choose the program or arguments to start. The server builds the `claude` command line.
- Never start `claude --bare`, which needs an API key.
- Keep the existing env filter and the `claude` path rules from the resume runner (`resume.md`): absolute path, no repo-folder lookup, drop `ANTHROPIC_*` and `CLAUDE*` except the exact allowlist.

### One run, one session ID

- The app picks a UUID and starts `claude --session-id <uuid>` in the repo folder. So it knows each terminal's session at once. It doesn't guess from transcripts, as `session-activity.ts` must today.
- **Resume** starts `claude --resume <uuid>` in a new terminal, in the same folder.
- Store, per run: repo path, session ID, start time, and stop reason. Store it in the config folder, not in the repo, so Resume works after a crash.
- Keep the existing checks: a session must be provably the repo's (`cwd` check), and the child env drops `ANTHROPIC_*` and `CLAUDE*` except the exact allowlist.
- **The ID can go stale.** `/clear` very likely starts a new session ID, and `/resume` inside the terminal switches to another session. Then the stored UUID no longer names what runs in the terminal. Not verified; spike check 9. A fix would be to follow the newest transcript whose `cwd` is the repo and whose start time is after the terminal's start, or to read a state file written by the plugin's `SessionStart` hook.
- **A row is a run, as today (decision 6).** Terminals attach to the run; they are not rows. One run can have more than one terminal over time (after `/clear`, or after a Resume), and the **Terminal** tab shows the live one. Proposals for the cases this leaves:
  - **Before a plan exists** (you chat, then run `/pod:plan`): the terminal sits on the repo's row, which already shows "no active plan". When the plan doc appears, the terminal moves to that run. Join them by the session's `cwd` and the plan's first transcript mention, as the run model joins agents today.
  - **After `/clear`:** same terminal, same run. Only the session ID changes.
  - **Resume:** reopens the run's newest session in a new terminal on the same run.
  - **The quit dialog** counts live terminals, and names each by its run.

### Reading state

- **Read state from files, never from the screen.** Plans, sprints, the queue, and PRs come from `.openaflow/` (and `pod-docs/` as a fallback), the transcripts, and `gh`, as today.
- The terminal is for input and display only. Claude Code's screen changes with each release, so screen text breaks easily.
- One exception may be needed: to know whether the prompt is empty before an automatic send. See [Input](#input-and-auto-continue).

### Session life

| Event | Host | Runs | What the user sees |
|---|---|---|---|
| Close the window | Lives | Go on | Tray icon. Toasts still work. |
| Reopen from the tray | Lives | Go on | Screen replayed from the buffer, then live output. |
| Reload the window | Lives | Go on | Same as reopen. |
| Server crash or restart | Lives | Go on | Board data comes back when the server returns. Terminals stay live. |
| Host crash | Restarts, up to 5 times | **End** | Each run reads `stopped (host crashed)` with **Resume**. |
| Host unresponsive about 11 s | Lives | Unknown | A banner: "Terminals are not responding." |
| Quit, no live run | Ends | — | No dialog. |
| Quit, live runs | Ends after you confirm | **End** | Dialog first. See [Quit](#quit). |
| App update | Ends with the app | **End** | Never restarts with live runs. See [Updates](#updates). |
| App crash | Ends | **End** | Next start: each run reads `stopped (app closed)` with **Resume**. |
| OS shutdown or reboot | Ends | **End** | Same as app crash. The app may get no chance to ask. |
| `claude` exits by itself | Lives | That run ends | The run reads `ended`, with **Resume**. |

### Quit

- Quit comes from the tray menu, the app menu, Ctrl+Q, or the OS.
- When no run is live, quit at once.
- When a run is live, show a dialog: "2 runs are active. Quit ends them." List each run by repo and plan. Buttons: **Quit and end runs** and **Cancel**. **Cancel** is the default.
- On **Quit and end runs**: save each run's screen buffer, end each process tree (see [Ending a process tree](#ending-a-process-tree)), wait up to a set time, then quit.
- OS shutdown: Electron gets `session-end` on Windows and may not show a dialog. Save the run list and end the processes. Show the runs as stopped on the next start.

### Resume

- A stopped run shows its last saved screen and a **Resume** button.
- **Resume** checks, in order: the repo folder exists; the session file exists and is the repo's; no other live terminal holds that session. Then it starts `claude --resume <session>`.
- Never resume on its own: not at app start, not after a host restart, not after an update.
- A stopped run gets no send of any kind until you press **Resume**. This includes auto-continue: today's automatic check runs at start and sends through `claude -p --resume`, which would resume a stopped run. For a hosted run, the check may only write to a live terminal.
- A stopped run stays listed until you resume it or dismiss it.

### Updates

- The updater downloads in the background, as today.
- It installs only on a quit with no live run, or after you confirm the same quit dialog.
- "Restart to update" with live runs shows the quit dialog. It never restarts by itself.

### Ending a process tree

- Quit must leave no `claude`, and no child of it, running. This was the reason for decision 4.
- Linux and macOS: closing the pty sends SIGHUP to the session. Children in another process group, such as a dev server an engineer started with `nohup` or `&`, can survive. Send SIGTERM, then SIGKILL, to the process group, and check for survivors.
- Windows: closing the ConPTY ends attached console processes. Children started detached, or with their own console, can survive. Use a Job Object with `KILL_ON_JOB_CLOSE` for each run, or end the tree by process ID.
- Engineers start dev servers in worktrees, so this is a real case, not an edge case. The spike must test it.

### Input and auto-continue

- You type into the terminal pane as in any terminal.
- The app writes `continue` (or `go`) to the pty, with Enter, only when all of these are true:
  - The run's toggle is on, or you pressed the button.
  - The model says the run waits for that word (the existing sendable rule).
  - The session is idle: the existing 60 s rule on the transcript and `subagents/` files.
  - The terminal is at an empty input prompt. **This is required.** The 60 s idle rule is probably also true while a permission or question dialog is open, and Enter there would accept the highlighted choice. How to know it without reading the screen is open: a state file written by the plugin's hooks (for example `Stop` and `Notification`) keeps the "files, not screen" rule. Spike check 5.
  - You have not typed in that terminal within a set time, so the two inputs don't mix.
  - The terminal is live. A stopped run gets nothing (see [Resume](#resume)).
- The old `claude -p --resume` runner stays only for runs the app does not host, if those are kept (see [Open questions](#open-questions)).
- With a hosted terminal, the known gap "a terminal still open on the session splits the conversation" goes away: the app holds the only terminal.

### `.openaflow/` and the plugin

- The app creates `.openaflow/` from the template when you add a repo and agree. This breaks the README line "it never writes inside a repo". Change that line.
- Claude Code loads skills and agents from a plugin or from `.claude/`, not from `.openaflow/`. So the workflow ships as a plugin (a fork of claude-pod, renamed), and only state docs go in `.openaflow/`.
- **Proposal: the app ships the plugin and loads it per session.** The app starts `claude --plugin-dir <app>/plugin`. The `claude` CLI help says `--plugin-dir` loads "a plugin from a directory or .zip for this session only". So the plugin is active only in hosted terminals, which makes decision 7 true by design. The plugin updates with the app, with no marketplace and no install step. Spike check 11.
- If you also install claude-pod globally, a hosted session loads both plugins. Their skills have different prefixes (`pod:` and the new one), but both may write docs. The plan must say whether the app warns about this.
- **Dropped: the `pod-docs/` fallback.** Decision 7 means pod runs started outside the app are not tracked. So the app no longer reads `pod-docs/`, and today's board for pod runs (this repo's own development too) stops working once the app moves to `.openaflow/`. The plan must decide when that switch happens.
- The path is hard-coded in about 12 lines today: `packages/model/src/run-model.ts:68-149`, `packages/server/src/repo-files.ts:8-9`, `watcher.ts:73`, `queue-writer.ts:31`, `folder-list.ts:159`.
- Other pod names to move behind the template: `pod:*` agent names in transcripts, `pod-ports` claim files, the `pod-staging` branch, and the reply words.

## Impact on today's code

| Today | After |
|---|---|
| `claude-runner.ts` runs `claude -p --resume <session> <word>` | Writes the word to the hosted pty. The `-p` runner stays only for runs the app doesn't host, if kept. |
| `session-activity.ts` finds sessions from transcripts | Hosted runs know their session from `--session-id`. Transcripts still give idle state and activity. |
| `auto-continue-owner.json`: one server per config folder sends | Still needed: dev and production can share a config folder. The pty host is per app, so the owner must also own the terminals. |
| "A quit never ends a resumed `claude`" (desktop) | Reversed: quit ends every hosted run, after you confirm. |
| Desktop has one utility process (server) | Two: server and pty host. `server-host.ts` patterns (ready message, one restart) apply to the host too. |
| Windows-only CI and packaging | node-pty works on Linux, macOS, and Windows 10 1809+. Linux becomes a real target. |

## Risks and unknowns

| Risk | Why it matters | How to settle it |
|---|---|---|
| node-pty native module in Electron 45 | node-pty 1.1.0 uses `node-addon-api` (N-API) and runs `scripts/prebuild.js` before `node-gyp rebuild`, so prebuilt binaries are likely. The npm package is 64 MB unpacked. The README asks for Electron 19+, and VS Code builds it itself. | Spike: install in `packages/desktop`, package, run on Windows and Linux with no build tools. Measure the installer size against `release-rules.ts`. |
| node-pty is not thread-safe | The README says so. | Use it in one process (the host) on one thread. |
| Process trees survive quit | Breaks decision 4. | Spike check 4. |
| Windows ConPTY on old builds | node-pty needs Windows 10 1809 or later. | State it in the install note. |
| Typing conflicts | An automatic send can mix with your typing. | The "no typing within a set time" rule; spike check 5. |
| Policy changes | Auto-continue is in a grey area. | Check before each release; keep it a toggle. |
| Heartbeat false alarms | Seen in VS Code forks on slow machines. | Copy the two-timer rule; log, don't kill, on the first miss. |
| Host crash ends runs | A crash costs work in flight. Pod resumes from files and Claude from the transcript, but an agent's unsaved turn is lost. | Keep the host small. Copy the restart limit. Test resume after a forced kill. |
| Claude Code UI changes | Only matters if we read the screen. | Read files, not the screen. |
| Feature absorption | Claude Code may add its own multi-session view. | The workflow view (plan, waves, queue) is the product, not the terminal. |

## Spike

Goal: prove the session life before any plan. Time: 1 to 2 days. Build in a branch, not on `main`. Pass means every check below passes on Linux (Fedora) and Windows 11.

1. **Start and show.** The desktop app starts a pty host utility process. The host starts `claude --session-id <uuid>` in a test repo. The window shows it with xterm.js, and you can type in it and sign in.
2. **Window life.** Close the window to the tray, wait, and reopen it. The screen is replayed and the run went on. Reload the window: same.
3. **Server life.** Kill the server utility process. The terminal stays live, and the board comes back.
4. **Quit.** Start a run that starts a child dev server (for example `npx http-server &` from the Bash tool). Quit and confirm. Afterwards, no `claude`, no `node` child, and no listening port remain (`ps`, `ss -ltnp` / `Get-Process`, `netstat`).
5. **Auto-continue input.** Write `continue` plus Enter to an idle session. Claude Code takes it as a normal turn. Then type while a send is due; the send waits. Then open a permission dialog (ask for a tool that needs approval) and leave it for over 60 s: no send happens, and the app knows the prompt isn't empty without reading the screen.
6. **Host crash.** Kill the host. The app restarts it, shows the run as stopped, and **Resume** starts `claude --resume <uuid>` with the old conversation.
7. **Reboot path.** Kill the whole app. On the next start, the run shows as stopped, with its last saved screen and **Resume**. Nothing starts by itself.
8. **Package.** `pnpm package` includes node-pty. The installed app passes checks 1 and 4 on a machine with no build tools. Record the installer size.
9. **Session ID drift.** In a hosted terminal, run `/clear`, then `/resume` to another session. Record which session ID each step leaves, and whether the app can still name the terminal's session.
10. **Browser build.** `pnpm dev` starts the host as a plain Node child. The browser shows the terminal over the WebSocket. A request with no token or a wrong `Origin` gets no terminal data.
11. **Session-only plugin.** Start `claude --plugin-dir <path>` in a hosted terminal: the plugin's skills work. Start plain `claude` in your own terminal in the same repo: the plugin's skills are absent.

## Open questions

1. ~~What is a "run"?~~ Answered 2026-11-11 (decision 6): a row stays a run, and the terminal is a tab in it. Still open: confirm the proposals under [One run, one session ID](#one-run-one-session-id) for a terminal that starts before its plan exists.
2. ~~Runs started outside the app?~~ Answered 2026-11-11 (decision 7): ignored.
3. How does the app install and update the workflow plugin? Proposal: ship it in the app and load it with `--plugin-dir` (see [`.openaflow/` and the plugin](#openaflow-and-the-plugin)). Confirm in the spike.
4. Is `.openaflow/` committed (as `pod-docs/` is, and pod merges it through PRs) or ignored?
5. How long after your last keystroke may an automatic send happen?
6. How many lines of scrollback per run? VS Code's persistent scrollback is a setting; pick a fixed default for us.
7. The browser build must host terminals (agents test there). Does the desktop window also use the WebSocket path, or only `MessagePort`?

## Sources

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [VS Code `electronPtyHostStarter.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts)
- [VS Code `ptyHostService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyHostService.ts)
- [VS Code `ptyService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts)
- [VS Code `terminal.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts)
- [VS Code `terminalConfiguration.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts)
- [VS Code docs: Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)
- [node-pty README](https://github.com/microsoft/node-pty)
- [DeepWiki: VS Code terminal architecture](https://deepwiki.com/microsoft/vscode/6.1-terminal-architecture-and-process-management)
- [Zed RFC: persistent terminal sessions](https://github.com/zed-industries/zed/discussions/50584)
- [Cursor forum: ptyHost heartbeat reports](https://forum.cursor.com/t/cursor-no-ptyhost-heartbeat-after-6-seconds-bug-report/94196)
- [TechCrunch: Claude Code subscribers will pay extra for OpenClaw](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/)
- [AlternativeTo: Anthropic bans subscription auth for third-party use](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)
- [yage.ai: A Claude Code subscription is not a developer credential](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html)
