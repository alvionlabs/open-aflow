# open-aflow

Read `DESIGN.md` before any UI change. It holds all design rules.

## Private test setup

- The mock repo, the real-run test repo, and the commands to run against them are in `CLAUDE.local.md`. That file is local to the maintainer's machine and is not committed.

## Desktop app and browser version

- Users run the desktop app (`packages/desktop`). You can't see its window.
- To see and test the UI, run the browser version: `pnpm dev`, or `pnpm start` after `pnpm build`. Set `OPEN_AFLOW_CONFIG_DIR`, `OPEN_AFLOW_PORTS_DIR`, and `OPEN_AFLOW_CLAUDE_DIR` to a test folder first, and give `pnpm start` its own `OPEN_AFLOW_API_PORT`. Without them it uses the user's real config folder.
