# Sprint: one-port-server

_From plan: pod-docs/plans/windows-app.md · Slug: one-port-server · Status: done · Generated: 2026-11-02_
<!-- autopilot-run: started=2026-11-03T05:06:41Z sprints=0 waves=2 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | S1 | Production server: web app and API on one port, token in memory | one-port-server-S1 | [#73](https://github.com/iamphduc/pod-board/pull/73) merged | done | medium | — |
| 2 | K1 | One-file bundle, `pnpm start`, `LICENSE` | one-port-server-K1 | [#74](https://github.com/iamphduc/pod-board/pull/74) merged | done | medium | S1 |

## Shared contract

**Two modes, one wiring.** `startServer` holds all the wiring that `main.ts` has today.

```ts
// packages/server/src/start-server.ts (S1)
export type Production = { webDir: string; preferredPort?: number } // preferredPort defaults to APP_PORT; tests pass their own
export type Started = { port: number; stop(): void }
export function startServer(env: Env, o?: { production?: Production; exit?: (code: number) => void }): Promise<Started>
/** Calls startServer. On a rejection, prints `pod-board: <message>` and exits 1. Connects SIGINT and SIGTERM to `stop`. */
export function runMain(o?: { production?: Production }): Promise<void>

// packages/server/src/web-app.ts (S1)
/** Rejects with an error naming the folder when `dir` or its index.html is missing, or index.html has no </head>. */
export function createWebApp(o: { dir: string; token: string }): Promise<Hono>

// packages/server/src/listen.ts (S1)
export const APP_PORT = 47800
export function wantedPort(env: Env, preferred?: number): { port: number; fallback: boolean }
export function openWithFallback<T>(want: { port: number; fallback: boolean }, open: (port: number) => Promise<T>): Promise<T>

// packages/server/src/bundle-app.ts (K1)
export function bundleApp(o: { webDist: string; outDir: string }): Promise<{ externalImports: string[] }>
```

**Entries.** `src/main.ts` runs dev (`runMain()`). `src/main-production.ts` runs production (`runMain({ production: { webDir: <its own folder>/web } })`). It finds its folder from `import.meta.url`, never from `process.cwd()`.

| | Dev (`pnpm dev`, unchanged) | Production |
|---|---|---|
| Token | A new one per start, written to `<config dir>/session-token` before anything listens | A new one per start, in memory only. Never written. An existing `session-token` file stays as it is, so a `pnpm dev` page on the same config folder keeps working |
| Config folder | Created by the token write | Created at start. Failure stops the start with an error naming the folder. It must exist before the first Board, because `action-log.ts` doesn't create it and the watcher watches it |
| Port | `POD_BOARD_API_PORT`, default 3000, no fallback | See **Port** |
| Host and Origin | API port and `POD_BOARD_WEB_PORT` | The bound port only. `POD_BOARD_WEB_PORT` isn't read: a bad value stops nothing, and that port gets `403 forbidden host` |
| Page routes | 404 on the API port, as today | See **Answers** |

**Port (production).**
- `POD_BOARD_API_PORT` unset or empty: try `APP_PORT`. On `EADDRINUSE` or `EACCES` (Windows reserved ranges answer `EACCES`), take a free port from the OS for this launch and log `pod-board: port 47800 is busy; using <port> for this launch`. Any other listen error stops the start.
- `POD_BOARD_API_PORT` set: that port only. Busy stops the start with an error naming the variable and the port. A bad value stops the start as today (`portFromEnv`).
- The guards are built with the port that was really bound. No request reaches a guard built with any other port.
- Tests never bind 47800. They set `POD_BOARD_API_PORT` or pass `preferredPort`.

**Log line (both modes, unchanged text).** `pod-board API listening on http://127.0.0.1:<port>`. Tests and the smoke recipe read the port from it. The token is never logged.

**Answers (production).** `createWebApp` mounts after every API route in `createApp` (`AppDeps.web?: Hono`), so a real API route always wins and every web answer sits behind the request guard. With no `web`, `createApp` acts as today. First match wins, on the path without its query:

1. `/api`, `/api/`, or `/api/…`, any method → 404. `/apix` isn't under `/api`.
2. A method other than GET or HEAD → 404. The request guard checks `Origin` first.
3. `/` or `/index.html` → 200, `text/html; charset=utf-8`, the page with the token, `Cache-Control: no-store`.
4. A file listed at start, by exact path → 200 with its type. `/assets/…` gets `Cache-Control: public, max-age=31536000, immutable`. Any other file gets `no-cache`. A listed file that has since gone → 404, and the server keeps running.
5. A last path part that holds a dot (`/sw.js`, `/INDEX.HTML`, `/index.html::$DATA`) → 404.
6. Anything else → the same answer as rule 3.

- **404 body:** every 404 from the web app is `{"error":"not found"}`. Never HTML.
- **Files listed at start:** `createWebApp` walks the folder once. URL text is never joined to a disk path, so no spelling reaches a file outside the list. A file added later isn't served.
- **Page text:** read once at start. The token goes in on each response with the existing `injectTokenMeta`. The HTTP response is never cached, and nothing on disk holds the token.
- **Types:** `.html`, `.js`, `.css`, `.json`, `.png`, `.svg`, `.txt`, `.woff2`, and `.webmanifest` as `application/manifest+json`. Others are `application/octet-stream`.
- **HEAD** gets GET's status and headers with no body.

**Bundle layout (what `desktop-shell` copies through `extraResources`).** `packages/server/dist/app/server.mjs`, one ESM file with every dependency inside, and `packages/server/dist/app/web/`, the web build. The folder runs when moved anywhere with `node server.mjs`. `dist/` is already in `.gitignore`.

**Not this sprint.** Tool finder, stop message, parent watch, and the auto-continue owner file. Until the owner file ships, `pnpm start` and `pnpm dev` on one config folder can both auto-continue, so use separate config folders in checks. No change to existing mobile or accessibility code.

## Per-slice detail

### S1: Production server
- **Scope:** Move the wiring from `main.ts` into `startServer` and `runMain`, with no change to dev behavior. Build `createWebApp`, `wantedPort`, `openWithFallback`, the `web` seam in `createApp`, and `main-production.ts`, as the contract says. Validation errors and a failed token write now reject, and `runMain` turns them into today's exit 1. A failure of the web app stops the start before anything listens. Don't add a build step or a root script (K1), and don't change `guard.ts`, `session-token.ts`, `vite.config.ts`, or any file in `packages/web`. Update the serving notes in `server.md` and `app-shell.md`, including the `/sw.js` answer and that dev still answers it with HTML from Vite.
- **Files owned:** `packages/server/src/start-server.ts` (new), `packages/server/src/start-server.test.ts` (new), `packages/server/src/web-app.ts` (new), `packages/server/src/web-app.test.ts` (new), `packages/server/src/listen.ts` (new), `packages/server/src/listen.test.ts` (new), `packages/server/src/main-production.ts` (new), `packages/server/src/main.ts`, `packages/server/src/main.test.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`, `pod-docs/feature-details/server.md`, `pod-docs/feature-details/app-shell.md`
- **Success criteria:**
  - `[test] / and /index.html answer the page with the token meta and no-store — packages/server/src/web-app.test.ts › serves the page with its token, uncached`
  - `[test] An unknown path with no dot answers the same page; a query changes nothing — web-app.test.ts › page routes fall back to the page`
  - `[test] /sw.js, /assets/missing.js, and /INDEX.HTML answer 404 with no HTML — web-app.test.ts › a missing file is 404, not the page`
  - `[test] /api, /api/, and /api/nope answer 404 JSON on GET and POST, and /apix is a page route — web-app.test.ts › API paths never get the page`
  - `[test] Listed files answer with the right type, /manifest.webmanifest included — web-app.test.ts › files keep their content types`
  - `[test] /assets/ files are immutable and other files are no-cache — web-app.test.ts › cache headers by file kind`
  - `[test] Traversal spellings (encoded dots, %2f, %5c, %00) never answer a file beside the web folder — web-app.test.ts › no path reaches a file outside the folder`
  - `[test] A malformed escape (/%E0%A4%A) answers without a 500 — web-app.test.ts › a malformed path does not throw`
  - `[test] A file listed at start and then deleted answers 404, and the next request still works; a file added later is 404 — web-app.test.ts › the file list is fixed at start`
  - `[test] HEAD gets GET's status and headers with an empty body; POST / is 404 — web-app.test.ts › HEAD and other methods`
  - `[test] A missing folder, a missing index.html, and an index.html with no </head> each reject, naming the folder — web-app.test.ts › a bad web folder rejects`
  - `[test] Unset or empty env wants 47800 with fallback; a set value is strict; a bad value throws naming the variable — packages/server/src/listen.test.ts › wantedPort`
  - `[test] EADDRINUSE and EACCES fall back to a free port when fallback is on — listen.test.ts › falls back when the preferred port is unavailable`
  - `[test] Another listen error rejects, and a strict busy port rejects naming the variable and port — listen.test.ts › no fallback`
  - `[test] A real API route wins over a catch-all web app, and page routes reach it — packages/server/src/app.test.ts › web app mounts after the API`
  - `[test] A foreign Host on / answers 403 with no token in the body — app.test.ts › the web app sits behind the request guard`
  - `[test] Dev writes the token file and accepts Host on the API and web ports — packages/server/src/start-server.test.ts › dev keeps the token file and both ports`
  - `[test] Production writes no token file and leaves an existing one byte for byte — start-server.test.ts › production never touches the token file`
  - `[test] Production creates a missing config folder at start, and stops naming the folder when it can't — start-server.test.ts › production makes the config folder`
  - `[test] The page's token passes the action guard, and no token gets 403 — start-server.test.ts › the page's token works for actions`
  - `[test] Two starts give two tokens, and two requests in one start give the same one — start-server.test.ts › a new token per start`
  - `[test] Production accepts only the bound port, and a bad POD_BOARD_WEB_PORT stops nothing — start-server.test.ts › production ignores the web port`
  - `[test] A busy preferred port leads to a free one; Host on the free port passes and Host on the preferred port is 403 — start-server.test.ts › the Host check uses the real port`
  - `[test] A busy POD_BOARD_API_PORT rejects with no fallback — start-server.test.ts › an explicit busy port stops the start`
  - `[test] A bad web folder rejects before anything listens or watches — start-server.test.ts › a bad web folder stops the start`
  - `[test] stop ends through the existing shutdown and calls exit(0) — start-server.test.ts › stop uses the shared shutdown`
  - `[test] The dev entry still answers 404 on GET /, and the file's existing tests pass with no edits — packages/server/src/main.test.ts › the dev API serves no page`
  - `[test] The dev entry exits 1 on a bad port, naming the variable — main.test.ts › a bad port stops the dev server`
- **Depends on:** —
- **One-way door:** none. It's additive: a new entry and a new way to deliver the token in production, behind the same guards. Dev's token path doesn't change.
- **Model:** opus

### K1: One-file bundle, `pnpm start`, `LICENSE`
- **Scope:**
  - Build `bundleApp`. It empties `outDir`, bundles `main-production.ts` with every dependency inside, including `@pod-board/model` from source, and copies `webDist` to `<outDir>/web`. A CommonJS dependency's `require` of a Node builtin must work in the ESM file. `externalImports` lists what the output still imports. A missing `webDist/index.html` rejects, naming the folder.
  - Add `esbuild` as a server dev dependency, the version the lockfile already holds, plus a thin `packages/server/scripts/bundle.ts` and a `bundle` script in the server package.
  - Root scripts: `build` becomes `pnpm -r build && pnpm --filter @pod-board/server bundle`; `start` becomes `node packages/server/dist/app/server.mjs`. `dev` doesn't change. With no build, `pnpm start` fails with Node's own error.
  - The server package's own `start` script stays.
  - Add the MIT `LICENSE` at the repo root (`Copyright (c) 2026 Duc Pham`) and `"license": "MIT"` in the root `package.json`.
  - Update `README.md` (Run, Settings, License) and `codebase-structure.md` (Parts, How they connect, env, Smoke recipe with a production start and how to read the token from the page).
  - Don't change the release flow, Electron, or the install note. The next sprints own them.
  - Because `pnpm verify` runs tests before `build`, the test builds its own bundle to a temp folder from a small fake web build.
- **Files owned:** `packages/server/src/bundle-app.ts` (new), `packages/server/src/bundle-app.test.ts` (new), `packages/server/src/license.test.ts` (new), `packages/server/scripts/bundle.ts` (new), `LICENSE` (new), `packages/server/package.json`, `package.json`, `pnpm-lock.yaml`, `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria** (the run tests copy the output to a realpath'd temp folder outside the repo with no `node_modules`, run `node` with `cwd` in another temp folder, clear `NODE_PATH` and `POD_BOARD_*`, then set temp folders and a free `POD_BOARD_API_PORT`; teardown retries removal and each run test allows 60 s, as `main.test.ts` does):
  - `[test] The bundle imports only Node builtins — packages/server/src/bundle-app.test.ts › the bundle has no outside imports`
  - `[test] The output holds server.mjs and web/, and web/index.html has no token meta — bundle-app.test.ts › the output layout holds no token`
  - `[test] A second build removes files from the first — bundle-app.test.ts › a build clears old output`
  - `[test] A missing web build rejects, naming the folder — bundle-app.test.ts › a missing web build fails`
  - `[test] Run alone: /api/health is ok, / has the token meta, a page route answers the page, /sw.js and /api/nope are 404 — bundle-app.test.ts › runs alone outside the repo`
  - `[test] Run alone: an action with the page's token passes the guard, and one with no token gets 403 — bundle-app.test.ts › the page's token works in the bundle`
  - `[test] Run alone on a fresh config folder: POST /api/repos on a fixture copy puts it on the Board, and an edit to its pod docs reaches /api/events (model and chokidar work bundled) — bundle-app.test.ts › a repo reaches the Board and live updates`
  - `[test] Run alone: no session-token file appears in the config folder — bundle-app.test.ts › the bundle writes no token file`
  - `[test] With web/ removed, the process exits 1, naming the folder, and never logs the listening line — bundle-app.test.ts › a missing web folder stops the bundle`
  - `[test] Exits 0 on SIGTERM (skipped on Windows, as in main.test.ts) — bundle-app.test.ts › the bundle exits 0 on SIGTERM`
  - `[test] LICENSE holds the MIT grant and warranty text with the holder, and the root package says MIT — packages/server/src/license.test.ts › the repo is MIT licensed`
  - `[manual] With the mock repo's env from CLAUDE.md (no web port) and your own port, pnpm build then pnpm start: one port serves the board, the fonts load, a hard reload on a run's URL and on /some/page shows the board, and the runs of E:\Projects\pod-trial-mock render as they do in dev. Never use real repos. Run agent-browser from PowerShell, one command per call, with a time limit (pod-docs/known-issues/agent-browser-git-bash.md)`
  - `[manual] With the same env and two of your own ports, pnpm dev: both ports answer, the web page holds the token meta, and <config dir>/session-token exists — the dev check on the real Vite plugin and proxy`
  - `[manual] Before a build, on a clean dist: pnpm start fails with Node's error and a non-zero exit`
- **Depends on:** S1
- **One-way door:** none. All of it reverts with git. The human already chose MIT; a copy taken while the licence is public keeps it.
- **Model:** opus

## Sprint summary

- **Synced with merge-target:** up to date
- **Slices shipped:** S1, K1
- **Queue entries:** resolved 0, deferred 1 — third-party licence notices, for `installer-and-updates`
- **Slice log:**
  - S1: opus · medium · test-first partly — two dev-entry tests guard existing behavior, proved by mutation · runtime production entry, `pnpm dev`, browser on the mock · 5 NOTEs · time lost none
  - K1: opus · medium · test-first yes · runtime `pnpm build`, `pnpm start`, bundle run outside the repo, `pnpm dev`, browser on the mock · 9 NOTEs, 2 PENDINGs (1 re-judged as a NOTE: an output folder that overlaps the web build is refused) · time lost none
  - Wave fixes: none. Stalls: none.
- **Agent context at hand-back:** 467,089 tokens (planner, S1, K1) — *each agent's final context size, not tokens billed*

**For the next sprints:**
- The bundle layout is `packages/server/dist/app/server.mjs` and `web/`; the real web build also holds `fonts/`, `icons/`, and `manifest.webmanifest`.
- `main-production.ts` finds `web/` beside itself. Never leave `packages/server/src/web/` behind.
- A real `EACCES` from Windows reserved ports and the busy-47800 fallback through the bundle aren't yet proved.
- `agent-browser` ran through Bash with no hang in about 40 calls this sprint.
