# open-aflow

Read `DESIGN.md` before any UI change. It holds all design rules.

## UI checks with the mock repo

- `E:\Projects\pod-trial-mock` is a local, fake pod project for browser checks: each plan in its `pod-docs/` shows one flow state (`three-sprints`, `all-done`, `no-sprints`). Edit or add plans freely; it has no remote.
- Run any branch against it, not against the real repos (PowerShell, from the branch's checkout; change the ports to your own):

  ```
  $env:OPEN_AFLOW_CONFIG_DIR='E:\Projects\pod-trial-mock\.board\config'; $env:OPEN_AFLOW_PORTS_DIR='E:\Projects\pod-trial-mock\.board\ports'; $env:OPEN_AFLOW_CLAUDE_DIR='E:\Projects\pod-trial-mock\.board\claude'; $env:OPEN_AFLOW_API_PORT='3200'; $env:OPEN_AFLOW_WEB_PORT='3201'; pnpm dev
  ```

- The mock has no agents and no GitHub PRs, so live engineers, minutes, and PR states don't show there. For those, use fixture copies with fake transcripts in a temp folder.

## Real-run tests

- `E:\Projects\pod-board-run-test` (private GitHub repo `iamphduc/pod-board-run-test`) is for tests that need a real `claude` run and real PRs, such as Merge, Continue, and Quit in the installed app. Use it instead of creating a new repo.
- A real run costs tokens and needs the human's go-ahead. Keep each run to a one-line README change.

## Desktop app and browser version

- Users run the desktop app (`packages/desktop`). You can't see its window.
- To see and test the UI, run the browser version: `pnpm dev` against the mock repo as above, or `pnpm start` after `pnpm build`. `pnpm start` also needs the mock's `OPEN_AFLOW_CONFIG_DIR`, `OPEN_AFLOW_PORTS_DIR`, and `OPEN_AFLOW_CLAUDE_DIR` from the block above, and its own `OPEN_AFLOW_API_PORT`. Without them it uses the user's real config folder.
