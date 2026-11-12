# Automatic input: every way the app types for you

_Created: 2026-11-11 · Status: design, not built · Used by: [terminal-host.md](terminal-host.md)_

An automatic send writes into a live `claude` session that you may not be watching. A wrong send can drift the whole workflow: it can submit your draft, approve a permission dialog, or answer a question you never saw. So this doc lists every automatic input, with its gate and the tests it needs (decision 15 in [terminal-host.md](terminal-host.md#decisions-after-the-spike-human-2026-11-11)).

**Rule:** a PR that adds or changes an automatic input updates this doc and its tests in the same PR. An input that is not listed here must not exist.

## The one send path

Every entry below goes through one module (decision 16). No other code writes to a pty except your own keystrokes from the Terminal tab.

1. Check the gate (below). If a check fails, do not write. Log the attempt and the failed checks.
2. Write the word.
3. Wait a short pause (the spike used 300 ms), then write one Enter (`\r`). Never a second Enter.
4. Log: time, run, session ID, word, gate state.
5. Read the next `UserPromptSubmit` hook event for that session. Its `prompt` must be exactly the word. If it differs, or none comes in a set time: turn auto-continue off for that run, alert you, and log the real prompt.

## The gate

All of these must be true. Sources: spike check 5 ([terminal-host-spike.md](terminal-host-spike.md#auto-continue)) and decisions 13, 14, and 17.

| Check | Source | Why |
|---|---|---|
| The terminal is live | Host | A stopped run gets nothing until **Resume**. |
| Toggle on, or **Continue** pressed | Run setting | Off by default. |
| The run waits for this word | Model (sendable rule) | Don't send words the workflow doesn't expect. |
| Idle by the 60 s rule | Transcript and `subagents/` files | Covers subagents and background work, which hooks may miss. |
| Idle by hooks | Plugin hook state file | Newest of `SessionStart`, `Stop`, `Notification` `idle_prompt`, with no `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, or `Notification` `permission_prompt` after it. No hook state: no send. |
| No draft | Host input log | Typed with no Enter after the newest submit: blocked until the next submit. |
| Typing wait over | Host input log | 30 s by default, a setting. **Continue** skips this check only. |

## Inputs

| # | Input | Trigger | Writes | Gate | Status |
|---|---|---|---|---|---|
| 1 | Auto-continue | The run waits for its reply word, and the toggle is on | `continue` or `go`, then Enter | All checks | Design |
| 2 | **Continue** button | You press it in the Workflow view | Same as 1 | All checks except the typing wait. If blocked, it shows why ("Text in the input box", "Claude is asking for permission") and offers **Open terminal**. | Design |

Not automatic input, and kept that way:

- **The folder-trust prompt.** The app never answers it. Its default is **No, exit**.
- **Resume.** It starts a new `claude --resume <id>` process. It writes nothing into a live session.
- **Screen reading.** No input decision reads the screen.

## Known gaps

Each one needs a test before an input ships, or a reason why it can't happen.

| Gap | Risk | Status |
|---|---|---|
| Question dialog (`AskUserQuestion`) | Enter picks the highlighted answer. | Not tested. Hook events not known. |
| Plan approval (plan mode) | Enter may approve the plan. | Not tested. |
| Folder-trust prompt | Enter picks **No, exit** and ends the session. | Seen in the spike. Hook events not recorded. |
| Subagents or background work after `Stop` | The hook rule says idle while work goes on. | Not tested. The 60 s rule covers it for now. |
| A draft cleared with Ctrl+U or Backspace | The send stays blocked until the next submit. | Accepted: a missed send is safe. |
| Text and Enter in one chunk | Claude Code may take it as a paste and leave it in the box. | Not tested; the send path never does this. |
| A user with `defaultMode: auto` | Fewer dialogs, so fewer chances to see a dialog bug in testing. | Tests start `claude` with `--permission-mode default`. |
| The hook state file missing or late | The gate sees old state. | Not tested. No hook state means no send. |

## Tests each input needs

Run against the real Electron app with real `claude` (decision 11). An input ships only when all pass:

1. A send at an idle, empty prompt becomes exactly one user turn, with the exact word (check the transcript and `UserPromptSubmit`).
2. A draft blocks the send, also after the typing wait.
3. An open permission dialog blocks the send for at least 70 s, and nothing is approved (no `PostToolUse`).
4. An open question dialog blocks the send.
5. A plan approval blocks the send.
6. The folder-trust prompt blocks the send.
7. A subagent still running after `Stop` blocks the send.
8. A changed prompt (simulated) turns auto-continue off and alerts you.
9. A stopped run gets no send, also after a host restart and an app restart.
10. Every attempt, sent or not, is in the log with its gate state.
