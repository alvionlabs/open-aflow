# Research: Ship Pod Board as a native Windows desktop app (angle: building)

_Generated: 2026-11-02 · Depth: standard · Researchers: 1 · Searches: 3 · Pages read: 13_

**Assumptions:** Audience undecided (first user: one developer, one machine; others may install later). Backend stays Node. Windows first. Only the `building` angle was researched; other sections hold what I met along the way. Search results were leads only; every claim below rests on a fetched page.

## What exists
Approaches and libraries for packaging a Node server in a desktop shell.

| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| Node SEA (`--build-sea`) | [docs](https://nodejs.org/api/single-executable-applications.html) | Bakes one script plus assets into a Node `.exe`. `mainFormat: "module"` runs ESM. | In Node docs for v26.13; Stability 1.1 (active development); `--build-sea` needs v25.5+; `useVfs` is Stability 1.0 (v26.9+) | Node (MIT) | Good for a Tauri sidecar. Not needed with Electron. |
| Tauri sidecar (`externalBin`) | [docs](https://v2.tauri.app/develop/sidecar/) | Ships an extra binary named with the target triple (for example `-x86_64-pc-windows-msvc.exe`). Spawned via the shell plugin. | Current v2 docs | Apache-2.0/MIT (not on page) | Needs the Node server as a binary. Page says nothing about kill-on-exit. |
| Electron plus bundled server | [Electron app API](https://www.electronjs.org/docs/latest/api/app) | Runs the Node backend inside or beside the Electron main process. Gives login items, single-instance lock, AppUserModelID. | Current docs | MIT (not on page) | Closest fit: backend stays Node, no sidecar binary. |
| electron-builder | [issue #9580](https://github.com/electron-userland/electron-builder/issues/9580) | Packs Electron apps. Has pnpm hoisted-mode bugs in 26.3.x. | Active (26.7.0 in Feb 2026 thread) | MIT (not on page) | Works, but pin and check the version. |
| Electron Forge Vite plugin | [docs](https://www.electronforge.io/config/plugins/vite) | Vite build for Electron. Page advises externalizing native modules. | Current docs | MIT (not on page) | Page has no pnpm or monorepo guidance. |
| etherpad-desktop (real example) | [PR #54](https://github.com/ether/etherpad-desktop/pull/54) | Electron app that bundles a pnpm-based Node server. | PR only | n/a | Same shape: Node server in an Electron app on Windows. |
| Hono `serveStatic` | [docs](https://hono.dev/docs/getting-started/nodejs) | Serves built web files from `@hono/node-server`. | Current docs | MIT (not on page) | Serves the Vite build on one port. |

## Gaps and angles
- Hono `root` is relative to `process.cwd()`, not the source file. A packaged app has an arbitrary cwd, so build `root` from `import.meta.url` or pass an absolute path. The page documents no SPA fallback, so test client-side routes. — [Hono](https://hono.dev/docs/getting-started/nodejs)
- SEA ESM limits: `import.meta.url`, `dirname`, `filename` all point to `process.execPath`; `import.meta.resolve` is unsupported; `import`/`require` load only built-ins unless you bundle to one file or enable `useVfs`; `mainFormat: "module"` cannot combine with `useSnapshot`. Pod Board has no native modules, so the `.node` temp-file workaround does not apply. — [Node SEA](https://nodejs.org/api/single-executable-applications.html)
- SEA blobs must match the Node binary they go into. Cross-platform builds need `useCodeCache` and `useSnapshot` false. This means one build per OS in CI (Linux/Mac later). — [Node SEA](https://nodejs.org/api/single-executable-applications.html)
- pnpm symlinks break packaging on Windows. In etherpad-desktop, default `.pnpm` junctions dangled after a prune step and 7-Zip failed. The fix was `node-linker=hoisted`, costing about 135 MB. — [PR #54](https://github.com/ether/etherpad-desktop/pull/54)
- Hoisted mode has its own bug. electron-builder 26.3.1 broke all pnpm hoisted packages; 26.3.2+ fixed non-aliased ones; aliased dependencies reportedly still fail in 26.7.0. The build exits 0 with only a warning, and the reporter's installer shrank from about 434 MB to 212 MB with a runtime crash. A user report, not a maintainer statement. Check installer size and launch the packaged app in CI. — [issue #9580](https://github.com/electron-userland/electron-builder/issues/9580)
- Spawning `.cmd` shims (npm, gh, claude if installed by npm): since CVE-2024-27980 (April 2024), `spawn` of `.bat`/`.cmd` without `shell` throws `EINVAL`. Node's workaround is `shell: true` only if input is sanitized. — [Node advisory](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)
- The child_process docs list `shell: true`, `exec()`, or spawning `cmd.exe /c` for scripts. They warn never to pass unsanitized input, and that `args` with `shell: true` is deprecated (DEP0190). — [child_process](https://nodejs.org/api/child_process.html)
- `windowsHide` defaults to `false`, so each child (git, gh, claude) can flash a console window unless you set it. — [child_process](https://nodejs.org/api/child_process.html)
- Tauri kills no sidecar on exit by default, per the search summary. I could not confirm it on the fetched official page, which does not cover it. `no evidence found` from a fetched page. — [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)
- Resolving PATH when started from the Start menu (VS Code, GitHub Desktop): `no evidence found`. The VS Code page I read does not cover it. `shell-path` documents only the macOS problem and says nothing about Windows. — [shell-path](https://github.com/sindresorhus/shell-path)
- npm, winget, scoop, nvm install locations and child-tree kill (`taskkill /T`, job objects): `no evidence found` from fetched pages in this run.

## Best practices
- Bundle the server to one file (esbuild is the usual tool; not fetched, so unverified here) so SEA or Electron need no module resolution at run time. SEA only loads built-ins unless bundled or `useVfs`. — [Node SEA](https://nodejs.org/api/single-executable-applications.html)
- Anchor static root to `import.meta.url` or an absolute resolved path. — [Hono](https://hono.dev/docs/getting-started/nodejs)
- Spawn real executables (`git.exe`, `gh.exe`) with argument arrays and `windowsHide: true`. For `.cmd` shims, use `cmd.exe /c` or `shell: true` only with sanitized, quoted arguments. — [child_process](https://nodejs.org/api/child_process.html), [advisory](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)
- Do not use `--security-revert=CVE-2024-27980`. Node strongly advises against it. — [advisory](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)
- Windows toasts need a Start Menu shortcut with an AppUserModelID. Squirrel sets it in production; in dev call `app.setAppUserModelId()`. — [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)
- Start at login in Electron: `app.setLoginItemSettings({openAtLogin, path, args})`. Quote paths. Pass the same `path`/`args` to `getLoginItemSettings`. The login item name defaults to the AppUserModelID. For Squirrel point `path` to the stub launcher one directory up. — [Electron app](https://www.electronjs.org/docs/latest/api/app)
- Tauri autostart: `@tauri-apps/plugin-autostart` with `enable()`, `isEnabled()`, `disable()`. Grant capabilities. Needs Rust 1.90+. — [Tauri autostart](https://v2.tauri.app/plugin/autostart/)
- In CI, fail the build if the installer size drops or the packaged app does not start. — from [issue #9580](https://github.com/electron-userland/electron-builder/issues/9580)

## Ideas to consider
- Minimal: add `serveStatic` plus a `PORT` env to the Hono server, bundle with esbuild, run `node dist/server.js` with one port. No desktop shell yet. — grows from Hono/SEA gaps
- Electron shell that forks the bundled server as a child process and loads `http://127.0.0.1:<port>`. Keeps the backend Node, no rewrite. — grows from the Electron row
- Run the server in-process in the Electron main process, so exit kills it. Simpler lifecycle; a server crash then takes the UI down. (own idea)
- Use an electron-builder `extraResources` copy of a pre-bundled server, not `node_modules`, to sidestep pnpm hoisting. The server is already one bundle with no native modules. — grows from [PR #54](https://github.com/ether/etherpad-desktop/pull/54), [issue #9580](https://github.com/electron-userland/electron-builder/issues/9580)
- Use `pnpm deploy` or `node-linker=hoisted` only in a CI staging folder, so local dev keeps default pnpm. (own idea)
- Tauri shell with the server as a SEA sidecar (small shell, much more plumbing: triple naming, kill-on-exit, per-OS SEA builds). — grows from Tauri/SEA rows
- Dev-only first: a Windows Start-menu shortcut that runs the bundled server and opens the browser, with no shell. Cheapest for the "one developer" audience. (own idea)
- A single resolver module that finds `git`, `gh`, `claude` once at start (with a settings override) and spawns by absolute path. (own idea)

## Questions for the plan
- Electron or Tauri? — why it matters: Electron keeps Node in the shell (no sidecar); Tauri needs a SEA binary, target-triple naming, and manual child cleanup — options: Electron / Tauri + SEA / no shell
- Child process or in-process server? — why it matters: affects crash isolation and orphan processes on exit; Tauri docs I fetched do not cover kill-on-exit — options: fork child / in-process / SEA sidecar
- Which package manager layout for packaging? — why it matters: default pnpm junctions failed in one Windows build; hoisted costs about 135 MB and has electron-builder bugs in 26.3.x — options: pre-bundled server only / hoisted in CI / pin electron-builder 26.3.0
- How are `claude`, `gh`, `git` found? — why it matters: I found no fetched source on Windows PATH resolution; `.cmd` shims throw `EINVAL` without a shell — options: trust inherited PATH / resolve at start / user-set paths in settings
- Dev server in the same process as the shell? — why it matters: dev needs two ports, prod one; Hono root depends on cwd — options: prod only changes / unify both
- Is auto-update needed now? — why it matters: Squirrel and the login-item path interact; toasts need the AppUserModelID shortcut — options: skip for personal tool / electron-updater / Tauri updater
- Which Node does the app run? — why it matters: SEA features need v25.5+ (`--build-sea`) and the blob must match the binary; Electron ships its own Node — options: Electron's Node / pinned SEA Node

## Suspect pages
- none

## Sources
- Single executable applications — https://nodejs.org/api/single-executable-applications.html — v26.13 docs, fetched 2026-11-02
- child_process — https://nodejs.org/api/child_process.html — current, fetched 2026-11-02
- April 2024 security releases 2 — https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 — 2024-04 (over two years old; possibly stale, though the behavior persists in docs)
- Hono Node.js — https://hono.dev/docs/getting-started/nodejs — current
- Electron notifications — https://www.electronjs.org/docs/latest/tutorial/notifications — current
- Electron app API — https://www.electronjs.org/docs/latest/api/app — current
- electron-builder issue #9580 — https://github.com/electron-userland/electron-builder/issues/9580 — closed 2026-02-13
- etherpad-desktop PR #54 — https://github.com/ether/etherpad-desktop/pull/54 — date not shown
- Tauri sidecar — https://v2.tauri.app/develop/sidecar/ — current
- Tauri autostart — https://v2.tauri.app/plugin/autostart/ — current
- Electron Forge Vite plugin — https://www.electronforge.io/config/plugins/vite — current
- shell-path — https://github.com/sindresorhus/shell-path — date not shown
- VS Code terminal shell integration — https://code.visualstudio.com/docs/terminal/shell-integration — current (did not cover PATH resolution)
