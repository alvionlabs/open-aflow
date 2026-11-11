# Research: OpenAFlow as a terminal host

_Generated: 2026-11-11 · Depth: deep on session life, shallow on the rest · Sources: VS Code source on `main`, Claude Code legal page, node-pty README, news on Anthropic's 2026 policy_

**Status:** direction chosen by the human. Not planned yet. The spike ran on Linux on 2026-11-11; its findings are in [terminal-host-spike.md](terminal-host-spike.md), and the design below includes them. Windows is not tested yet. This doc replaces the parked idea [cli-runner.md](../ideas/cli-runner.md).

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
7. **Outside runs are watch-only.** Runs started in the app get Workflow, the Terminal tab, Continue, and auto-continue. Runs started in your own terminal still use OpenAFlow's plugin, so they write `.openaflow/`; they get Workflow, merge, and answer only. Reading state never depends on whether a run is hosted.
8. **`.openaflow/` is committed,** as `pod-docs/` is today.
9. **Typing wait for automatic sends: 30 s by default, as a user setting.** After you type in a run's terminal, the app waits this long before auto-continue may type `continue`.
10. **Scrollback: 5,000 lines per terminal by default, as a user setting.** The pty host keeps this much of each terminal's output for replay and for the last screen shown next to **Resume**.
11. **Follow VS Code for the window link and for tests.** The window talks to the pty host through `MessagePort` only, with no WebSocket. Terminal checks run against the real Electron app with Playwright `_electron` and a small test hook that reads and writes the terminal as text. The browser build stays for the rest of the UI, with no Terminal tab.

## Proposals (not decided)

Everything else in this doc is a proposal for the plan to confirm. The main ones:

