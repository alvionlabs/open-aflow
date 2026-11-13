# Research: terminal-host spike findings

_Run: 2026-11-11 · Linux (Fedora 44, Wayland, Electron 45.2.1, Node 26.13.0, Claude Code 2.1.322) · Windows: 2026-11-13 (Windows 11 Home 26300, Electron 45.2.1, Node 26.13.0, Claude Code 2.1.323), see [Windows](#windows) · Used by: [terminal-host.md](terminal-host.md)_

**Status:** done on Linux (2026-11-11) and on Windows (2026-11-13). The human first chose Linux only (2026-11-11, [decisions.md](../decisions.md)) and asked for the Windows run later. On Linux, every check passes, with these limits:

- Two checks passed only after a fix to the design: 5 (the draft rule) and 6 (a sweep after a host crash). See [Design changes](#design-changes).
- Part 5a ran with the first version of the gate. Its send path did not change, and the new gate opened at an idle prompt in the rerun.
- The 5b-c rerun verdict was set by hand. The check's file test hit a file left by the first run. The hook events and the screen show that nothing was approved.
- Check 8 ran check 1 on the packaged app with the fake `claude`, not the real one.
- A child that clears its env survives quit unless the run is in a systemd scope (an option in the spike).

Windows ran later, on 2026-11-13, on the branch `spike/terminal-host-windows`. Every check passes there, with a Job Object per run. See [Windows](#windows).

The prototype is throwaway code on the branch `spike/terminal-host`, in `packages/desktop/spike/`. It never merges to `main`. The raw results are in `packages/desktop/spike/results/` on that branch.

## Summary

- The VS Code design works for OpenAFlow. A pty host in a second `utilityProcess` keeps each run alive through a closed window, a window reload, a new window, and a server crash. Replay through a `MessagePort` lost no line and repeated no line.
- Quit ends every process of a run, if the host ends more than the pty. Closing the pty is not enough: a detached child survives. The spike ends the process tree, every process that holds the run's env marker, and (as an option) the run's systemd scope.
- After an app crash (`SIGKILL` of the main process), the host, the server, and `claude` (real and fake) end by themselves. A detached child survives. The next start finds it by its env marker and ends it.
- After a host crash, a detached child also survives. The first version of the spike left it running. Main now ends it by marker when the host exits.
- Real `claude` ends on SIGHUP in about 1 s. On SIGTERM it ended in 0.7 s once, and it was still running after 3 s once, so the SIGKILL fallback is needed.
- Auto-continue is **not safe** with the planned rules alone. A send after the typing wait went into a half-typed input box and submitted it. Hook events plus a "draft" rule fix this without reading the screen.
- `/clear` changes the session ID. The plugin's `SessionStart` hook reports each new ID with its cause, so the app can follow the session.
- `node-pty` 1.1.0 has no Linux prebuilt binary. The spike used the fork `@lydell/node-pty`, which has one for each platform. In the package, node-pty adds 144 KB.

## Results

The Evidence column is for Linux. For Windows, see [Windows](#windows). "Fake" means the fake `claude` (`spike/fake-claude.mjs`); "real" means the user's own `claude` with `--model haiku`.

| # | Check | Linux | Windows | Evidence |
|---|---|---|---|---|
| 1 | Start and show (real) | Pass | Pass | `claude` answered `PONG`. The host buffer and the window's xterm both show it. |
| 2 | Window life (fake) | Pass | Pass | 113 numbered lines, each once and in order, after hide 10 s and show, a reload, and a destroyed and new window. |
| 3 | Server life (fake) | Pass | Pass | Server killed by PID. New server PID, `/api/health` 200. Terminal went 10 → 21 lines with no gap. |
| 4 | Clean quit (fake) | Pass | Pass, with a Job Object | Dialog text and buttons correct; **Cancel** keeps app, run, and child. **Quit and end runs** leaves no process and no listening port. One gap, closed by a systemd scope; see [Ending a run](#ending-a-run). |
| 5 | Safe auto-continue (real) | Pass, after a fix | Pass | a) `continue` became a user turn in the transcript. b) Failed with the planned rules; passes with the draft rule. c) No send during a permission dialog held 70 s. |
| 6 | Host crash (fake) | Pass, after a fix | Pass, with a Job Object | Host killed by PID. App started a new host. Run read `host crashed`; `claude` ended. A detached child survived until main swept it by marker (added after the first run). **Resume** started `claude --resume <uuid>`. |
| 7 | App crash (fake) | Pass | Pass, with a Job Object | Run read `app closed` with its last saved screen. A detached child survived the crash; the start sweep ended it. Nothing started by itself. |
| 8 | Package and memory (fake) | Pass | Pass, on a machine with some build tools | Linux `dir` package. node-pty loaded with no build step. Checks 1 (fake start) and 4 passed on the packaged app. Sizes and memory below. |
| 9 | Session ID drift (real) | Finding | Same finding | See [Session IDs](#session-ids). |
| 10 | Electron test | Pass | Pass | `spike/checks.mjs` runs every check with Playwright `_electron`. |
| 11 | Session-only plugin (real) | Pass | Pass | `/openaflow-spike:hello` ran the skill in the app. Plain `claude` in the same repo: `No commands match "/openaflow-spike:hello"`. |
| — | Real `claude` kills (real, no turn) | Finding | Finding | Real `claude` ended after a host crash (about 1 s, no sweep), a quit, and an app crash. See [Ending a run](#ending-a-run). |

Real `claude` use: 10 short Haiku turns (9 typed prompts and one skill run), counted from the transcripts. The human approved about 6-8. The extra turns came from check 5: one turn sent by the bug that the check found, and one rerun after the fix. The kill checks typed nothing and spent no turn.

## Findings

### node-pty

- `node-pty` 1.1.0 (latest) ships prebuilt binaries for `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64` only. On Linux, its install script runs `node-gyp rebuild`. This machine has no `g++`, so the install failed.
- `@lydell/node-pty` 1.2.0-beta.18 is a fork with prebuilt binaries for Linux, macOS, and Windows on x64 and arm64, in one optional package per platform. It loaded in an Electron 45 `utilityProcess` with no build step, unpackaged and packaged.
- It is a third-party beta. Options for the plan:
  - Use `@lydell/node-pty`. Pin it, and review each update.
  - Use `node-pty`, and build the Linux binary in our release workflow. Linux users then still get a prebuilt binary from us.
  - Use upstream `node-pty@1.2.0-beta.18`. Checked after the spike (`npm pack --dry-run`): it ships prebuilds for `linux-x64` and `linux-arm64` too. The lydell fork repackages the same betas. _Not tested_ in Electron. **Chosen** (decision 12 in [terminal-host.md](terminal-host.md#decisions-after-the-spike-human-2026-11-11)).
- pnpm: `pnpm-workspace.yaml` has an `allowBuilds` list, and pnpm skips any install script not in it. On this machine the Electron binary was missing after `pnpm install`. An `electron: true` entry and `pnpm rebuild electron` did not download it. Only `node node_modules/electron/install.js` (in `packages/desktop`) did. CI on Windows gets the binary today, so _not checked:_ why it differs here.
- A native `.node` file can't load from inside an asar. The spike puts node-pty in `resources/native/node_modules/` and names that folder to the host in env. electron-builder's `asarUnpack` is the usual way.

### Window and server life

- Replay is correct when the host serializes and adds the window's port in the same tick, after the headless parser has taken every chunk (`term.write('', callback)`). Then each chunk is either in the replay or sent live, never both.
- The check reads the **window's** xterm buffer (`page.evaluate`), not only the host's. Reading only the host's buffer would pass with a broken replay.
- A hidden window keeps its renderer, so "close to tray" never replays. A reload or a new window replays once.
- A server crash does not touch the pty host. The existing one-restart rule in `server-host.ts` brought the server back in about 1 s.

### Ending a run

Each run's child env gets `OPENAFLOW_RUN=<run id>`. To end a run, the host:

1. Takes a snapshot of the pty process's descendants (`/proc/*/stat`) and of every process whose env holds the marker (`/proc/*/environ`).
2. Sends `SIGTERM` to the pty's process group and to each process in the snapshot.
3. Waits up to 3 s, then sends `SIGKILL` to survivors.

What each way found, for a child HTTP server that tries to outlive `claude`:

| Child started as | Tree | Marker | systemd scope | Result |
|---|---|---|---|---|
| `spawn(..., { detached: true })` (still a child) | Found | Found | — | Ended |
| `sh -c 'setsid server &'`, shell exits (orphan) | Missed | Found | — | Ended |
| Orphan, and `env -i` clears the env | Missed | Missed | — | **Survived**, port still open |
| Orphan with env cleared, run in a systemd scope | Missed | Missed | Found | Ended |

- The marker finds most orphans, because children inherit env. A child that clears its env escapes it.
- A cgroup holds every process, whatever it does. On Linux with systemd, the host can start each run as `systemd-run --user --scope --unit=openaflow-run-<id>.scope claude ...` and end it with `systemctl --user stop <unit>`. This worked here. _Not tested:_ Linux without systemd, and macOS, which has no cgroups.
- Windows needs its own way: a Job Object with `KILL_ON_JOB_CLOSE`, as `terminal-host.md` proposes. Not tested.

Real `claude`, started with no prompt typed (check 12):

| Event | Real `claude` |
|---|---|
| Host crash, no sweep | Ended in about 1 s (SIGHUP from the closed pty) |
| Quit, SIGHUP first | Ended in about 1 s |
| Quit, SIGTERM first | Ended in 0.7 s in one run. In another run it was still running after 3 s and got SIGKILL. |
| App crash | Ended within 3 s |

So the host sends SIGHUP first, as a closed terminal does, then SIGTERM, then SIGKILL. _Not tested:_ real `claude` with a turn or a tool in flight, and real `claude` with its own children (MCP servers, Bash tools).

### Host crash

- When the host ends, every pty closes, and the fake `claude` ended. A detached child did not.
- The first spike build only marked the runs `host crashed`. The start sweep covers only runs with no stop reason, and quit covers only live runs. So that child had no owner, and it ran until the end of the session.
- Main now ends every process with the run's marker when the host exits. Check 6 passed with this sweep: the child's port closed.

### App crash

After `SIGKILL` of the Electron main process, within 3 s:

| Process | State |
|---|---|
| pty host (`utilityProcess`) | Ended |
| server (`utilityProcess`) | Ended |
| fake `claude` (pty child) | Ended (the pty closed with the host) |
| detached child server | **Still running** |

- The next start marks each run with no stop reason as `app closed`. It then ends every process that still holds that run's marker. Here, it ended the child server.
- The screen is saved every 10 s, not only at quit. The crash gave no chance to save, so the stopped run showed the screen from the last timer save.
- The sweep has the marker's gap: a child that cleared its env survives a crash. A systemd scope would also survive a crash, so the start sweep can stop the run's scope by its unit name.

### Folder trust

- In a folder that `claude` has never seen, it first asks "Quick safety check: Is this a project you created or one you trust?". The highlighted default is **No, exit**. Enter there ends `claude`.
- After one "Yes, I trust this folder", later runs in that folder skip the prompt.
- The app must not answer this prompt for the user. The Terminal tab shows it. A run started with no window open waits here until the user answers.

### Typing into Claude Code through the pty

- Text first, then `\r` after a short pause, works. The spike waits 300 ms for automatic sends and 1 s in the test. _Not tested:_ text and Enter in one chunk, which Claude Code may take as a paste.
- A second Enter "to be sure" is dangerous. In the first check 5 run, the test's retry Enter came after the turn had started a permission dialog. It chose the highlighted option, **1. Yes**, and ran the command. Automatic input must send Enter exactly once.

### Auto-continue

The hooks of a small spike plugin (`--plugin-dir`) wrote each event to a file. Events seen:

| Situation | Hook events, in order |
|---|---|
| Start | `SessionStart` (`source: startup`) |
| A plain turn | `UserPromptSubmit`, `Stop` |
| Idle at the prompt for 60 s | `Notification` (`idle_prompt`, "Claude is waiting for your input") |
| A tool that needs approval | `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, then after about 6 s `Notification` (`permission_prompt`, "Claude needs your permission") |
| While the dialog stays open (70 s) | Nothing more: no `idle_prompt`, no `Stop` |

- **The planned rules let a send corrupt a draft.** The user typed `half typed` with no Enter. After the typing wait ran out, the last hook event was `Stop`, so the gate opened. The send wrote `continue` + Enter, and Claude Code took `half typedcontinue` as a turn. No file says the box holds text.
- **Fix: the draft rule.** The host sees every byte the user types. A terminal has a draft when the user typed after the newest `UserPromptSubmit` (or `SessionStart`), and that input held no Enter. A draft blocks the send until the next submit. Ctrl+U or Backspace can empty the box, but the host can't see that without the screen, so the rule stays on. The user can still press **Continue** by hand. With this rule, the send waited (check 5b rerun).
- **The idle rule must come from hooks.** Idle means the newest of `SessionStart`, `Stop`, and `Notification` `idle_prompt`, with no event after it except `SubagentStop` and `SessionEnd`. Any `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, or `Notification` `permission_prompt` after it means busy or a dialog. In the first design of the gate, `idle_prompt` counted as busy, so it blocked every send after 60 s at an empty prompt.
- `PermissionRequest` fires before the dialog's `Notification`, so the gate closes at once, not 6 s later.
- The `UserPromptSubmit` payload holds the submitted text (`prompt`). The app can use it to log what each automatic send became.
- A user setting of `defaultMode: auto` approves most Bash commands with no dialog. The test machine has it, so the test used `--permission-mode default` to get a dialog. The plan must not assume that every user sees dialogs.

### Session IDs

Check 9, in one hosted terminal started with `--session-id A`:

| Step | Transcript written | `SessionStart` hook |
|---|---|---|
| Start, then a turn | `A.jsonl` | `A`, `source: startup` |
| `/clear`, then a turn | a new file `B.jsonl` | `B`, `source: clear` (after `SessionEnd` for `A`) |
| `/resume A`, then a turn | `A.jsonl` again | `A`, `source: resume` (after `SessionEnd` for `B`) |

- The stored UUID goes stale after `/clear`, as predicted. It is correct again after `/resume A`.
- The plugin's `SessionStart` hook gives the terminal's live session ID at each change, with the cause. The env marker `OPENAFLOW_RUN` is in the hook's env too, so the hook can write the run ID next to the session ID. This is simpler and surer than guessing from the newest transcript.

### Package and memory

- Linux `dir` package (electron-builder `linux.target: dir`): 276 MB unpacked, 119 MB as a `tar.gz`. Electron is nearly all of it. node-pty: 144 KB, of which the `.node` file is 72 KB. The app's own asar: 784 KB. The server: 852 KB.
- The pty host's resident memory (`VmRSS` in `/proc/<pid>/status`):

| | Unpackaged | Packaged |
|---|---|---|
| Host idle, no terminal | 124-127 MB | 114 MB |
| One terminal holding 5,031 rows (5,000 scrollback + 31 on screen) of 70 characters | 158-161 MB | 148 MB |

- One full terminal costs about 34 MB. An idle `utilityProcess` costs about 115-125 MB on its own. That is Electron's cost, not node-pty's.
- The headless buffer dropped the oldest 970 lines of 6,000, as the scrollback setting says.

### Heartbeat

- The host beats every 5 s, and main raises a "not responding" banner after 11 s with no beat. No check stopped the host without ending it, so the banner was not tested.

## Design changes

These change [terminal-host.md](terminal-host.md). The same edits are in that file.

1. **Auto-continue gate.** Add the draft rule, and define idle from hook events as above. Send Enter exactly once, after a pause.
2. **Ending a run.** Snapshot the tree and the env marker before any signal. Send SIGHUP, then SIGTERM, then SIGKILL. On Linux with systemd, put each run in its own user scope. After a host crash, and at the next start after an app crash, end leftovers by marker and by scope.
3. **Session IDs.** Follow the live session through the plugin's `SessionStart` hook.
4. **Folder trust.** The app never answers the trust prompt. The Terminal tab must show a run that waits on it.
5. **Save screens on a timer** (10 s), not only at quit.
6. **node-pty:** upstream `node-pty@1.2.0-beta.18`, decided after the spike: see [node-pty](#node-pty).

## Not tested

- Windows: see [Windows: not tested](#windows-not-tested).
- The gate during a question dialog (`AskUserQuestion`), a plan approval, and the trust prompt (default **No, exit**). Each may fire other hook events than a permission dialog.
- The gate with subagents or background work still running after `Stop`. The 60 s transcript idle rule stays for that case.
- macOS.
- The heartbeat banner (a host that hangs but stays alive).
- Flow control at 100,000 unacknowledged characters.
- A hosted session that loads the plugin twice (installed and `--plugin-dir`).
- The quit dialog by mouse: the test stubbed `dialog.showMessageBox`, because Playwright can't click native dialogs.
- Check 1 with real `claude` on the packaged app. The packaged run used the fake.

## Windows

_Run: 2026-11-13 · Windows 11 Home (build 26300), Electron 45.2.1, Node 26.13.0, Claude Code 2.1.323 (`claude.exe` from npm) · branch `spike/terminal-host-windows`_

**Status:** done. Every check passes on Windows. The fix that makes it work is a Job Object per run, held by the pty host. Limits:

- Check 8 ran on this machine, and this machine has build tools. See [Check 8 and build tools](#check-8-and-build-tools).
- `session-end` was simulated: the test emitted the event. No real log off or shutdown was done.
- A process that WMI starts escapes every way the spike tried. This is the Windows form of the `env -i` gap on Linux.
- A child that `claude` starts in the first 45-60 ms of its life can escape the job. See [The assign gap](#the-assign-gap).

Real `claude` use: 8 short Haiku turns (7 typed prompts and one skill run), on a private test repo, approved by the human. The kill checks typed nothing and spent no turn. The repo had no changes afterwards.

### Windows results

"Fake" means the fake `claude`; "real" means `claude.exe --model haiku`. The raw results are in `packages/desktop/spike/results/*-windows*.json`.

| # | Check | Windows | Evidence |
|---|---|---|---|
| 1 | Start and show (real) | Pass | `claude` answered `PONG`. The host buffer and the window's xterm both show it. |
| 2 | Window life (fake) | Pass | 110 numbered lines, each once and in order, after hide 10 s and show, a reload, and a destroyed and new window. |
| 3 | Server life (fake) | Pass | Server killed by PID. New server PID, `/api/health` 200. Terminal went 9 → 20 lines with no gap. |
| 4 | Clean quit (fake) | Pass, with a Job Object | Dialog text and buttons correct; **Cancel** keeps app, run, and child. With the job, **Quit and end runs** leaves no process and no listening port for a detached child, an orphan, and a child with its own console. A WMI-started child survives. See [Ending a run on Windows](#ending-a-run-on-windows). |
| 4b | OS shutdown (fake, simulated) | Pass | After `session-end`, the store read `session end`, and the host, `claude`, and a detached child ended within 0.6-0.8 s. |
| 5 | Safe auto-continue (real) | Pass | a) `continue` became a user turn. b) A draft blocked the send after the typing wait. c) No send during a permission dialog held 65 s; no file was made. The hook events are the same as on Linux. |
| 6 | Host crash (fake) | Pass, with a Job Object | Host killed by PID. App started a new host. Run read `host crashed`. `claude` and its detached child ended with the host's job handle: no sweep ran. **Resume** started `claude --resume <uuid>`. With no job, the child survived. |
| 7 | App crash (fake) | Pass, with a Job Object | Main killed by PID. Within 3 s, the host, the server, `claude`, and its detached child ended. Next start: run read `app closed` with its last saved screen; nothing started by itself. With no job, the child survived. |
| 8 | Package and memory (fake) | Pass, on a machine with some build tools | Windows `dir` package. node-pty and koffi loaded from prebuilt binaries. Checks 1 (fake start), 4 (detached child), 7, and 10 passed on the packaged app. Sizes and memory below. |
| 9 | Session ID drift (real) | Same finding as Linux | `/clear` wrote a new file with `SessionStart` `source: clear`. `/resume <id>` went back to the first file with `source: resume`. |
| 10 | Electron test | Pass | `cmd.exe` in the ConPTY. The test wrote `echo ready` through the test hook and read `ready` in the host buffer and in the window's xterm. Unpackaged and packaged. |
| 11 | Session-only plugin (real) | Pass | `/openaflow-spike:hello` ran the skill in the app. Plain `claude` in the same repo: `No commands match "/openaflow-spike:hello"`. |
| — | Real `claude` kills (real, no turn) | Finding | See [Ending a run on Windows](#ending-a-run-on-windows). |

### node-pty on Windows

- Upstream `node-pty@1.2.0-beta.18` (decision 12) loaded in an Electron 45 `utilityProcess`, unpackaged and packaged. It ships `prebuilds/win32-x64` with `conpty.node`, `conpty_console_list.node`, `conpty.dll`, and `OpenConsole.exe`. Its loader tries `build/Release` first, then `prebuilds/`.
- pnpm skipped node-pty's install script (`allowBuilds: node-pty: false`), and no `build/` folder exists. So the prebuilt binary is what loaded.
- **The PID comes late.** node-pty on Windows starts the process only after its conout worker is ready. `pty.pid` is 0 right after `spawn()`. The host polls the agent's inner PID, which is set right after `CreateProcess`. That took 43-60 ms in every run.
- The Electron binary was missing after `pnpm install` here too. `node node_modules/electron/install.js` fixed it, as on Linux.

### Ending a run on Windows

Windows has no SIGHUP or SIGTERM. Node's `process.kill(pid, sig)` calls `TerminateProcess` for any signal, and a negative PID (a process group) is not supported. node-pty's `kill()` closes the ConPTY and ends every process attached to its console.

The spike gives each run a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway flag. The pty host creates it through koffi (an FFI library with prebuilt binaries) and holds the only handle. The handle is not inheritable. The host puts the `claude` process in the job as soon as it has the PID. Each child that `claude` starts later joins the job too, even with `detached: true`.

To end a run, the host:

1. Takes the job's PID list and, as an option, the tree by parent PID.
2. Closes the ConPTY (`pty.kill()`).
3. Waits up to 3 s for those processes to end.
4. Calls `TerminateJobObject`, then ends tree survivors by PID.
5. Closes the job handle.

What each way found, for a child HTTP server that tries to outlive `claude` (check 4, fake `claude`):

| Child started as | ConPTY close only | Tree by PID | Job only | Job and tree |
|---|---|---|---|---|
| `spawn(..., { detached: true })` (still a child) | **Survived** | Ended | Ended | Ended |
| Orphan: a detached go-between starts it, then exits | **Survived** | **Survived** | Ended | Ended |
| Own console: `cmd /c start /min node server` | — | **Survived** | Ended | Ended |
| Started by WMI (`Win32_Process.Create`) | — | — | — | **Survived** |

- ConPTY close ends only processes attached to the console. A detached child is not attached.
- The tree by PID misses orphans. Windows does not reparent a process when its parent exits, so the chain from `claude` breaks. A stale parent PID can also match a new, unrelated process, because Windows reuses PIDs.
- The job caught every child that `claude` or its children started. Only a process that another service starts (WMI here; also the Task Scheduler and COM servers) is outside it.
- The tree added nothing that the job missed.
- The env marker can't replace either one on Windows. Reading another process's env needs its memory (`ReadProcessMemory` on its PEB), so the spike did not read it.

Real `claude`, at its prompt with no turn (check 12w):

| Event | Real `claude` |
|---|---|
| Quit, ConPTY close only (no job) | Ended in 0.6 s |
| Quit, job | Ended in 0.6 s. The ConPTY close ended it before the job did. |
| Host crash, no job | Ended after 5.0 s |
| App crash, job | Ended in 0.8 s |

- `claude` ends on ConPTY close, as it ends on SIGHUP on Linux.
- With no job, a host crash left `claude` running for 5 s. This matches the time Windows gives a console process to handle a close event. With the job, it ends when the host's handle closes.
- `claude` at its prompt had no child processes. _Not tested:_ real `claude` with a turn, a tool, an MCP server, or a dev server in flight.

### Host crash and app crash on Windows

- When the host ends for any reason, Windows closes its handles. Each job then ends every process in it. So a host crash, an app crash, and an OS end of the app need no sweep. Check 6 and 7 passed this way; with the job off, the detached child survived both.
- When main was killed, Electron's other processes (host, server, renderer, GPU, network) ended within 3 s, as on Linux.
- **Test finding:** Playwright's launched process is not Electron main on Windows. The first check 7 killed that PID, and main kept running. The next start then exited at once, because main still held the single-instance lock. The checks now kill the PID that main reports (`process.pid`).

### OS shutdown

- Electron sends `session-end` on Windows. The spike's handler does no waits: it writes the run store with `session end`, tells the host to call `TerminateJobObject` for each run, and ends the host. Ending the host alone would close every job.
- Simulated by `app.emit('session-end')`: all ended within 0.6-0.8 s. _Not tested:_ a real log off or shutdown, and whether Windows gives the app time for the store write.
- The screen is not saved at `session-end`. The 10 s timer save is the last one.

### The assign gap

- The job gets `claude` 43-60 ms after `spawn()`. A child that `claude` starts in that time is not in the job. Real `claude` started no child in that time in these runs, and the fake starts its child later than that. This gap was not hit, but it is real.
- Ways to close it, not tested:
  - A small launcher that joins a named job, then starts `claude`. Children then always start inside the job.
  - Start the process in the job (`PROC_THREAD_ATTRIBUTE_JOB_LIST`). node-pty does not offer this today.

### Check 8 and build tools

- **This machine has build tools.** Visual Studio 18 Community is installed, but no `cl.exe` was found in it. MSYS2 with `gcc` and Python are installed too. So this is not the clean machine that check 8 asks for.
- What the spike shows instead: pnpm skipped the install scripts of node-pty and koffi, no `build/` folder exists for node-pty, and the packaged app loaded both from the prebuilt files in `resources/native`. node-gyp did not run. A clean Windows machine (or a fresh VM) must still run the packaged app.

### Package and memory on Windows

- Windows `dir` package: 361 MB unpacked, 156 MB as a zip. Electron is nearly all of it. The app's asar: 792 KB. The server: 819 KB.
- node-pty, `win32-x64` only and with no `.pdb` files: 1.7 MB. `OpenConsole.exe` is 1.0 MB of it.
- koffi, `win32_x64` only: 1.6 MB.
- The pty host's memory is the working set (`process.memoryUsage().rss`), not `VmRSS`, so it is not the same measure as on Linux:

| | Unpackaged | Packaged |
|---|---|---|
| Host idle, no terminal | 60-101 MB | 60 MB |
| One terminal holding 5,031 rows of 70 characters | 114-146 MB | 109 MB |

- One full terminal costs about 45-55 MB here. Windows trims working sets, so the idle number moved between runs.

### Windows: other findings

- The plugin's hooks run on Windows with `node "${CLAUDE_PLUGIN_ROOT}/hooks/log.mjs"`. They gave the same events, in the same order, as on Linux.
- The folder-trust prompt did not show: `claude` already trusted the test repo.
- The checks opened no console window that stayed. The count of console hosts (`conhost.exe`, `OpenConsole.exe`) was the same before and after check 4. The own-console child opened one minimized window, and the job closed it.

### Design changes for Windows

These change [terminal-host.md](terminal-host.md). They are not yet in that file.

1. **A Job Object per run is required on Windows.** Use `KILL_ON_JOB_CLOSE`, no breakaway, a handle that is not inheritable, and the pty host as the only holder. This replaces the env marker sweeps and the systemd scope on Windows. It also covers a host crash, an app crash, and an OS shutdown with no sweep at the next start.
2. **Ending a run on Windows** (decision 23): close the ConPTY, wait up to 3 s for the `claude` process only, call `TerminateJobObject`, check that the job is empty, then close the handle. Do not wait for the whole job: a detached child never ends on ConPTY close, so that wait always runs the full 3 s.
3. **Drop the tree by PID on Windows,** or keep it only as a fallback when the job can't be made. It found nothing that the job missed, it misses orphans, and PID reuse makes it unsafe.
4. **A native helper for Job Objects.** The plan chooses one: koffi (1.6 MB, prebuilt, FFI), or a small N-API addon of our own built in CI. node-pty has no Job Object support.
5. **Close the assign gap** with a launcher that joins the job first, or record it as a known limit.
6. **OS shutdown:** handle `session-end` with no waits: write the store, end every job, end the host.
7. **Known gap:** a process started by WMI, the Task Scheduler, or a COM server is outside the job. No way found to end it. State it, as for `env -i` on Linux.
8. **Electron tests on Windows** must kill main by the PID it reports, not by Playwright's process PID.

### Windows: not tested

- A clean Windows machine with no build tools (check 8). This machine has them.
- A real log off or shutdown. `session-end` was emitted by the test.
- Real `claude` with a turn, a tool, or its own children in flight at quit or crash.
- The assign gap with a child started in the first 60 ms.
- An installer (NSIS) build of the spike, and Windows arm64.
- The trust prompt on Windows.

### How to run it on Windows

On the branch `spike/terminal-host-windows`, in `packages/desktop` (PowerShell):

```powershell
pnpm install
node node_modules/electron/install.js   # the Electron binary, if pnpm skipped it
pnpm -w build                           # the server bundle
npx tsx spike/bundle.ts                 # dist-spike/
$env:SPIKE_TMP = '<scratch folder>'
node spike/checks.mjs                   # fake only: 2 3 4 4b 6 7 8-memory 10-echo
$env:SPIKE_APP_ENV = '{"OPENAFLOW_SPIKE_JOB":"0"}'; node spike/checks.mjs 6-host-crash 7-app-crash; Remove-Item Env:SPIKE_APP_ENV  # the same with no job
$env:SPIKE_REAL_REPO = '<test repo>'; $env:SPIKE_REAL_CLAUDE = '<path to claude.exe>'
node spike/checks.mjs 1-real-start 5-auto-continue 9-session-drift 11-plugin  # real claude, uses turns
node spike/checks.mjs 12w-real-kill                                          # real claude, no turns
npx tsx spike/package.ts; $env:SPIKE_PACKAGED = '1'; $env:SPIKE_ELECTRON = "$PWD\release-spike\win-unpacked\openaflow-spike.exe"
node spike/checks.mjs 8-package 8-memory 10-echo 7-app-crash
```

The app's server uses port 3300 (`SPIKE_API_PORT`). Each check gets its own config, ports, and data folders under `SPIKE_TMP`. `SPIKE_CASES` picks rows of the check 4 matrix by name.

## How to run it again

On the branch `spike/terminal-host`, in `packages/desktop`:

```sh
pnpm install
node node_modules/electron/install.js   # the Electron binary, if pnpm skipped it
pnpm -w build           # the server bundle
npx tsx spike/bundle.ts # dist-spike/
node spike/checks.mjs   # the fake-only checks: 2 3 4 6 7 8-memory
node spike/checks.mjs 1-real-start 5-auto-continue 5-auto-continue-bc 9-session-drift 11-plugin  # real claude, uses turns
node spike/checks.mjs 12-real-kill 12b-real-kill-variants  # real claude, no turns
npx tsx spike/package.ts && SPIKE_PACKAGED=1 SPIKE_ELECTRON=$PWD/release-spike/linux-unpacked/openaflow-spike node spike/checks.mjs 8-package 8-memory
```

Set `SPIKE_TMP` to a scratch folder. The real checks share one scratch repo in it, so the trust prompt shows only on the first one.

The repo's own suite on the spike branch: `pnpm verify` gives the same 4 failures as on `main` on this machine. They are in `packages/server` (`board-service`, `bundle-app`, `gh-exec`, `main` tests) and are not from the spike. They are Linux failures in a suite that CI runs on Windows.
