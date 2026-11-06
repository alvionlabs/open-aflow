# Develop Open AFlow

The browser version of the board is for development. You and the agents run it
to see and check the UI. Users run the desktop app; see [the install note](install.md).

## Requirements

- Node.js 22 or later.
- pnpm. The version is pinned in `package.json` (`packageManager`). If you
  don't have pnpm, run `corepack enable pnpm`.

## Install dependencies

```sh
pnpm install
```

## Run the browser version

```sh
pnpm dev
```

This starts both servers on `127.0.0.1` only:

- API server: `http://127.0.0.1:3000` (health check at `/api/health`).
- Web app: `http://127.0.0.1:3001`. It proxies `/api` to the API server.

To use other ports, set `OPEN_AFLOW_API_PORT` and `OPEN_AFLOW_WEB_PORT`:

```sh
# macOS, Linux, Git Bash
OPEN_AFLOW_API_PORT=3010 OPEN_AFLOW_WEB_PORT=3011 pnpm dev
```

```powershell
# PowerShell
$env:OPEN_AFLOW_API_PORT = '3010'; $env:OPEN_AFLOW_WEB_PORT = '3011'; pnpm dev
```

A port must be an integer from 1 to 65535, or the server stops with an error
that names the variable.

### Run the production build

```sh
pnpm build
pnpm start
```

This serves the web app and the API on one port, on `127.0.0.1` only:
`http://127.0.0.1:47800`. If that port is busy, the server takes a free one for
this launch and logs it. The log line `open-aflow API listening on
http://127.0.0.1:<port>` shows the port in use. With no build, `pnpm start`
fails with Node's own error.

To use one fixed port, set `OPEN_AFLOW_API_PORT`. If that port is busy, the server
stops with an error. `OPEN_AFLOW_WEB_PORT` has no effect in production.

The build is in `packages/server/dist/app`: `server.mjs`, with every dependency
inside, and `web/`. You can move that folder anywhere and run `node server.mjs`.

Every setting is an `OPEN_AFLOW_*` environment variable. The full list, with defaults, is in [`pod-docs/feature-details/server.md`](../pod-docs/feature-details/server.md). To keep a dev run off your real config, set `OPEN_AFLOW_CONFIG_DIR`, `OPEN_AFLOW_PORTS_DIR`, and `OPEN_AFLOW_CLAUDE_DIR` to temp folders, as `CLAUDE.md` shows.

## Verify

```sh
pnpm verify
```

This runs `pnpm typecheck`, then `pnpm test` (Vitest), then `pnpm build`. CI
runs the same command on Windows only; macOS and Linux aren't checked.

## Layout

- `packages/model`: pod docs parsers and the run model. Pure functions, no I/O.
- `packages/server`: Hono API server: finds repos, watches their files, and serves the board.
- `packages/web`: React and Vite web app: the interface the desktop app shows.
- `packages/desktop`: Electron shell: window, tray, toasts, installer, and updates.

## License

[MIT](../LICENSE).
