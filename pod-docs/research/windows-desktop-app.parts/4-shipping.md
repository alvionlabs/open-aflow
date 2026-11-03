# Research: Shipping Pod Board as a native Windows desktop app (installers, updates, tray, PATH, process trees, esbuild)

_Generated: 2026-11-02 · Depth: deep · Researchers: 1 · Searches: 8 · Pages read: about 45 fetched (about 15 returned 404 or empty and are not cited)_

**Assumptions:** Audience undecided. First user is one developer on one machine. Others may install later; the answer is split where it differs. Windows first. Linux and Mac appear only as blockers. "Unsigned" means no Authenticode certificate. Sources dated by their own page where a date showed; undated doc pages are marked "undated" and may be stale.

## What exists

### 1. Windows installers

| Option | Link | What it does | Alive? | License | Fit for a personal, per-user, no-admin tool |
|---|---|---|---|---|---|
| Tauri NSIS (`-setup.exe`) | [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/) | Default install mode "current user": no admin, app in `%LOCALAPPDATA%`. `perMachine` needs admin. `both` lets the user choose but then needs admin. Can be cross-built from Linux/Mac (page warns less tested). | Page undated | Tauri: not checked | Best fit. WebView2 bootstrapper is downloaded by default; Win10 (Apr 2018+) and Win11 already include it. |
| Tauri WiX MSI | same | `.msi` via WiX Toolset v3. Builds on Windows only. Install-mode list on the page is "NSIS only". | Page undated | not checked | Worse: no per-user mode documented, WiX v3 is an old toolchain. |
| electron-builder NSIS | [NsisOptions](https://www.electron.build/docs/api/app-builder-lib.Interface.NsisOptions), [nsis](https://www.electron.build/docs/nsis) | `oneClick` default `true`; `perMachine` default `false`; with `oneClick:false` an install-mode page shows. `allowElevation` default `true` (assisted installer only). The page does not say "per-user needs no admin" in so many words. | Page undated | not checked | Good fit; per-user is the default. |
| electron-builder MSI | [msi](https://www.electron.build/docs/msi) | `perMachine:false` default: "installs for the current user only, no admin required". Warns that per-user can land in the SYSTEM profile under Intune/SCCM. | Page undated | not checked | Works, but MSI adds nothing for one user. |
| electron-builder Squirrel | [SquirrelWindowsOptions.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/options/SquirrelWindowsOptions.ts) | Option file exists. The inner installer of the Squirrel MSI is unsigned: "the build warns, and fails with `forceCodeSigning`". Deprecation status: no evidence found. | n/a | n/a | Skip; NSIS is the electron-builder default path. |
| electron-forge Squirrel.Windows | [maker page](https://www.electronforge.io/config/makers/squirrel.windows.md) | "no-prompt, no-hassle, no-admin". Outputs `Setup.exe`, `.nupkg`, `RELEASES`. Needs `electron-squirrel-startup` and an early `app.quit()`; app names with spaces misbehave. Builds on Windows, or Linux with mono+wine. | Page undated | not checked | Usable. Squirrel launches the app extra times at install/update/uninstall, which the server must tolerate. |
| electron-forge WiX MSI | [maker page](https://www.electronforge.io/config/makers/wix-msi.md) | Needs WiX v3 installed. The page itself recommends Squirrel over MSI, "mainly for enterprises". | Page undated | not checked | Skip. |
| electron-forge MSIX | [maker page](https://www.electronforge.io/config/makers/msix.md) | Builds only on Win10/11 with the Windows SDK. Signing via `windowsSignOptions`. | Page undated | not checked | Poor for unsigned use: see next row. |
| MSIX (platform rule) | [Microsoft: sign an MSIX](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview) | "Windows requires MSIX packages to be signed", and the cert must be trusted on the device. Self-signed is listed as free for "development and local testing". Dated 2026-04-14. | Fresh | n/a | Hard to ship unsigned; fine only for one dev machine with a self-signed cert (trust-store steps: no evidence found). |

The electron-forge maker index fetched lists Squirrel, WiX MSI, MSIX and AppX, and no NSIS maker. Forge users who want NSIS use electron-builder instead.

### 2. Auto-update

| Stack | Link | Behavior unsigned on Windows | Notes |
|---|---|---|---|
| electron-updater (NSIS) | [NsisUpdater.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/NsisUpdater.ts), [verifier](https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts) | On current master, an update is **rejected** when `app-update.yml` has no `publisherName`, unless `win.verifyUpdateCodeSignature: false` is set at build time. The verifier is "fail-closed". | So an unsigned personal build must opt out explicitly. Source is master at fetch time; a pinned older version may differ. The pages describe GitHub Releases only indirectly; GitHub provider docs: no evidence found (electron.build auto-update page returned 404). |
| Electron built-in `autoUpdater` (Squirrel.Windows) | [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater), [Updates tutorial](https://www.electronjs.org/docs/latest/tutorial/updates) | Page states a signing requirement only for macOS. No statement for Windows either way. | `update.electronjs.org` needs a public GitHub repo, GitHub Releases, and signing "(macOS only)". |
| Tauri updater | [Updater plugin](https://v2.tauri.app/plugin/updater/) | Needs its own signature "This cannot be disabled", separate from Windows code signing. The page does not mention Authenticode. | Public key in `tauri.conf.json`; private key via `TAURI_SIGNING_PRIVATE_KEY` env var; "if you lose this key you will NOT be able to publish new updates". GitHub Releases `latest.json` works; Tauri Action can generate it. Windows app exits when the installer runs. `installMode`: `passive` default; `quiet` only for per-user installs. |

Unsigned runs at all: [Tauri signing page](https://v2.tauri.app/distribute/sign/windows/) says signing is not required to run if the user accepts the SmartScreen warning, but Windows 11 Smart App Control "blocks unknown unsigned apps even if they weren't downloaded from the browser" and users cannot allow one app. Electron equivalent: no evidence found.

### 3. Tray

| Stack | Link | What it does |
|---|---|---|
| Electron `Tray` | [Tray API](https://www.electronjs.org/docs/latest/api/tray), [tutorial](https://www.electronjs.org/docs/latest/tutorial/tray) | `new Tray(image, [guid])`. Use ICO on Windows. `click`, `right-click`, `double-click` fire on Windows. A `guid` binds to the file path for non-signed exes, so a moved exe breaks the icon; use it "only in conjunction with code-signed executable". Close-to-tray: add a `window-all-closed` listener; "having this listener active will prevent the app from quitting". The base templates quit on Windows/Linux. Garbage-collection warning: not on the fetched page. |
| Tauri v2 tray | [System tray](https://v2.tauri.app/learn/system-tray/), [window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) | Enable the `tray-icon` feature; build with `TrayIconBuilder`. Menu opens on left and right click by default (`show_menu_on_left_click(false)` to change). Quit item calls `app.exit(0)`. Close-to-tray is not on the tray page. The window API shows `onCloseRequested` + `event.preventDefault()` + `hide()`; `preventDefault` must run before the handler returns; `hide` needs the `core:window:allow-hide` permission; `destroy()` forces a real close. |

Linux blockers: Tauri "Linux does not emit tray icon events". Electron `click` on Linux "might not necessarily be left mouse click".

### 4. Tauri notifications on Windows
[Notification plugin](https://v2.tauri.app/plugin/notification/): "Only works for installed apps" and in development "Shows powershell name & icon". The page does not mention AppUserModelID. Electron states the mechanism: a Start Menu shortcut with an AppUserModelID is required ([Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)); Squirrel sets it; in dev call `app.setAppUserModelId()` and pin electron.exe. A 2017 issue says the ID of the notification "must match exactly the one defined for your process" ([electron#11331](https://github.com/electron/electron/issues/11331); possibly stale). Tauri-specific AUMID source: no evidence found.

## Gaps and angles

- **Unsigned electron-updater is not "just works".** It fails closed unless `verifyUpdateCodeSignature: false` is baked in. Tauri's updater works without Authenticode but its own key cannot be skipped. — [verifier](https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts), [Tauri updater](https://v2.tauri.app/plugin/updater/)
- **Process cleanup is only partly automatic.** Tauri shell plugin `lib.rs` states "all spawned child processes are killed when the application exits": on `RunEvent::Exit` it calls `child.kill()` on each stored child. `commands.rs` shows sidecar and non-sidecar spawns both go into that store. This **confirms** the default for plugin-spawned sidecars. — [lib.rs](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/lib.rs), [commands.rs](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/commands.rs). History: sidecar kill-on-drop landed 2021-06-01; in 2022 a maintainer said `std::process::exit` "will skip the sidecar cleanup" — [tauri#1896](https://github.com/tauri-apps/tauri/issues/1896). Raw files are the v2 branch at fetch time, not a pinned version.
- **Kill hits one PID, not the tree.** A 2026-04-27 write-up on a packaged sidecar: "When you call `child.kill()`, you SIGKILL the launcher"; the fix is the tree kill (`taskkill /F /T`). That was a PyInstaller launcher, so it is an analogy for Pod Board's git/gh/claude grandchildren, not proof. — [The launcher is not the process](http://timetobuildbob.com/blog/the-launcher-is-not-the-process/)
- **Electron `utilityProcess` on app exit: docs are silent.** The page documents `kill()` (on POSIX "will ensure the process is reaped on exit") and says nothing about Windows or parent exit. Treat it as not cleaned up; kill it yourself. — [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process). Windows-specific evidence of orphans: no evidence found (the one bug report I found did not load).
- **`before-quit`/`will-quit` do not fire on Windows shutdown, restart or logoff** — so quit hooks cannot be the only cleanup. — [Electron app API](https://www.electronjs.org/docs/latest/api/app)
- **PATH on a Start-menu launch.** Official text: "a child process inherits the environment variables of its parent process". User vars are per user, system vars for everyone. Registry changes for system vars (`HKLM\...\Session Manager\Environment`) need a `WM_SETTINGCHANGE` broadcast with `lParam` "Environment" so "applications, such as the shell" pick them up. — [Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables), [WM_SETTINGCHANGE](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange). My inference (not stated on the pages): a Start-menu app gets Explorer's block, which can be stale after a PATH edit until Explorer receives the broadcast or restarts. The user-level registry key (`HKCU\Environment`) is not named on the fetched pages: no evidence found.
- **How other tools find git.** VS Code, when launched from the UI, "you normally are not running in the context of a shell", so it starts a process to resolve the shell environment with a 10 s default timeout (`application.shellEnvironmentResolutionTimeout`) — [VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq) (page does not say this is Windows-specific). VS Code's installer adds itself to `%PATH%`; user setup installs to `%LOCALAPPDATA%\Programs\Microsoft VS Code` — [VS Code Windows setup](https://code.visualstudio.com/docs/setup/windows). GitHub Desktop finds **Git Bash** via a registry lookup for the Git for Windows path, then checks `git-bash.exe` exists — [shell-integration](https://github.com/desktop/desktop/blob/development/docs/technical/shell-integration.md). GitHub Desktop's own embedded git: no evidence found.
- **Tool folders (fetched statements only).** Scoop: `C:\Users\<YOUR USERNAME>\scoop`, non-admin install; npm global on Windows: `%AppData%\npm`, executables directly in that folder. winget: has `--scope user/machine` and users report "issues with the client not being on their PATH"; winget portable folder and nvm-windows paths: no evidence found. nvm-windows page says Community Edition has "No mandatory administrator privileges" and lists "Shim mode" and "Link mode". — [Scoop](https://github.com/ScoopInstaller/Scoop), [npm folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders), [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/), [winget install](https://learn.microsoft.com/en-us/windows/package-manager/winget/install), [nvm-windows](https://github.com/coreybutler/nvm-windows)

## Best practices

- **Kill the whole tree on quit.** `taskkill /pid <pid> /t` "Ends the specified process and any child processes started by it"; `/f` forces. — [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill). Node's `kill()` on Windows terminates "forcefully and abruptly"; the fetched part does not say it reaches descendants — [Node child_process](https://nodejs.org/api/child_process.html).
- **Job objects are the crash-proof option.** Children created with `CreateProcess` by a process in a job join that job by default. A job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills every member when the last handle closes. Association "cannot be broken". Breakaway flags can escape it. — [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). A Node-level API for this: no evidence found.
- **In Tauri, register an exit-path tree kill too.** Plugin kill-on-exit stops the tracked PID only; do not bypass `RunEvent::Exit` with `std::process::exit`. — sources above.
- **Keep Electron alive on close only on purpose.** Add `window-all-closed`; give the tray menu a real Quit that calls `app.quit()` (then `will-quit` fires). — [Electron app API](https://www.electronjs.org/docs/latest/api/app)
- **esbuild for a Node ESM server.** `--platform=node` marks Node built-ins external; default output format is cjs; `esm` in Node needs `.mjs` or `"type":"module"`. — [esbuild API](https://esbuild.github.io/api/), [getting started](https://esbuild.github.io/getting-started/). Bundled CommonJS deps that call `require("net")` get a `__require` shim that throws "Dynamic require of ... is not supported" in ESM. Upstream PR #2067 (rewrite built-in requires to imports) was **closed unmerged** (2023). The working fix is a banner: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`. Nested single quotes in the banner string broke one user's build. — [esbuild#2067](https://github.com/evanw/esbuild/pull/2067). Whether esbuild fixed this since 2023: no evidence found. Native `.node` addons cannot be bundled; use external plus ship `node_modules` (esbuild docs: set `packages` to external; non-analyzable `require` stays verbatim).
- **Name the app ID once.** Squirrel sets `com.squirrel.PACKAGE_ID.EXE`; the app must call `app.setAppUserModelId` with the same value or taskbar pinning breaks. — [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)

## Ideas to consider

1. **Minimal: no installer.** Ship a zip, run from any folder; no auto-update; skip signing. Grows from: unsigned runs with only a SmartScreen warning. Notifications and tray GUID need an installed app, so test those first.
2. **Per-user NSIS, update by hand.** Tauri NSIS `currentUser` or electron-builder NSIS (`perMachine:false`); download new setup from GitHub Releases. — grows from the installer table.
3. **Tree-kill helper shared by any wrapper.** One small module: `taskkill /pid N /t /f` on quit, run in both the exit hook and at next start (orphan sweep by saved PID file). — grows from the launcher write-up and the `will-quit` gap.
4. **Job-object parent on Windows.** A tiny launcher that puts the Node server in a KILL_ON_JOB_CLOSE job, so even a crash of the wrapper kills git/gh/claude. — grows from Job Objects page. (own idea for the launcher design)
5. **PATH repair at start.** Read the user and machine Path from the registry (via `reg query`), merge into the server's `PATH`, and look for git in known places (Git for Windows registry path, scoop shims, `%AppData%\npm`) before reporting "git not found". — grows from the PATH gaps and GitHub Desktop's registry lookup.
6. **Self-update via the GitHub API, no updater lib.** Server checks the latest release, downloads the NSIS setup, runs it, quits. Avoids both the electron-updater signature rule and Tauri's key. (own idea)
7. **Tray-first mode.** Tray icon with Open and Quit; close hides the window; server keeps running, so runs continue. — grows from the Tauri/Electron close-to-tray notes.
8. **Bold: signed, auto-updating installer for outside users** (Azure Artifact Signing ~$10/month, US/Canada individuals or orgs with 3+ years tax history; reputation still takes "several weeks") — [MS signing page](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview). Only if the audience grows.

## Questions for the plan

- **Who installs it besides you, and when?** Why: unsigned is acceptable for you; others hit SmartScreen, and Win11 Smart App Control blocks unknown unsigned apps outright. Options: me only (skip signing) / a few friends (tell them to bypass) / public (budget for signing).
- **Is auto-update needed at all?** Why: electron-updater needs `verifyUpdateCodeSignature:false` when unsigned; Tauri needs a private key you must never lose. Options: manual download / self-update script / electron-updater (opt-out) / Tauri updater.
- **Close button: quit or hide to tray?** Why: Pod Board runs agents; hiding keeps runs alive, quitting kills them, and `will-quit` does not fire on shutdown. Options: always quit / hide to tray with explicit Quit / ask once.
- **How must child processes die on quit and on crash?** Why: plugin kill hits one PID; a crash skips every hook. Options: hook-only tree kill / job object launcher / PID-file sweep at start.
- **Where do git, gh, and claude come from?** Why: a Start-menu launch inherits the parent's environment, which may be stale. Options: trust inherited PATH / merge registry Path / user-set paths in settings / probe known folders.
- **Are Windows notifications required in v1?** Why: Tauri's plugin works only for installed apps and shows PowerShell's identity in dev; Electron needs a Start Menu shortcut with an AUMID. Options: skip / in-app only / OS toasts from installed build.
- **How will the server be bundled: one esbuild file or ship `node_modules`?** Why: bundled CJS deps need the `createRequire` banner; native addons cannot be bundled. Options: esbuild ESM + banner / esbuild CJS / plain `node_modules` copy.
- **Does Linux tray matter?** Why: Tauri emits no tray events on Linux and Electron's click semantics differ. Options: tray as menu-only / window-only on Linux.

## Suspect pages
- none

## Sources
- Tauri: Windows Installer — https://v2.tauri.app/distribute/windows-installer/ — undated
- Tauri: Updater plugin — https://v2.tauri.app/plugin/updater/ — undated
- Tauri: System tray — https://v2.tauri.app/learn/system-tray/ — undated
- Tauri: Notification plugin — https://v2.tauri.app/plugin/notification/ — undated
- Tauri: Window JS API — https://v2.tauri.app/reference/javascript/api/namespacewindow/ — undated
- Tauri: Windows signing — https://v2.tauri.app/distribute/sign/windows/ — undated
- Tauri shell plugin lib.rs — https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/lib.rs — v2 branch, fetched 2026-11-02
- Tauri shell plugin commands.rs — https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/shell/src/commands.rs — v2 branch, fetched 2026-11-02
- tauri#1896 (sidecar survives exit) — https://github.com/tauri-apps/tauri/issues/1896 — 2021-05 to 2022-11
- The launcher is not the process — http://timetobuildbob.com/blog/the-launcher-is-not-the-process/ — 2026-04-27
- electron-builder NsisOptions — https://www.electron.build/docs/api/app-builder-lib.Interface.NsisOptions — undated
- electron-builder NSIS — https://www.electron.build/docs/nsis — undated
- electron-builder MSI — https://www.electron.build/docs/msi — undated
- electron-builder SquirrelWindowsOptions.ts — https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/options/SquirrelWindowsOptions.ts — master, fetched 2026-11-02
- electron-updater NsisUpdater.ts — https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/NsisUpdater.ts — master
- electron-updater windowsExecutableCodeSignatureVerifier.ts — https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts — master
- electron-builder#1773 (publisherName) — https://github.com/electron-userland/electron-builder/issues/1773 — 2017 (stale; not relied on for unsigned)
- Electron Forge Squirrel maker — https://www.electronforge.io/config/makers/squirrel.windows.md — undated
- Electron Forge WiX MSI maker — https://www.electronforge.io/config/makers/wix-msi.md — undated
- Electron Forge MSIX maker — https://www.electronforge.io/config/makers/msix.md — undated
- Electron Tray API — https://www.electronjs.org/docs/latest/api/tray — undated
- Electron tray tutorial — https://www.electronjs.org/docs/latest/tutorial/tray — undated
- Electron app API — https://www.electronjs.org/docs/latest/api/app — undated
- Electron autoUpdater — https://www.electronjs.org/docs/latest/api/auto-updater — undated
- Electron utilityProcess — https://www.electronjs.org/docs/latest/api/utility-process — undated
- Electron notifications — https://www.electronjs.org/docs/latest/tutorial/notifications — undated
- Electron updates tutorial — https://www.electronjs.org/docs/latest/tutorial/updates — undated
- electron#11331 — https://github.com/electron/electron/issues/11331 — 2017-12 (stale)
- Microsoft: Sign an MSIX — https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview — 2026-04-14
- Microsoft: Environment Variables — https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables — 2025-07-14
- Microsoft: WM_SETTINGCHANGE — https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange — 2025-07-14
- Microsoft: Job Objects — https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects — 2025-07-14
- Microsoft: taskkill — https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill — updated 2026-02-16
- Microsoft: winget — https://learn.microsoft.com/en-us/windows/package-manager/winget/ — 2026-07-19
- Microsoft: winget install — https://learn.microsoft.com/en-us/windows/package-manager/winget/install — 2026-07-19
- Node.js child_process — https://nodejs.org/api/child_process.html — undated
- esbuild API — https://esbuild.github.io/api/ — undated
- esbuild getting started — https://esbuild.github.io/getting-started/ — undated
- esbuild PR #2067 — https://github.com/evanw/esbuild/pull/2067 — closed 2023
- VS Code FAQ — https://code.visualstudio.com/docs/supporting/faq — undated
- VS Code on Windows — https://code.visualstudio.com/docs/setup/windows — undated
- GitHub Desktop shell integration — https://github.com/desktop/desktop/blob/development/docs/technical/shell-integration.md — undated
- Scoop — https://github.com/ScoopInstaller/Scoop — undated
- nvm-windows — https://github.com/coreybutler/nvm-windows — undated
- npm folders — https://docs.npmjs.com/cli/v10/configuring-npm/folders — undated

## Not found
- electron-builder auto-update page (GitHub provider, NSIS-only rule): 404 on every URL tried.
- Electron `utilityProcess` behavior at Windows parent exit; Electron Tray garbage-collection note; Tauri-specific AUMID source.
- GitHub Desktop embedded git location; winget portable folder; nvm-windows install paths; `HKCU\Environment` as a named source.
- Whether esbuild changed built-in `require` handling for ESM after 2023.
