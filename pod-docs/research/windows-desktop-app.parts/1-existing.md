# Research: Pod Board as a Windows desktop app (angle: existing)

_Generated: 2026-11-02 · Depth: standard · Researchers: 1 · Searches: 10 · Pages read: 11_

**Assumptions:** Audience undecided (one developer first). Windows first. The Node backend stays.

## What exists
| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| Electron | [utilityProcess docs](https://www.electronjs.org/docs/latest/api/utility-process) | Ships Chromium and Node. `utilityProcess.fork` runs a Node script as a child with Node enabled. stdin must be `ignore`. | Electron 42.5.0, 2026-06-23, Node 24.17.0 ([digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)) | not fetched | Closest fit: the backend runs as is, no Rust. |
| Tauri v2 + Node sidecar | [Tauri guide](https://tauri.app/learn/sidecar-nodejs) | Native window on WebView2. Node app compiled with `@yao-pkg/pkg`, registered in `externalBin`. | Active in 2026 (open issues from Mar 2026) | not fetched | Works, but needs the Rust toolchain and a sidecar. The guide's example is short-lived; for long-lived apps it points to a localhost server, stdio or sockets. |
| Wails | [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) | Go backend and OS WebView. v2.12.0 (2026-03-26), v3 alpha. | Alive; about 35K stars | not fetched | Poor: backend is Go, so Node would again be a sidecar. |
| Neutralinojs | [docs](https://neutralino.js.org/docs/) | Lightweight, uses the OS web view. Extensions in any language via IPC. | Docs link a GSoC 2026 page | not fetched | Weak: docs show no Node backend and no tray mention. |
| Deno desktop | [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) | Experimental `deno desktop` (Deno 2.9, 2026-06-25). | Canary only | not fetched | Not a fit: Deno, not Node. No Windows auto-update or one-step signing. |
| PWA plus Node service | n/a | Today's setup. | n/a | n/a | Not researched in this angle. |

### Real tools that wrap a local agent or dashboard
| Tool | Link | Choice | State |
|------|------|--------|-------|
| opcode (ex Claudia) | [repo](https://github.com/winfunc/opcode) | Tauri 2, Rust backend, React and Vite. 22.4k stars, AGPL-3.0. | No release published; users build from source (Rust, Bun, MSVC Build Tools, WebView2). Needs Claude CLI on PATH. |
| OpenCovibe | [HN Showcase](https://www.hnshowcase.com/post/47242137/opencovibe-a-local-first-desktop-ui-for-claude-code) | Tauri v2 and Svelte 5, Apache-2.0. | Mar 2026; author says "mainly tested on macOS". |
| Claude Code Desktop | [repo](https://github.com/oldpilluwu/Claude-Code-Desktop) | Electron, electron-builder, Vite. Spawns `claude` in a pty. | 0 stars, no releases. README warns of SmartScreen without signing. |
| Vibe Kanban | [repo](https://github.com/BloopAI/vibe-kanban) | Ships via `npx` (Rust and Node). | 28.6k stars, Apache-2.0, README says "sunsetting". Page does not mention Tauri. |

## Gaps and angles
- Size and memory are weakly sourced and Windows data is thin. Tauri on WebView2 is Chromium too. A Windows 10 test (Dec 2022, possibly stale) measured Tauri 399 MB vs Electron 318 MB on postman.com, and 370 vs 312 MB on vscode.dev. The author blamed WebKit vs Chromium for the gains on macOS and Linux. — [issue 5889](https://github.com/tauri-apps/tauri/issues/5889)
- One developer on Windows 11: Tauri installer about 2.5 MB vs Electron about 85 MB (Authme app); idle RAM about 80 MB vs about 120 MB. Vendor ranges: Tauri 3-15 MB, Electron 50-150 MB+. These are blog numbers. — [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)
- The Tauri size win shrinks with a sidecar: a Python sidecar of about 71 MB appears in a Windows bug report. A pkg Node binary embeds Node, so expect tens of MB (own inference). — [issue 15134](https://github.com/tauri-apps/tauri/issues/15134)
- Orphan sidecars on exit: Tauri tracked the launcher PID, not the real child. The gptme-tauri fix used `taskkill /F /T` and `prevent_exit()` so cleanup finishes first (Apr 2026, PyInstaller; may differ for pkg). — [blog](http://timetobuildbob.com/blog/the-launcher-is-not-the-process/)
- Windows NSIS reinstall of the same version left a stale `externalBin` sidecar (Windows 11, opened 2026-03-21, still open). Workaround: NSIS hooks that kill and delete the old file, plus a version bump. — [issue 15134](https://github.com/tauri-apps/tauri/issues/15134)
- Tauri agent wrappers found are early or source-only. No fetched source states a maintainer's regret: `no evidence found`.
- PATH on Windows GUI launch: `no evidence found` in this angle.

## Best practices
- With a Tauri sidecar, serve from `127.0.0.1` and call it from the webview; this suits a long-lived server. — [Tauri guide](https://tauri.app/learn/sidecar-nodejs)
- Kill the sidecar's whole process tree on every exit path. — [blog](http://timetobuildbob.com/blog/the-launcher-is-not-the-process/)
- Use NSIS hooks to stop the sidecar before an install or update. — [issue 15134](https://github.com/tauri-apps/tauri/issues/15134)
- With Electron, run the server in `utilityProcess`; set stdout to `pipe` to read logs. — [docs](https://www.electronjs.org/docs/latest/api/utility-process)
- Measure your own app on Windows; published numbers conflict. — [issue 5889](https://github.com/tauri-apps/tauri/issues/5889)

## Ideas to consider
- Minimal: keep the PWA and add a small launcher script (own idea).
- Electron shell that forks the existing server and loads localhost (grows from utilityProcess docs).
- Prototype Electron and Tauri with a pkg sidecar; measure installer size, idle RAM and exit cleanup on this machine (grows from the conflicting numbers).
- Bold: Tauri shell with tray, toasts, and a Rust watchdog that kills the sidecar tree (grows from the orphan issues).

## Questions for the plan
- Is the tray/toast need real enough to leave the PWA? — why: Tauri adds Rust and a sidecar for a small size win — options: stay PWA / Electron / Tauri
- Is a 2.5 MB vs 85 MB installer gain worth Rust, given the sidecar overhead and unclear RAM gain on WebView2? — options: Electron / Tauri
- Will others install it? — SmartScreen warns on unsigned installers (Claude Code Desktop README) — options: self-use unsigned / sign
- Is the Rust toolchain acceptable for a one-developer project? — opcode needs Rust, Bun, MSVC — options: yes / no

## Suspect pages
- none

## Sources
- Node.js as a sidecar (Tauri) — https://tauri.app/learn/sidecar-nodejs — undated
- Tauri issue 5889 — https://github.com/tauri-apps/tauri/issues/5889 — 2022-12 to 2024-05
- Tauri issue 15134 — https://github.com/tauri-apps/tauri/issues/15134 — 2026-03-21
- The launcher is not the process — http://timetobuildbob.com/blog/the-launcher-is-not-the-process/ — 2026-04-27
- Desktop apps web stack (digitalapplied) — https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026 — 2026-06-26
- Electron utilityProcess docs — https://www.electronjs.org/docs/latest/api/utility-process — undated
- Neutralinojs docs — https://neutralino.js.org/docs/ — undated
- opcode — https://github.com/winfunc/opcode — undated
- Claude Code Desktop — https://github.com/oldpilluwu/Claude-Code-Desktop — undated
- Vibe Kanban — https://github.com/BloopAI/vibe-kanban — undated
- OpenCovibe on HN Showcase — https://www.hnshowcase.com/post/47242137/opencovibe-a-local-first-desktop-ui-for-claude-code — 2026-03-04
