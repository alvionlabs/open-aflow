# Research: Pod Board as a native Windows desktop app

_Generated: 2026-11-02 · Depth: standard · Researchers: 4 · Searches: 30 · Pages read: about 82_

**Assumptions:** Audience undecided (one developer first). Windows first, then Linux, then Mac. The backend stays Node (Hono, chokidar, child processes for git, gh, claude). No source tested Hono, chokidar or the Claude CLI inside a wrapper. All findings are analogies from other apps. No mobile or accessibility content.

## What exists

### Shell options
| Name | Link | What it does | Alive? | License | How close to the idea |
|---|---|---|---|---|---|
| Electron | [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [app API](https://www.electronjs.org/docs/latest/api/app) | Ships Chromium and Node. `utilityProcess.fork` runs a Node script. Gives login items, single-instance lock, AppUserModelID. | Electron 42.5.0, 2026-06-23, Node 24.17.0 ([digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)) | not fetched | Closest. The backend runs as is. No Rust, no sidecar binary. |
| Tauri v2 + Node sidecar | [Tauri guide](https://tauri.app/learn/sidecar-nodejs), [sidecar docs](https://v2.tauri.app/develop/sidecar/) | WebView2 window. Node server shipped as a binary in `externalBin`, named with the target triple. | Active in 2026 | not fetched | Works, but needs Rust and a packaged Node binary. For long-lived apps the guide points to a localhost server. |
| Wails | [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) | Go backend, OS WebView. v2.12.0 (2026-03-26). | About 35K stars | not fetched | Poor. Node would be a sidecar again. |
| Neutralinojs | [docs](https://neutralino.js.org/docs/) | Light shell on the OS web view. | Docs link a GSoC 2026 page | not fetched | Weak. Docs show no Node backend. |
| Deno desktop | [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) | Experimental `deno desktop` (Deno 2.9). | Canary only | not fetched | Not a fit. |
| Node SEA | [docs](https://nodejs.org/api/single-executable-applications.html) | Bakes one script into a Node `.exe`. Stability 1.1. `--build-sea` needs v25.5+. | Node v26.13 docs | MIT-style Node license not fetched | Only needed for a Tauri sidecar. |

### Real tools that wrap a local agent or dashboard
| Tool | Link | Choice | State |
|---|---|---|---|
| opcode | [repo](https://github.com/winfunc/opcode) | Tauri 2, Rust backend, React and Vite. 22.4k stars, AGPL-3.0. | No release. Users build from source (Rust, Bun, MSVC). |
| OpenCovibe | [HN Showcase](https://www.hnshowcase.com/post/47242137/opencovibe-a-local-first-desktop-ui-for-claude-code) | Tauri v2, Svelte 5, Apache-2.0. | Mar 2026. "mainly tested on macOS". |
| Claude Code Desktop | [repo](https://github.com/oldpilluwu/Claude-Code-Desktop) | Electron, electron-builder, Vite. | 0 stars, no releases. README warns of SmartScreen. |
| Vibe Kanban | [repo](https://github.com/BloopAI/vibe-kanban) | Ships via `npx`. 28.6k stars, Apache-2.0. | README says "sunsetting". |
| Paseo | [post](https://paseo.sh/blog/i-was-wrong-about-electron) | Node daemon. Tried Tauri, went back to Electron (2026-05-28). | Same shape as Pod Board. |
| DoltHub Workbench | [post](http://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/) | Built a Tauri version with a `pkg` server. | "Holding off" on migrating (2025-11-13). |
| etherpad-desktop | [PR #54](https://github.com/ether/etherpad-desktop/pull/54) | Electron app that bundles a pnpm Node server on Windows. | PR only. |

## Gaps and angles
- **Electron or Tauri: sources split.**
  - Paseo: the Tauri Node sidecar "became its own project" (per-triple binaries, packaging, permissions, paths, upgrades). "I was building Electron with extra steps." Windows was not where Tauri hurt. Linux WebKitGTK and notifications were. — [Paseo](https://paseo.sh/blog/i-was-wrong-about-electron)
  - Part 1 found no maintainer's regret about Tauri; its wrappers are early or source-only. — angles disagree: part 1 found no regret and part 2 found Paseo's. Paseo is one post, so the regret rests on one author.
  - Older HN comments call OS webviews inconsistent and Tauri docs thin. Anecdotes, possibly stale. — [HN thread](https://hn.nuxt.dev/item/44118023)
- **Size win is uncertain.**
  - One Windows 11 developer: Tauri installer about 2.5 MB vs Electron about 85 MB; idle RAM about 80 vs about 120 MB. Blog numbers. — [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)
  - A Windows 10 test (Dec 2022, possibly stale) measured Tauri 399 MB vs Electron 318 MB on one site. — [issue 5889](https://github.com/tauri-apps/tauri/issues/5889)
  - A sidecar adds tens of MB (own inference from a 71 MB Python sidecar in [issue 15134](https://github.com/tauri-apps/tauri/issues/15134)).
- **Orphan child processes on exit.**
  - Part 1 reports orphans. Tauri tracked the launcher PID, not the real child. The fix used `taskkill /F /T`. — [blog](http://timetobuildbob.com/blog/the-launcher-is-not-the-process/)
  - Part 4 read the plugin source. The shell plugin calls `child.kill()` on each stored child at `RunEvent::Exit`, for sidecars too. — [lib.rs](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/lib.rs), [commands.rs](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/commands.rs)
  - — angles disagree: part 1 says orphans happen; part 4 shows cleanup exists but kills one PID, not the tree, and not on a crash. A 2022 maintainer comment said `std::process::exit` "will skip the sidecar cleanup". — [tauri#1896](https://github.com/tauri-apps/tauri/issues/1896)
  - Windows case: a force-killed Tauri host left Node running. It locked `node.exe` and broke the next build. Fix: a Job Object with kill-on-close. — [Dormouse PR 41](https://github.com/diffplug/dormouse/pull/41), 2026-05-01
  - Stdin EOF is "not reliably delivered" to Node on Windows after a host crash. Fix: poll the parent PID every 2 s. — [MouseTerm PR 32](https://github.com/diffplug/mouseterm/pull/32)
  - Electron `utilityProcess` docs say nothing about exit cleanup. Treat it as not cleaned. `before-quit` and `will-quit` do not fire on Windows shutdown, restart or logoff. — [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [app API](https://www.electronjs.org/docs/latest/api/app)
- **Windows NSIS reinstall left a stale sidecar** (Tauri, opened 2026-03-21, still open). Workaround: NSIS hooks. — [issue 15134](https://github.com/tauri-apps/tauri/issues/15134)
- **Child-process traps in the Node server (apply to any shell).**
  - `windowsHide` defaults to `false`, so git, gh and claude can flash console windows. — [child_process](https://nodejs.org/api/child_process.html), [Effect PR 7154](https://github.com/Effect-TS/effect/pull/7154)
  - Since April 2024 `.bat` and `.cmd` need `shell: true` or Node throws `EINVAL`. Sanitize arguments. (Over two years old, still in force.) — [advisory](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)
- **PATH on a GUI launch.**
  - A child inherits its parent's environment. Registry PATH edits reach apps only after a `WM_SETTINGCHANGE` broadcast. Inference: a Start-menu app may get a stale PATH. — [Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables), [WM_SETTINGCHANGE](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange)
  - VS Code resolves the shell environment with a 10 s timeout. — [VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq)
  - GitHub Desktop finds Git Bash by a registry lookup. — [shell-integration](https://github.com/desktop/desktop/blob/development/docs/technical/shell-integration.md)
  - Tool folders: Scoop `C:\Users\<name>\scoop`; npm global `%AppData%\npm`. — [Scoop](https://github.com/ScoopInstaller/Scoop), [npm folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders)
- **Packaging the server.**
  - Hono `serveStatic` `root` is relative to `process.cwd()`. A packaged app has an arbitrary cwd. No SPA fallback is documented. — [Hono](https://hono.dev/docs/getting-started/nodejs)
  - SEA: `import.meta.url` points at `process.execPath`; imports load only built-ins unless you bundle to one file; one build per OS. — [Node SEA](https://nodejs.org/api/single-executable-applications.html)
  - pnpm junctions dangled in a Windows Electron build. `node-linker=hoisted` fixed it for about 135 MB. — [PR #54](https://github.com/ether/etherpad-desktop/pull/54)
  - electron-builder 26.3.1 broke hoisted packages; aliased dependencies reportedly still fail in 26.7.0. The build exits 0 with a warning. User report. — [issue #9580](https://github.com/electron-userland/electron-builder/issues/9580)
  - A bundled CJS dependency that calls `require("net")` fails in ESM unless you add a `createRequire` banner. Fix status since 2023: no evidence found. — [esbuild#2067](https://github.com/evanw/esbuild/pull/2067)
- **Signing and SmartScreen.**
  - Microsoft: no signature gives a "Strong SmartScreen block; enterprises may block entirely". — [Microsoft Learn](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options), 2026-08-29
  - EV no longer bypasses SmartScreen. Reputation builds over time. The "about 14 days" estimate is a guess. — [CodeNote](https://codenote.net/en/posts/windows-desktop-app-code-signing-distribution-japan-2026/)
  - Windows 11 Smart App Control "blocks unknown unsigned apps" and users cannot allow one app. — [Tauri signing](https://v2.tauri.app/distribute/sign/windows/)
  - MSIX packages must be signed. A self-signed cert is for local testing. — [Microsoft](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)

| Signing option | Cost | Limits |
|---|---|---|
| Azure Artifact Signing | about $9.99/month | Individuals: USA and Canada only |
| OV certificate | $150-300/year | Worldwide, hardware token or cloud HSM |
| EV certificate | $400+/year | No SmartScreen benefit |
| Microsoft Store MSIX | Free | Microsoft re-signs; no SmartScreen warning |
| SignPath Foundation | Free | Open-source only |

Source for the table: [Microsoft Learn](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options).

- **Installers and updates.**

| Option | Fit for a personal, per-user tool | Link |
|---|---|---|
| Tauri NSIS | Best Tauri fit. Per-user by default, no admin. | [docs](https://v2.tauri.app/distribute/windows-installer/) |
| electron-builder NSIS | Good. `perMachine` defaults to false. | [docs](https://www.electron.build/docs/nsis) |
| electron-forge Squirrel | Usable. It launches the app extra times at install and update. | [maker](https://www.electronforge.io/config/makers/squirrel.windows.md) |
| MSI (either) | No gain for one user. | [msi](https://www.electron.build/docs/msi) |

  - electron-updater on current master rejects an update when `publisherName` is missing, unless `win.verifyUpdateCodeSignature: false` is set. Pinned older versions may differ. — [NsisUpdater.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/NsisUpdater.ts), [verifier](https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts)
  - Tauri updater needs its own signature ("This cannot be disabled"). Losing the private key blocks new updates. — [Updater plugin](https://v2.tauri.app/plugin/updater/)
- **Tray and toasts.**
  - Electron `Tray` and Tauri `TrayIconBuilder` both support close-to-tray. Electron: a `window-all-closed` listener stops the quit. Tauri: `onCloseRequested`, `preventDefault`, `hide()`. — [Tray API](https://www.electronjs.org/docs/latest/api/tray), [Tauri tray](https://v2.tauri.app/learn/system-tray/), [window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
  - Tauri notifications "Only works for installed apps". Electron needs a Start Menu shortcut with an AppUserModelID. — [Tauri notification](https://v2.tauri.app/plugin/notification/), [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)
  - Missing Electron features cost Rust work in Tauri. One migrator wrote a single-instance lock by hand. — [dev.to](https://dev.to/demonazgh/i-rewrote-my-electron-app-in-tauri-and-cut-the-installer-from-120mb-to-8mb-heres-what-actually-40lh)
- **Linux next.** Tauri "Linux does not emit tray icon events". WebKitGTK is the most-reported Tauri weak point. — [Tauri tray](https://v2.tauri.app/learn/system-tray/), [Paseo](https://paseo.sh/blog/i-was-wrong-about-electron)

## Best practices
- Kill the whole process tree on quit: `taskkill /pid <pid> /t /f`. — [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
- For crashes, use a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, plus a parent-PID poll. A Node-level API for jobs: no evidence found. — [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Dormouse PR 41](https://github.com/diffplug/dormouse/pull/41)
- Pass `windowsHide: true` to every spawn of git, gh and taskkill. Skip it for detached children. — [Effect PR 7154](https://github.com/Effect-TS/effect/pull/7154)
- Spawn real `.exe` files with argument arrays. For `.cmd` shims, use `shell: true` only with sanitized arguments. — [child_process](https://nodejs.org/api/child_process.html)
- Bundle the server to one file with esbuild (`--platform=node`). Anchor the static root to `import.meta.url` or an absolute path. — [esbuild](https://esbuild.github.io/getting-started/), [Hono](https://hono.dev/docs/getting-started/nodejs)
- Serve the UI from `127.0.0.1` and load it in the window. — [Tauri guide](https://tauri.app/learn/sidecar-nodejs)
- Set the AppUserModelID once, and match the installer's value. — [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)
- In CI, fail the build if the installer shrinks or the packaged app does not start. — [issue #9580](https://github.com/electron-userland/electron-builder/issues/9580)
- Measure size, RAM and exit cleanup on your own machine. Published numbers conflict. — [issue 5889](https://github.com/tauri-apps/tauri/issues/5889)

## Ideas to consider
1. **Minimal: harden the server and add one-port mode.** Add `windowsHide`, `.cmd` handling and a parent-PID self-exit. Add `serveStatic` and a `PORT` variable. Run `node dist/server.js`. No shell yet. — grows from the Effect, MouseTerm and Hono items
2. **Zip plus Start-menu shortcut.** No installer, no signing. Test notifications first. — (own idea)
3. **Electron shell that forks the bundled server** and loads `http://127.0.0.1:<port>`. Package the pre-bundled server through `extraResources`, not `node_modules`. — grows from Paseo and PR #54
4. **Shared tree-kill helper.** `taskkill /t /f` on quit, a PID file, and an orphan sweep at next start. Works under any shell. — grows from the launcher write-up and the `will-quit` gap
5. **Tool resolver.** Find git, gh and claude at start. Merge the registry Path, probe known folders, allow a settings override, and show a "tool not found" screen. — grows from the PATH gaps
6. **Tray-first mode.** Close hides the window, the server keeps running, and the tray has Open and Quit. — grows from the tray docs
7. **Two-day spike.** Build Electron and Tauri with a SEA sidecar. Compare installer size, idle RAM and exit cleanup. — grows from the conflicting numbers
8. **Bold: signed, auto-updating installer** (Artifact Signing or Store MSIX) for outside users. — grows from the signing gaps

## Questions for the plan
1. **Who installs it besides you, and when?** — why it matters: unsigned is fine for you. Others meet a SmartScreen block, and Smart App Control may block it outright. Signing costs about $120-300/year. — options: me only / friends with a click-through note / public with signing
2. **Electron or Tauri?** — why it matters: Electron keeps Node in the shell. Tauri needs Rust, a SEA binary and manual cleanup, for a size win that is unclear on WebView2. Linux is Tauri's weak spot. — options: Electron / Tauri + SEA sidecar / stay PWA with a launcher
3. **Do you need a tray and OS toasts in v1?** — why it matters: they are the main reason to leave the PWA. Toasts need an installed app. — options: skip / in-app only / Electron tray / Tauri tray
4. **How must children die on quit and on crash?** — why it matters: plugin and hook cleanup kill one PID. Crashes skip hooks. — options: hook tree-kill / Job Object launcher / PID-file sweep
5. **Run the server in-process or as a child?** — why it matters: in-process exits with the app but a server crash takes the UI down. — options: in-process / fork child / SEA sidecar
6. **Where do git, gh and claude come from?** — why it matters: a Start-menu launch may inherit a stale PATH. — options: trust inherited PATH / merge registry Path / user-set paths / probe known folders
7. **Is auto-update needed?** — why it matters: electron-updater needs `verifyUpdateCodeSignature: false` when unsigned. Tauri needs a private key you must keep. — options: manual download / electron-updater opt-out / Tauri updater
8. **How do you bundle the server and the pnpm layout?** — why it matters: junctions failed once; hoisted costs about 135 MB and has electron-builder bugs. — options: pre-bundled server only / hoisted in CI / pin electron-builder 26.3.0

## Suspect pages
- none

## Sources
- Node.js as a sidecar (Tauri) — https://tauri.app/learn/sidecar-nodejs — undated
- Tauri sidecar — https://v2.tauri.app/develop/sidecar/ — current
- Tauri issue 5889 — https://github.com/tauri-apps/tauri/issues/5889 — 2022-12 to 2024-05 (possibly stale)
- Tauri issue 15134 — https://github.com/tauri-apps/tauri/issues/15134 — 2026-03-21
- Tauri issue 1896 — https://github.com/tauri-apps/tauri/issues/1896 — 2021-05 to 2022-11 (possibly stale)
- The launcher is not the process — http://timetobuildbob.com/blog/the-launcher-is-not-the-process/ — 2026-04-27
- Desktop apps web stack (digitalapplied) — https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026 — 2026-06-26
- Electron utilityProcess — https://www.electronjs.org/docs/latest/api/utility-process — undated
- Electron app API — https://www.electronjs.org/docs/latest/api/app — undated
- Electron autoUpdater — https://www.electronjs.org/docs/latest/api/auto-updater — undated
- Electron Tray API — https://www.electronjs.org/docs/latest/api/tray — undated
- Electron notifications — https://www.electronjs.org/docs/latest/tutorial/notifications — undated
- Neutralinojs docs — https://neutralino.js.org/docs/ — undated
- opcode — https://github.com/winfunc/opcode — undated
- Claude Code Desktop — https://github.com/oldpilluwu/Claude-Code-Desktop — undated
- Vibe Kanban — https://github.com/BloopAI/vibe-kanban — undated
- OpenCovibe — https://www.hnshowcase.com/post/47242137/opencovibe-a-local-first-desktop-ui-for-claude-code — 2026-03-04
- I was wrong about Electron (Paseo) — https://paseo.sh/blog/i-was-wrong-about-electron — 2026-05-28
- Electron vs. Tauri (DoltHub) — http://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/ — 2025-11-13
- Dormouse PR 41 — https://github.com/diffplug/dormouse/pull/41 — 2026-05-01
- MouseTerm PR 32 — https://github.com/diffplug/mouseterm/pull/32 — 2026-04-29
- Effect-TS PR 7154 — https://github.com/Effect-TS/effect/pull/7154 — 2026-08-09
- HN thread — https://hn.nuxt.dev/item/44118023 — undated (possibly stale)
- Rewrote Electron app in Tauri (dev.to) — https://dev.to/demonazgh/i-rewrote-my-electron-app-in-tauri-and-cut-the-installer-from-120mb-to-8mb-heres-what-actually-40lh — May 31, year not shown
- Node SEA — https://nodejs.org/api/single-executable-applications.html — v26.13 docs
- Node child_process — https://nodejs.org/api/child_process.html — current
- Node April 2024 security releases 2 — https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 — 2024-04-10 (stale, still in force)
- Hono Node.js — https://hono.dev/docs/getting-started/nodejs — current
- etherpad-desktop PR 54 — https://github.com/ether/etherpad-desktop/pull/54 — date not shown
- electron-builder issue 9580 — https://github.com/electron-userland/electron-builder/issues/9580 — closed 2026-02-13
- Code signing options (Microsoft Learn) — https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options — 2026-08-29
- CodeNote signing — https://codenote.net/en/posts/windows-desktop-app-code-signing-distribution-japan-2026/ — 2026-06-29
- Microsoft: sign an MSIX — https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview — 2026-04-14
- Tauri Windows signing — https://v2.tauri.app/distribute/sign/windows/ — undated
- Tauri Windows installer — https://v2.tauri.app/distribute/windows-installer/ — undated
- Tauri updater — https://v2.tauri.app/plugin/updater/ — undated
- Tauri system tray — https://v2.tauri.app/learn/system-tray/ — undated
- Tauri window API — https://v2.tauri.app/reference/javascript/api/namespacewindow/ — undated
- Tauri notification — https://v2.tauri.app/plugin/notification/ — undated
- Tauri shell plugin lib.rs — https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/lib.rs — v2 branch
- Tauri shell plugin commands.rs — https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/commands.rs — v2 branch
- electron-builder NSIS — https://www.electron.build/docs/nsis — undated
- electron-builder MSI — https://www.electron.build/docs/msi — undated
- electron-forge Squirrel maker — https://www.electronforge.io/config/makers/squirrel.windows.md — undated
- electron-updater NsisUpdater.ts — https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/NsisUpdater.ts — master
- electron-updater verifier — https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts — master
- Microsoft: Environment Variables — https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables — 2025-07-14
- Microsoft: WM_SETTINGCHANGE — https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange — 2025-07-14
- Microsoft: Job Objects — https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects — 2025-07-14
- Microsoft: taskkill — https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill — 2026-02-16
- esbuild getting started — https://esbuild.github.io/getting-started/ — undated
- esbuild PR 2067 — https://github.com/evanw/esbuild/pull/2067 — closed 2023
- VS Code FAQ — https://code.visualstudio.com/docs/supporting/faq — undated
- GitHub Desktop shell integration — https://github.com/desktop/desktop/blob/development/docs/technical/shell-integration.md — undated
- Scoop — https://github.com/ScoopInstaller/Scoop — undated
- npm folders — https://docs.npmjs.com/cli/v10/configuring-npm/folders — undated

Not found: a maintainer's regret about Tauri in part 1's sources; electron-updater behavior with the GitHub provider; Electron `utilityProcess` behavior at Windows parent exit; a Node-level Job Object API; winget portable and nvm-windows folders; whether esbuild fixed `require` in ESM after 2023.
