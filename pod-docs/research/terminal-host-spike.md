# Research: terminal-host spike findings

_Run: 2026-11-11 · Linux (Fedora 44, Wayland, Electron 45.2.1, Node 26.13.0, Claude Code 2.1.322) · Windows: not run · Used by: [terminal-host.md](terminal-host.md)_

**Status:** the spike ran on Linux only. Its own pass bar asks for Linux and Windows, so the spike is **not complete**. On Linux, every check passes, with these limits:

- Two checks passed only after a fix to the design: 5 (the draft rule) and 6 (a sweep after a host crash). See [Design changes](#design-changes).
- Part 5a ran with the first version of the gate. Its send path did not change, and the new gate opened at an idle prompt in the rerun.
- The 5b-c rerun verdict was set by hand. The check's file test hit a file left by the first run. The hook events and the screen show that nothing was approved.
- Check 8 ran check 1 on the packaged app with the fake `claude`, not the real one.
- A child that clears its env survives quit unless the run is in a systemd scope (an option in the spike).

Windows was not run. The human answered "No CI", and no run on a Windows machine is set up.

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

Linux only. "Fake" means the fake `claude` (`spike/fake-claude.mjs`); "real" means the user's own `claude` with `--model haiku`.

| # | Check | Linux | Windows | Evidence |
|---|---|---|---|---|
| 1 | Start and show (real) | Pass | Not run | `claude` answered `PONG`. The host buffer and the window's xterm both show it. |
| 2 | Window life (fake) | Pass | Not run | 113 numbered lines, each once and in order, after hide 10 s and show, a reload, and a destroyed and new window. |
| 3 | Server life (fake) | Pass | Not run | Server killed by PID. New server PID, `/api/health` 200. Terminal went 10 → 21 lines with no gap. |
| 4 | Clean quit (fake) | Pass | Not run | Dialog text and buttons correct; **Cancel** keeps app, run, and child. **Quit and end runs** leaves no process and no listening port. One gap, closed by a systemd scope; see [Ending a run](#ending-a-run). |
| 5 | Safe auto-continue (real) | Pass, after a fix | Not run | a) `continue` became a user turn in the transcript. b) Failed with the planned rules; passes with the draft rule. c) No send during a permission dialog held 70 s. |
| 6 | Host crash (fake) | Pass, after a fix | Not run | Host killed by PID. App started a new host. Run read `host crashed`; `claude` ended. A detached child survived until main swept it by marker (added after the first run). **Resume** started `claude --resume <uuid>`. |
| 7 | App crash (fake) | Pass | Not run | Run read `app closed` with its last saved screen. A detached child survived the crash; the start sweep ended it. Nothing started by itself. |
| 8 | Package and memory (fake) | Pass | Not run | Linux `dir` package. node-pty loaded with no build step. Checks 1 (fake start) and 4 passed on the packaged app. Sizes and memory below. |
| 9 | Session ID drift (real) | Finding | Not run | See [Session IDs](#session-ids). |
| 10 | Electron test | Pass | Not run | `spike/checks.mjs` runs every check with Playwright `_electron`. |
| 11 | Session-only plugin (real) | Pass | Not run | `/openaflow-spike:hello` ran the skill in the app. Plain `claude` in the same repo: `No commands match "/openaflow-spike:hello"`. |
| — | Real `claude` kills (real, no turn) | Finding | Not run | Real `claude` ended after a host crash (about 1 s, no sweep), a quit, and an app crash. See [Ending a run](#ending-a-run). |

Real `claude` use: 10 short Haiku turns (9 typed prompts and one skill run), counted from the transcripts. The human approved about 6-8. The extra turns came from check 5: one turn sent by the bug that the check found, and one rerun after the fix. The kill checks typed nothing and spent no turn.

## Findings

### node-pty

- `node-pty` 1.1.0 (latest) ships prebuilt binaries for `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64` only. On Linux, its install script runs `node-gyp rebuild`. This machine has no `g++`, so the install failed.
- `@lydell/node-pty` 1.2.0-beta.18 is a fork with prebuilt binaries for Linux, macOS, and Windows on x64 and arm64, in one optional package per platform. It loaded in an Electron 45 `utilityProcess` with no build step, unpackaged and packaged.
- It is a third-party beta. Options for the plan:
  - Use `@lydell/node-pty`. Pin it, and review each update.
  - Use `node-pty`, and build the Linux binary in our release workflow. Linux users then still get a prebuilt binary from us.
  - Wait for `node-pty` 1.2.0, which is in beta now (`1.2.0-beta.18`). _Not checked:_ whether its prebuilds include Linux.
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
6. **node-pty choice** is open: see [node-pty](#node-pty).

## Not tested

- Windows: every check. ConPTY, Job Objects, and packaging there.
- The gate during a question dialog (`AskUserQuestion`), a plan approval, and the trust prompt (default **No, exit**). Each may fire other hook events than a permission dialog.
- The gate with subagents or background work still running after `Stop`. The 60 s transcript idle rule stays for that case.
- macOS.
- The heartbeat banner (a host that hangs but stays alive).
- Flow control at 100,000 unacknowledged characters.
- A hosted session that loads the plugin twice (installed and `--plugin-dir`).
- The quit dialog by mouse: the test stubbed `dialog.showMessageBox`, because Playwright can't click native dialogs.
- Check 1 with real `claude` on the packaged app. The packaged run used the fake.

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
