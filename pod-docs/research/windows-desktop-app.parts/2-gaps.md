# Research: Windows desktop app for Pod Board - angle `gaps` (what shippers regret or miss)

_Generated: 2026-11-02 · Depth: standard · Researchers: 1 · Searches: 9 · Pages read: 13_

**Assumptions:** The audience is undecided: one developer on one machine now, others later. I mark where that changes the answer. Windows is first. Linux and Mac notes cover blockers only. The backend must stay Node. No source here tests Hono, chokidar or the Claude CLI. All findings are analogies from other apps.

## What exists
For `gaps`, this lists wrapper patterns that shippers wrote about. It is not a product survey.

| Name | Link | What it does | Alive? | License | How close to the idea |
|---|---|---|---|---|---|
| Tauri + Node sidecar (Paseo, Dolt Workbench, Dormouse/MouseTerm) | [Paseo](https://paseo.sh/blog/i-was-wrong-about-electron), [DoltHub](http://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/), [Dormouse PR 41](https://github.com/diffplug/dormouse/pull/41) | Native window with a Node server as a child binary | Posts and PRs dated Nov 2025 to May 2026 | not checked | Closest match to the parked idea. Paseo has the same Node daemon shape. |
| Electron (Paseo after switching back) | [Paseo](https://paseo.sh/blog/i-was-wrong-about-electron) | Node and Chromium bundled; the server runs in the main process | Paseo post is dated 28 May 2026 | not checked | Fits "backend stays Node". |
| Tauri with .NET or Python sidecar (Fluxzy, smoodit) | [Fluxzy HN mirror](https://hackernews-dynamic.seasondale.workers.dev/news/48187739), [smoodit](https://dev.to/kination/story-of-smoodit-1-electron-to-tauri-3n7e) | Positive migrations | not dated in my notes | not checked | The sidecar pattern works when the sidecar is a single binary. |

I found no evidence on Neutralinojs, Wails or a PWA with a Node service in the post-mortems.

## Gaps and angles
- **Node sidecar upkeep is the main regret.** Paseo had a Node daemon. Tauri's sidecar worked at first, but it became its own project: "different binaries for different platforms and target triples", plus packaging, permissions, process spawning, paths and upgrades. The author wrote "I was building Electron with extra steps" and said Electron has "Node pre-bundled". Windows was not where Tauri hurt. The pain was Linux (WebKitGTK) and notifications. — [Paseo, 2026-05-28](https://paseo.sh/blog/i-was-wrong-about-electron)
- **A Node server needs a packaging step under Tauri.** Tauri has no Node runtime, so DoltHub must compile its server into a binary with `pkg`. The team built the Tauri version but was "holding off" on migrating. Tauri supports only .exe and .msi on Windows, and they ship .appx. — [DoltHub, 2025-11-13](http://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/). For Pod Board, tsx is a dev runner. A shipped app would need a bundled server and a Node runtime or single-binary build. No source tested this with Hono or chokidar.
- **Orphaned Node on Windows is a known bug.** Force-killing the Tauri host left the Node sidecar running. The orphan locked `node.exe` and broke the next build. The cleanup relied on `RunEvent::Exit`, which does not fire on every close path. The fix was to run the sidecar in a Job Object with kill-on-close, through the `process-wrap` crate. — [Dormouse PR 41, 2026-05-01](https://github.com/diffplug/dormouse/pull/41)
- **A parent-PID poll is a second safety net.** "stdin EOF isn't reliably delivered to the Node sidecar on Windows" after a host crash. The sidecar polls the parent PID every 2 seconds and exits. — [MouseTerm PR 32, 2026-04-29](https://github.com/diffplug/mouseterm/pull/32)
- **Windows WebView2 was the smooth platform.** Paseo says the app "behaved close enough to what I expected" on Windows. Linux WebKitGTK is where reports of poor performance and missing features cluster. — [Paseo](https://paseo.sh/blog/i-was-wrong-about-electron), [HN thread, undated](https://hn.nuxt.dev/item/44118023). This matters for the "Linux next" plan.
- **Users' own words against Tauri.**
  - One commenter: OS webviews are "not stable, repeatable, consistent platforms to build upon."
  - One abandoned the 2.0 migration after "a slew of cryptic errors."
  - One found the docs "woefully inadequate".
  - One said Tauri "often requires dropping into Rust" for anything native.
  - One cited a "scattered" build, codesign and CD ecosystem.
  - — [HN thread, 84 comments, only the first half read](https://hn.nuxt.dev/item/44118023). These are anecdotes and the thread is old, so treat it as possibly stale.
- **Missing Electron features cost Rust work.** A Tauri migrator had to add a single-instance lock by hand with a named mutex on Windows, and fix a settings-window deadlock. Pod Board would need tray, notifications and single-instance. — [dev.to migration post, posted May 31, year not shown](https://dev.to/demonazgh/i-rewrote-my-electron-app-in-tauri-and-cut-the-installer-from-120mb-to-8mb-heres-what-actually-40lh)
- **Console windows flash when a GUI app spawns console programs.** Node's `spawn` defaults `windowsHide` to false, so git or gh opens a console. The Effect-TS fix hid non-detached children and replaced `taskkill` through `exec` (which starts a `cmd.exe`) with `execFile` and `windowsHide: true`. Merged 2026-08-09. — [Effect PR 7154](https://github.com/Effect-TS/effect/pull/7154). This hits Pod Board when it polls git and gh in a packaged app. A hidden-console fix inside the Node server works under any wrapper.
- **`.cmd` shims break `spawn` since April 2024.** Node throws `EINVAL` for `.bat` or `.cmd` files without `shell: true`. The advisory says to use `shell: true` only if the arguments are sanitized, and advises against `--security-revert`. npm-installed CLIs, such as the claude CLI, are often `.cmd` shims. — [Node advisory, 2024-04-10](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2). This is over two years old but still in force.
- **Stale PATH on Windows is real but thinly sourced.** A child process copies its parent's environment. An app launched by an installer kept the installer's old PATH. Launching through `explorer.exe` gave the current environment. — [Inno Setup thread, 2026-02](https://groups.google.com/g/innosetup/c/1TPxUCeGRkg). Start-menu launches are parented by Explorer, but I did not fetch a source that says how winget, scoop or nvm change PATH. `no evidence found` for those tools.
- **Unsigned apps hit a strong SmartScreen block.** Microsoft: "No signature: Strong SmartScreen block; enterprises may block entirely". Self-signed is blocked for public users. — [Microsoft Learn, updated 2026-08-29](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)
- **Signing does not remove the first-run warning.** EV no longer bypasses SmartScreen (changed 2024). Reputation builds over time with a consistent identity. — [Microsoft Learn](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options), [CodeNote, 2026-06-29](https://codenote.net/en/posts/windows-desktop-app-code-signing-distribution-japan-2026/). The CodeNote estimate of about 14 days is only a guess; it says reputation "depends on usage".
- **Signing cost in 2026.**

| Option | Cost | Limits |
|---|---|---|
| Azure Artifact Signing | about $9.99/month | Individuals: USA and Canada only. Organizations: USA, Canada, EU, UK. |
| OV certificate | $150-300/year | Worldwide. Hardware token or cloud HSM required. |
| EV certificate | $400+/year | Worldwide. No SmartScreen benefit. |
| Microsoft Store MSIX | Free | Microsoft re-signs; no SmartScreen warning. |
| SignPath Foundation | Free | Open-source projects only. |

  — [Microsoft Learn](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options). Certificate validity is capped at about 460 days from 2026-03-01 per [CodeNote](https://codenote.net/en/posts/windows-desktop-app-code-signing-distribution-japan-2026/).

## Best practices
- Run the Node server in a Windows Job Object with kill-on-close so the OS ends the tree. Add a parent-PID poll as a backstop. Do not rely on exit events. — [Dormouse PR 41](https://github.com/diffplug/dormouse/pull/41), [MouseTerm PR 32](https://github.com/diffplug/mouseterm/pull/32)
- Pass `windowsHide: true` on every `execFile` or `spawn` of git, gh or taskkill. Skip it for `detached` children. — [Effect PR 7154](https://github.com/Effect-TS/effect/pull/7154)
- Resolve `.cmd` shims on purpose. Use `shell: true` only with sanitized arguments, or run the underlying script with `node`. — [Node advisory](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)
- Do not assume the launch environment equals a terminal. Log the real `Path` the packaged app sees and compare it with a terminal. This is my inference from the Inno Setup thread, not a stated practice.
- Name sidecar binaries with the target triple. — [smoodit](https://dev.to/kination/story-of-smoodit-1-electron-to-tauri-3n7e)
- Sign every release with the same identity so reputation carries over. — [Microsoft Learn](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)

## Ideas to consider
Ideas are mine, not facts.
- **Minimal:** keep the PWA. Add a single "start" script or Start-menu shortcut that runs the bundled server hidden. Fixes the two-port friction with no wrapper. (own idea, from the parked note)
- Harden the Node server first, whatever the wrapper: `windowsHide`, `.cmd` shim handling, and a parent-PID self-exit. This work carries over to Tauri, Electron or a service. — grows from [Effect PR](https://github.com/Effect-TS/effect/pull/7154) and [MouseTerm PR](https://github.com/diffplug/mouseterm/pull/32)
- A small PATH-resolver module: at startup, find git, gh and claude through `where`, the registry PATH and known install folders. It adds a "tool not found" screen in the UI. (own idea)
- Electron shell for a single developer. It bundles Node, so the server can run in-process and there is no sidecar to build. Size matters little for one machine. — grows from [Paseo](https://paseo.sh/blog/i-was-wrong-about-electron)
- Tauri shell with a Job Object sidecar, only if a tray and native notifications are the goal. — grows from [Dormouse PR 41](https://github.com/diffplug/dormouse/pull/41)
- Ship unsigned for the first user and hand out via a `winget` or `scoop` manifest or a zip. Sign later if others install it. (own idea)
- Bold: Microsoft Store MSIX for free signing and no SmartScreen warning, if others will install. — grows from [Microsoft Learn](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)

## Questions for the plan
- Who is the second user, and when? — why it matters: an unsigned build is fine for one machine, but strangers hit a strong SmartScreen block and signing costs $120-300/year. — options: one machine only / friends with a click-through note / public with signing
- Is a tray icon and native notification worth Rust? — why it matters: this is the only Tauri gain the parked idea names, and Paseo and the dev.to migrator hit notification, tray and single-instance gaps. — options: PWA push only / Electron tray / Tauri tray
- Where does the Node runtime come from in a shipped build? — why it matters: tsx is not a shipped runtime. Tauri needs a `pkg`-style binary or a bundled node.exe. Electron includes Node. — options: bundle node.exe / single binary / require system Node
- Can you sign, and from where? — why it matters: Artifact Signing is US/Canada for individuals; OV works worldwide; Store MSIX is free but changes the packaging path. — options: skip signing / Artifact Signing / OV / Store MSIX
- Which tools must the app find, and how? — why it matters: gh, git and claude may come from winget, scoop, nvm or npm `.cmd` shims, and no source covered winget, scoop or nvm PATH behavior. — options: inherit PATH / resolve and cache at startup / user sets paths in settings
- Is Linux a hard requirement soon? — why it matters: WebKitGTK is the most-reported Tauri weakness, while Windows WebView2 was smooth. The user says Windows first, then Linux. — options: Electron for all / Tauri on Windows then re-check / PWA on Linux
- Should the app be one process tree with one lifetime? — why it matters: today two ports run under `pnpm dev`. A packaged build needs single-instance locking and clean shutdown. — options: one instance enforced / allow several windows on one server

## Suspect pages
none

## Sources
- I was wrong about Electron (Paseo) — https://paseo.sh/blog/i-was-wrong-about-electron — 2026-05-28
- Electron vs. Tauri (DoltHub) — http://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/ — 2025-11-13
- Dormouse PR 41 — https://github.com/diffplug/dormouse/pull/41 — 2026-05-01
- MouseTerm PR 32 — https://github.com/diffplug/mouseterm/pull/32 — 2026-04-29
- Effect-TS PR 7154 — https://github.com/Effect-TS/effect/pull/7154 — 2026-08-09
- Node.js April 2024 security releases — https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 — 2024-04-10 (stale, still in force)
- Inno Setup thread on stale PATH — https://groups.google.com/g/innosetup/c/1TPxUCeGRkg — 2026-02
- Code signing options (Microsoft Learn) — https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options — 2026-08-29
- Distributing a Windows Desktop App Safely from Japan (CodeNote) — https://codenote.net/en/posts/windows-desktop-app-code-signing-distribution-japan-2026/ — 2026-06-29
- Nuxt HN thread, "Show HN: I rewrote my Mac Electron app in Rust" — https://hn.nuxt.dev/item/44118023 — undated
- Rewrote Electron app in Tauri (dev.to) — https://dev.to/demonazgh/i-rewrote-my-electron-app-in-tauri-and-cut-the-installer-from-120mb-to-8mb-heres-what-actually-40lh — May 31, year not shown
- Story of smoodit (dev.to) — https://dev.to/kination/story-of-smoodit-1-electron-to-tauri-3n7e — undated
- Fluxzy, HN mirror — https://hackernews-dynamic.seasondale.workers.dev/news/48187739 — undated
