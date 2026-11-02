# pod-board

Read `DESIGN.md` before any UI change. It holds all design rules.

## UI checks with the mock repo

- `E:\Projects\pod-trial-mock` is a local, fake pod project for browser checks: each plan in its `pod-docs/` shows one flow state (`three-sprints`, `all-done`, `no-sprints`). Edit or add plans freely; it has no remote.
- Run any branch against it, not against the real repos (PowerShell, from the branch's checkout; change the ports to your own):

  ```
  $env:POD_BOARD_CONFIG_DIR='E:\Projects\pod-trial-mock\.board\config'; $env:POD_BOARD_PORTS_DIR='E:\Projects\pod-trial-mock\.board\ports'; $env:POD_BOARD_CLAUDE_DIR='E:\Projects\pod-trial-mock\.board\claude'; $env:POD_BOARD_API_PORT='3200'; $env:POD_BOARD_WEB_PORT='3201'; pnpm dev
  ```

- The mock has no agents and no GitHub PRs, so live engineers, minutes, and PR states don't show there. For those, use fixture copies with fake transcripts in a temp folder.
