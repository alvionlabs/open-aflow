# Idea: CLI runner

Status: superseded by [research/terminal-host.md](../research/terminal-host.md) (2026-11-11)

## The idea
The board's server runs your own `claude` binary with your own login:
- **Step in (phase 3):** `claude` in a pseudo-terminal (`node-pty`), shown in the browser with `xterm.js` over a WebSocket, so you can type into an engineer's session.
- **Runs without a chat (phase 4):** `claude -p --resume <session> --output-format stream-json "continue"`, rendered as board events, to resume after `go` or `continue` and start runs from the board.

Never `--bare`, which needs an API key. The `127.0.0.1` binding, the `Host` check, and a per-launch token are required from the phase that adds it, since a server that starts `claude` can run code on the machine.

## Why it's on hold
Phase 1 is read-only, and phases 3 and 4 are decided after using phases 1–2. `node-pty` is a native module with build risk on Windows, and Anthropic's headless billing rules changed several times in 2026.

## What would make it worth building
After phases 1–2, stepping into engineers or resuming runs from the board is still the main friction, and Anthropic's current policy allows running the user's own `claude` this way.