- No Agent SDK, no API key, and no `-p` for hosted runs. Never `--bare`.
- The workflow plugin is a renamed fork of claude-pod.
- The quit dialog's default button is **Cancel**.
- An app update never restarts the app while a run is live.
- Auto-continue stays, as a toggle that is off by default. See [Policy](#policy).

## Options considered

Short notes on the options not chosen, so they can be weighed again later. Each row names the decision it lost to.

**How OpenAFlow gets independent of pod (decision 1)**
- **A. Read a new folder only.** Read `.openaflow/`, fall back to `pod-docs/`, and keep the pod plugin as the writer (with a docs-folder setting added to claude-pod). Small, but the app still needs the pod plugin, so it doesn't fix "I can't use the app".
- **B. Own plugin, no terminal.** Ship a renamed claude-pod plugin; you run `claude` in your own terminal. Independent of pod, but the app can't show or type into the session. Decision 1 is B plus a terminal.
- **C. Full harness.** The app drives Claude Code itself (Agent SDK or `claude -p`). Rejected in the master plan: a second product, no in-chat plan interview, and the Agent SDK needs an API key under Anthropic's rules.

**Session life (decisions 3 and 4)**
- **Terminals inside the app's main or server process.** Simplest, but a server crash or restart ends every run.
- **Detached host that outlives the app.** Runs survive quit, updates, and app crashes. Rejected: background runs use RAM and make the app hard to predict. It also needs Windows job-object work so Electron doesn't end the children.
- **tmux as the host (Linux and macOS).** Free persistence, and you could attach from your own terminal. Rejected: Windows has no tmux, so two hosts to keep up.

**Ending a run (decision 4), from the spike**
- **Close the pty only.** Rejected: a detached child, such as a dev server, survives (check 4).
- **Process tree only.** Rejected: misses a child whose parent has exited (check 4).
- **Env marker only.** Kept, with the tree, but not enough alone: a child that clears its env escapes it. A systemd scope closes that gap on Linux.

**Auto-continue gate (decision 9), from the spike**
- **Typing wait only.** Rejected: once the wait ran out, a send went into a half-typed box and submitted it (check 5).
- **Clear the box with Ctrl+U before the send.** Rejected: it deletes your draft.
- **Read the screen to see if the box is empty.** Rejected for now: it breaks the "files, not screen" rule, and the screen changes with each Claude Code release. The draft rule needs no screen.

**Following the live session ID, from the spike**
- **The newest transcript whose `cwd` is the repo.** Rejected: a guess that breaks with two terminals in one repo. The `SessionStart` hook names the session and the cause.

**node-pty, from the spike (open)**
- **`node-pty` 1.1.0:** no Linux prebuilt binary, so Linux needs our own build in CI.
- **`@lydell/node-pty`:** prebuilt for all three, but a third-party beta.
- **`node-pty` 1.2.0 when released:** _not checked_ for Linux prebuilds.

**Resume (decision 5)**
- **Resume on its own at start.** Fewer clicks after a reboot. Rejected: it starts long runs that use the plan quota with no action from you.

**What a row is (decision 6)**
- **A row per terminal** (my first proposal). Predictable, because the app owns the terminal's whole life. Rejected: it changes the run list, and the Workflow view is the screen to watch.
- **A row per Claude session.** Rejected: `/clear` and Resume make new sessions, so rows would split one piece of work.

**Runs started outside the app (decision 7)**
- **Hosted runs only.** Simplest, and one input path. Rejected: watching costs almost nothing, since state comes from files; and users on tmux, SSH, or containers would lose the app.
- **Watch and continue,** as today, with `claude -p --resume`. Rejected: two ways to send input, and two processes on one session can split the conversation.

**`.openaflow/` in git (decision 8)**
- **Ignore the whole folder.** Clean history. Rejected: engineers in worktrees read the sprint docs from their checkout, and the merge flow and hand-backs go through git. Ignoring it means a new way for agents to share state.
- **Ignore only the parts for you** (for example `research/` and `reports/`). Less noise, same workflow. Still open as a later change if the noise bothers you.

**Typing wait for automatic sends (decision 9)**
- **No wait; rely on the empty-prompt check alone.** Rejected: right after you clear your text, a send could land.
- **No automatic sends while the Terminal tab is open.** Rejected: it stops runs while you only watch, and watching is the app's main use.
- **A fixed 30 s with no setting.** Rejected in favor of a setting, so you choose the wait.

**Scrollback per terminal (decision 10)**
- **1,000 lines.** Low memory, but a long Claude turn can push out what you want to see.
- **10,000 lines or more.** More history, but more memory per run and a slower replay when the tab opens.
- Either stays reachable through the setting.

**Window link and tests (decision 11)**
- **B. WebSocket through the server, for both the app and the browser build.** One path that agents test in a browser. Rejected: a server crash stops the terminal view, it adds a WebSocket to guard, and VS Code shows that testing the real Electron app is normal.
- **C. The host serves its own WebSocket.** One path, no server dependence. Rejected: the host gets a network port and its own security, against keeping the host small.
- **Drop the browser build entirely.** One test target. Not chosen for now: it would change how every slice of the other UI is checked. Still open.

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

## What we learned from VS Code

Moved to [vscode-terminal.md](vscode-terminal.md): how VS Code's pty host works, how VS Code tests its terminal, and what we copy and change.

## Design

### Processes

```
Desktop:
Electron main ──starts──▶ server (utilityProcess, exists today)
      │                    reads .openaflow/ + transcripts, gh, model, API
      └──starts──▶ pty host (utilityProcess, new)
                     node-pty ──▶ claude (one per run, unmodified, your login)
                     headless xterm buffer per run
window ◀──MessagePort──▶ pty host   (the only terminal path)

Browser build (pnpm dev / pnpm start, no Electron): the rest of the UI only.
No pty host and no Terminal tab.
```

- Terminal checks run against the real Electron app (decision 11). The host code still imports no `electron` outside its `*-main.ts` entry, as `packages/desktop` does today, so its logic has plain unit tests with fakes.
- The pty host does only terminal work: start, write, resize, kill, list, replay, heartbeat. It has no knowledge of plans, PRs, or pod.
- The host keeps a small, stable message protocol. Logic stays in the server and UI.
- The server tells the host what to start. The host tells the server when a process exits.

### Security

A terminal channel lets anyone who reaches it type commands on the machine. It needs at least the guards the action routes have today, carried over from [cli-runner.md](../ideas/cli-runner.md):

- The pty host takes no network port at all. It talks only through `MessagePort` to the window and Electron's process channels to the main process and the server. No WebSocket exists for terminals (decision 11).
- The server keeps its existing guards: `127.0.0.1` only, `Host`, `Origin`, and the session token.
- The host takes commands only from the main process and the server. A window can write to and resize a terminal, but it cannot choose the program or arguments to start. The server builds the `claude` command line.
- Never start `claude --bare`, which needs an API key.
- Keep the existing env filter and the `claude` path rules from the resume runner (`resume.md`): absolute path, no repo-folder lookup, drop `ANTHROPIC_*` and `CLAUDE*` except the exact allowlist.

### One run, one session ID

- The app picks a UUID and starts `claude --session-id <uuid>` in the repo folder. So it knows each terminal's session at once. It doesn't guess from transcripts, as `session-activity.ts` must today.
- **Resume** starts `claude --resume <uuid>` in a new terminal, in the same folder.
- Store, per run: repo path, session ID, start time, and stop reason. Store it in the config folder, not in the repo, so Resume works after a crash.
- Keep the existing checks: a session must be provably the repo's (`cwd` check), and the child env drops `ANTHROPIC_*` and `CLAUDE*` except the exact allowlist.
- **The ID goes stale.** Spike check 9: `/clear` starts a new session ID and a new transcript file, and `/resume <id>` inside the terminal switches to that session. Then the stored UUID no longer names what runs in the terminal. **Fix:** the plugin's `SessionStart` hook reports each new ID with its cause (`startup`, `clear`, `resume`). The hook also sees the run's env marker, so it writes the run ID and the live session ID to a state file. Don't guess from the newest transcript.
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
- Linux and macOS: closing the pty sends SIGHUP to the session. Children in another process group, such as a dev server an engineer started with `nohup` or `&`, can survive. Spike check 4 confirmed this.
- Each run's env gets a marker, `OPENAFLOW_RUN=<run id>`. To end a run: take a snapshot of the process tree and of every process whose env holds the marker; send SIGTERM to the process group and to each process; wait; send SIGKILL to survivors; check for survivors.
- The marker misses a child that clears its env (`env -i`) after it leaves the tree. On Linux with systemd, start each run in its own user scope (`systemd-run --user --scope --unit=openaflow-run-<id>.scope`) and end it with `systemctl --user stop`. The scope ended that child in the spike. macOS has no cgroups: there, the marker is the best way found.
- Send SIGHUP first, as a closed terminal does. Real `claude` ended on SIGHUP in about 1 s. On SIGTERM it once ran past 3 s, so keep SIGKILL as the last step.
- **After a host crash or an app crash,** the host, the server, and `claude` end by themselves, but a detached child survives (spike checks 6 and 7). When the host exits, main ends each leftover of the runs it marks `host crashed`. At the next start after an app crash, it ends each leftover of a run that had no stop reason. Both use the marker and the scope.
- Windows: closing the ConPTY ends attached console processes. Children started detached, or with their own console, can survive. Use a Job Object with `KILL_ON_JOB_CLOSE` for each run, or end the tree by process ID.
- Engineers start dev servers in worktrees, so this is a real case, not an edge case. The spike must test it.

### Input and auto-continue

- You type into the terminal pane as in any terminal.
- The app writes `continue` (or `go`) to the pty, with Enter, only when all of these are true:
  - The run's toggle is on, or you pressed the button.
  - The model says the run waits for that word (the existing sendable rule).
  - The session is idle by the existing 60 s rule on the transcript and `subagents/` files. Keep it: the spike did not test subagents or background work after `Stop`.
  - The session is idle by the plugin's hook events too (spike check 5): the newest of `SessionStart`, `Stop`, and `Notification` `idle_prompt`, with no `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, or `Notification` `permission_prompt` after it. A permission dialog fires `PermissionRequest` at once and nothing more while it stays open, so the gate stays closed. Enter in that dialog accepts the highlighted choice, **1. Yes**.
  - The input box holds no draft. **This is required.** The host sees every byte you type. If you typed after the newest submit (`UserPromptSubmit` or `SessionStart`) and pressed no Enter, the box may hold text, and the send waits until your next submit. In spike check 5, a send with the typing wait only went into a half-typed box and submitted `half typedcontinue`.
  - You have not typed in that terminal for the typing wait: 30 s by default, a user setting (decision 9).
  - The terminal is live. A stopped run gets nothing (see [Resume](#resume)).
- Write the word, then Enter once, after a short pause. Never send a second Enter "to be sure": it can land in a dialog that opened in between.
- The old `claude -p --resume` runner stays only for runs the app does not host, if those are kept (see [Open questions](#open-questions)).
- With a hosted terminal, the known gap "a terminal still open on the session splits the conversation" goes away: the app holds the only terminal.

### `.openaflow/` and the plugin

- The app creates `.openaflow/` from the template when you add a repo and agree. This breaks the README line "it never writes inside a repo". Change that line.
- Claude Code loads skills and agents from a plugin or from `.claude/`, not from `.openaflow/`. So the workflow ships as a plugin (a fork of claude-pod, renamed), and only state docs go in `.openaflow/`.
- **Proposal: the app ships the plugin and loads it per session.** The app starts `claude --plugin-dir <app>/plugin`. The `claude` CLI help says `--plugin-dir` loads "a plugin from a directory or .zip for this session only". The plugin updates with the app, with no marketplace and no install step. Spike check 11.
- **Outside runs need the plugin too (decision 7).** Offer a normal install for your own terminal as well. Then a hosted session could load the plugin twice (installed and `--plugin-dir`), maybe at two versions. The spike must check what Claude Code does then; skip `--plugin-dir` when the installed version matches, if needed.
- If you also install claude-pod globally, a hosted session loads both plugins. Their skills have different prefixes (`pod:` and the new one), but both may write docs. The plan must say whether the app warns about this.
- **The `pod-docs/` fallback is open.** Runs with claude-pod (not OpenAFlow's plugin) write `pod-docs/`. Reading it watch-only costs little, since the parsers are the same, and keeps this repo's own development on the board while it moves over. Proposal: keep it until OpenAFlow develops itself with its own plugin.
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
| node-pty native module in Electron 45 | node-pty 1.1.0 has prebuilt binaries for Windows and macOS only; on Linux it compiles, and fails with no `g++` (spike). The fork `@lydell/node-pty` (beta) has prebuilt binaries for all three and loaded in Electron 45 packaged and unpackaged. In the package, node-pty is 144 KB. | The plan chooses: the fork, our own Linux build in CI, or node-pty 1.2.0. Windows packaging is still to test. |
| Folder-trust prompt | In a new folder, `claude` asks first, and the default is **No, exit** (spike). | The app never answers it. The Terminal tab shows a run that waits on it. |
| node-pty is not thread-safe | The README says so. | Use it in one process (the host) on one thread. |
| Process trees survive quit | Breaks decision 4. | Spike check 4: tree snapshot plus env marker ended every child but one that clears its env; a systemd scope ended that one too (Linux). Windows Job Objects are still to test. |
| Windows ConPTY on old builds | node-pty needs Windows 10 1809 or later. | State it in the install note. |
| Typing conflicts | An automatic send can mix with your typing. Spike check 5: with the typing wait only, it did. | The draft rule in [Input and auto-continue](#input-and-auto-continue), plus the typing wait. |
| Policy changes | Auto-continue is in a grey area. | Check before each release; keep it a toggle. |
| Heartbeat false alarms | Seen in VS Code forks on slow machines. | Copy the two-timer rule; log, don't kill, on the first miss. |
| Host crash ends runs | A crash costs work in flight. Pod resumes from files and Claude from the transcript, but an agent's unsaved turn is lost. | Keep the host small. Copy the restart limit. Test resume after a forced kill. |
| Claude Code UI changes | Only matters if we read the screen. | Read files, not the screen. |
| Feature absorption | Claude Code may add its own multi-session view. | The workflow view (plan, waves, queue) is the product, not the terminal. |

## Spike

**Ran on Linux on 2026-11-11. Results: [terminal-host-spike.md](terminal-host-spike.md).** Windows was not run, by the human's choice.

Goal: prove the session life before any plan. Time: 1 to 2 days. Build in a branch, not on `main`. Pass means every check below passes on Linux (Fedora). Windows 11 was dropped for now (human decision, 2026-11-11); test it before a plan ships the host on Windows.

1. **Start and show.** The desktop app starts a pty host utility process. The host starts `claude --session-id <uuid>` in a test repo. The window shows it with xterm.js, and you can type in it and sign in.
2. **Window life.** Close the window to the tray, wait, and reopen it. The screen is replayed and the run went on. Reload the window: same.
3. **Server life.** Kill the server utility process. The terminal stays live, and the board comes back.
4. **Quit.** Start a run that starts a child dev server (for example `npx http-server &` from the Bash tool). Quit and confirm. Afterwards, no `claude`, no `node` child, and no listening port remain (`ps`, `ss -ltnp` / `Get-Process`, `netstat`).
5. **Auto-continue input.** Write `continue` plus Enter to an idle session. Claude Code takes it as a normal turn. Then type while a send is due; the send waits. Then open a permission dialog (ask for a tool that needs approval) and leave it for over 60 s: no send happens, and the app knows the prompt isn't empty without reading the screen.
6. **Host crash.** Kill the host. The app restarts it, shows the run as stopped, and **Resume** starts `claude --resume <uuid>` with the old conversation.
7. **Reboot path.** Kill the whole app. On the next start, the run shows as stopped, with its last saved screen and **Resume**. Nothing starts by itself.
8. **Package.** `pnpm package` includes node-pty. The installed app passes checks 1 and 4 on a machine with no build tools. Record the installer size. Also measure the memory of one terminal holding 5,000 lines of scrollback.
9. **Session ID drift.** In a hosted terminal, run `/clear`, then `/resume` to another session. Record which session ID each step leaves, and whether the app can still name the terminal's session.
10. **Electron test.** A Playwright `_electron` test starts the built app, opens the Terminal tab, writes `echo ready` through the test hook, and reads `ready` back from the buffer, on Linux (with a display or `xvfb`) and Windows.
11. **Session-only plugin.** Start `claude --plugin-dir <path>` in a hosted terminal: the plugin's skills work. Start plain `claude` in your own terminal in the same repo: the plugin's skills are absent.

## Open questions

1. ~~What is a "run"?~~ Answered 2026-11-11 (decision 6): a row stays a run, and the terminal is a tab in it. Still open: confirm the proposals under [One run, one session ID](#one-run-one-session-id) for a terminal that starts before its plan exists.
2. ~~Runs started outside the app?~~ Answered 2026-11-11 (decision 7): watch-only.
3. How does the app install and update the workflow plugin? Proposal: ship it in the app and load it with `--plugin-dir` (see [`.openaflow/` and the plugin](#openaflow-and-the-plugin)). Confirm in the spike.
4. ~~Commit or ignore `.openaflow/`?~~ Answered 2026-11-11 (decision 8): committed.
5. ~~How long after your last keystroke may an automatic send happen?~~ Answered 2026-11-11 (decision 9): 30 s by default, a user setting.
6. ~~How many lines of scrollback per run?~~ Answered 2026-11-11 (decision 10): 5,000 by default, a user setting.
7. ~~How does the window connect to the terminals?~~ Answered 2026-11-11 (decision 11): `MessagePort` only, as VS Code does.

## Sources

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [VS Code `electronPtyHostStarter.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts)
- [VS Code `ptyHostService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyHostService.ts)
- [VS Code `ptyService.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts)
- [VS Code `terminal.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts)
- [VS Code `terminalConfiguration.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts)
- [VS Code smoke test README](https://github.com/microsoft/vscode/blob/main/test/smoke/README.md)
- [VS Code unit test README](https://github.com/microsoft/vscode/blob/main/test/unit/README.md)
- [VS Code `playwrightElectron.ts`](https://github.com/microsoft/vscode/blob/main/test/automation/src/playwrightElectron.ts)
- [VS Code smoke `terminal-persistence.test.ts`](https://github.com/microsoft/vscode/blob/main/test/smoke/src/areas/terminal/terminal-persistence.test.ts)
- [VS Code docs: Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)
- [node-pty README](https://github.com/microsoft/node-pty)
- [DeepWiki: VS Code terminal architecture](https://deepwiki.com/microsoft/vscode/6.1-terminal-architecture-and-process-management)
- [Zed RFC: persistent terminal sessions](https://github.com/zed-industries/zed/discussions/50584)
- [Cursor forum: ptyHost heartbeat reports](https://forum.cursor.com/t/cursor-no-ptyhost-heartbeat-after-6-seconds-bug-report/94196)
- [TechCrunch: Claude Code subscribers will pay extra for OpenClaw](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/)
- [AlternativeTo: Anthropic bans subscription auth for third-party use](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)
- [yage.ai: A Claude Code subscription is not a developer credential](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html)
