# Open AFlow

A local, read-only desktop app that shows every pod run across your repos:
each run's stage, the current wave's slices, what needs you, and each
engineer's live activity. See [docs/master-plan.md](docs/master-plan.md).

## Install

Use the Windows desktop app. To install it, follow [the install note](docs/install.md).

## Development

The browser version of the board is for development. You and the agents run it
to see and check the UI. Users run the desktop app.

### Requirements

- Node.js 22 or later.
- pnpm. The version is pinned in `package.json` (`packageManager`). If you
  don't have pnpm, run `corepack enable pnpm`.

### Install dependencies

```sh
pnpm install
```

### Run the browser version

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

#### Run the production build

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

When you open the production page, the board checks for `git`, `gh`, and `claude`.
If it can't find one, a setup check replaces the board. It shows how to install
the tool, and has a field for the path to the tool. `pnpm dev` has no setup check.

Set `CLAUDE*` variables in the `env` block of Claude's `settings.json`. Resumed
runs keep only `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_GIT_BASH_PATH` (absolute only),
and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from a shell, and drop the rest.

Don't run `pnpm start` and `pnpm dev` on one config folder if you use
auto-continue: both can send `continue`. Set `OPEN_AFLOW_CONFIG_DIR` to a different
folder for one of them.

## Add repos

The board shows every repo you register, plus every repo with a live pod run
(pod writes a claim file per run). To register one, use the Add a repo form on
the runs screen, or (under `pnpm dev`) send its absolute path with the session
token the API writes at each start to `session-token` next to its config file:

```sh
curl -s -X POST http://127.0.0.1:3000/api/repos   -H "Origin: http://127.0.0.1:3000" -H "Content-Type: application/json"   -H "X-Open-AFlow-Token: $(cat ~/.config/open-aflow/session-token)"   -d '{"path":"/home/you/code/my-repo"}'
```

The path must be a local folder: on Windows a drive path such as
`C:\code\my-repo`. A network share (`\\host\share`) is refused.

The list lives in the board's own config file, the only file it writes:
`%APPDATA%\open-aflow\config.json` on Windows,
`~/Library/Application Support/open-aflow/config.json` on macOS, and
`$XDG_CONFIG_HOME/open-aflow/config.json` (or `~/.config/open-aflow/config.json`)
elsewhere. It never writes inside a repo.

See the board as JSON at `http://127.0.0.1:3000/api/board`, and live updates
at `http://127.0.0.1:3000/api/events`.

## Settings

All optional, set as environment variables:

| Variable | What it does | Default |
|---|---|---|
| `OPEN_AFLOW_API_PORT` | Port of the API server. In production, the one port, with no fallback | `3000`. In production, `47800`, or a free port if it's busy |
| `OPEN_AFLOW_WEB_PORT` | Port of the web app. Only `pnpm dev` reads it | `3001` |
| `OPEN_AFLOW_CONFIG_DIR` | Folder for `config.json` | per OS, as above |
| `OPEN_AFLOW_PORTS_DIR` | Where pod writes its run claims | `<temp>/pod-ports` |
| `OPEN_AFLOW_CLAUDE_DIR` | Claude's folder, for agent transcripts (read only) | `CLAUDE_CONFIG_DIR`, else `~/.claude` |
| `OPEN_AFLOW_CLAUDE_BIN` | The `claude` program that Continue, Go, and auto-continue start | `claude` on `PATH` |
| `OPEN_AFLOW_TRANSCRIPT_DAYS` | How many days of sessions to read | `30` |
| `OPEN_AFLOW_POLL` | `1` watches files by polling, for network drives | off |

The board only accepts requests to `127.0.0.1` or `localhost` on its two
ports (in production, on its one port); any other `Host` gets a 403, and so does
a write from another site's page (`Origin`).

## Verify

```sh
pnpm verify
```

This runs `pnpm typecheck`, then `pnpm test` (Vitest), then `pnpm build`. CI
runs the same command on Windows only; macOS and Linux aren't checked.

## Layout

- `packages/model`: pod docs parsers and the run model. Pure functions, no I/O.
- `packages/server`: Hono API server: finds repos, watches their files, and serves the board.
- `packages/web`: React and Vite web app.

## License

[MIT](LICENSE).
