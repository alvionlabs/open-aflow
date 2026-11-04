# Desktop shell

## What it is

`packages/desktop` (`@pod-board/desktop`) is the Electron main process. It runs the production server bundle in a `utilityProcess`, reads the port from the server's ready message, and owns the quit. Start it with `pnpm build`, then `pnpm desktop`. This file covers the shell's start, the server host, the quit, the window, and the tray. Slice N1 (toasts) builds on it.

## How it works

- **Layout.** Only `main.ts` and files named `*-main.ts` import `electron` or `electron-updater`. All logic sits in plain modules: `shell-config`, `server-launch`, `server-host`, `quit-flow`, `shell-bus`, `window-rules`, `window-state`, `tray-menu`, `login-item`, `update-flow`, `update-feed`. `no-electron.test.ts` enforces this. `pnpm build` bundles `src/main.ts` into `dist/main.cjs`, with `electron` external.
- **Start order** (`startShell` in `shell-main.ts`): name, `APP_ID`, data folder, then the single-instance lock. A second launch exits here with no server, and the first gets `bus.showWindow()` through `second-instance`. Then the empty app menu, the keep-alive listener, the quit wiring, and on `ready` the window, the notifier, and the server.
- **Folders.** The shell data folder (`POD_BOARD_DESKTOP_DATA_DIR`, else Electron's own) holds Chromium's data, the lock, and `window-state.json`. The server's config folder stays the server's own default, or `POD_BOARD_CONFIG_DIR`, so a shell and `pnpm dev` share `config.json` and the owner file.
- **Port and token.** The shell sets no port. The server takes `POD_BOARD_API_PORT`, else 47800 with its fallback. The shell never holds the session token.
- **Entry and env.** Unpackaged: `<appPath>/../server/dist/app/server.mjs`. Packaged: `<resourcesPath>/server/server.mjs`, never `resources/app`, which Electron loads as an app. The server gets `POD_BOARD_PARENT_PID` set to the main process, and no `ELECTRON_RUN_AS_NODE`. Its lines also go to the shell's own log.
- **Server host** (`server-host.ts`).
  - Only `{ type: 'pod-board:ready', port }` with a valid port counts, once per process. Events from a process the host has left behind count for nothing.
  - A failure is an exit outside a stop, with any exit code, a `fork` that throws, or no ready in 60 s. In the last case the host kills that process.
  - The first failure starts a new process. A failure with no restart left ends in `failed`, with the last 2000 characters of output, across both processes. 60 s of ready earns the restart back. The new port can differ, so `onReady` fires again. `onFailed` also fires at once for a late listener.
  - A failed state shows `APP_NAME`, one line, and the output tail in a native error box, then quits.
  - Stop sends the stop message once, then waits for the exit. After 80 s, which is above the server's 70 s drain cap, it calls `kill()` once. A repeat shares one promise. A stop never restarts anything, and `start()` after a stop does nothing. With no process, it resolves `not running`. A stop before ready still sends, and that process's ready opens nothing.
- **Quit** (`quit-flow.ts`). `app.quit()` is the one way. The first `before-quit` prevents the quit, hides the windows, stops the host, then quits again. A repeat does nothing and never forces a quit. A second launch during a stop exits, and the first keeps stopping.
- **Session end.** A Windows shutdown skips `before-quit`'s wait. `session-end` is a window's event, not `app`'s, so the shell attaches it to each created window. After it, the quit goes through, and the server's parent watch does the rest. With no window there's nothing to attach to, so a session end then relies on the parent watch alone.
- **Shell bus** (`shell-bus.ts`). The slices of wave 2 meet here. A `showWindow` before any listener is kept, and the last one runs on the first attach. `setAttention` fires only on a change, and `onAttention` fires at once with the current value.
- **Window** (`window-rules.ts`, glue in `window-main.ts`).
  - The normal Windows frame, with no app menu, no preload, and the page isolated and sandboxed. 1280 × 800 by default, minimum 800 × 600, background `#000000`. It shows once it has painted.
  - The first ready opens it. A failed start never opens it.
  - **Close** hides it and the server keeps running. It closes only while quitting or after a session end.
  - **A later ready** (a restart) loads the page again, so the page gets the new token, and keeps the hash. A new port is a `loadURL`. The same port is a `reload`, because a `loadURL` that only repeats a URL with a hash can stay in the same document.
  - **`bus.showWindow`** restores, shows, and focuses it, and sets the hash in the page, which keeps the page's state. Before the first ready, it waits for the ready. Once a quit has begun, it does nothing, so a second launch during a stop brings nothing up.
  - **A login start** (`--hidden`) opens no window: only the tray. The first show opens it.
- **Links.** An off-origin `http` or `https` link opens in the system browser (`setWindowOpenHandler` and `will-navigate`). A same-origin new window, any other scheme, and an unreadable URL open nothing. Same-origin navigation stays. The origin follows the current port.
- **Window state** (`window-state.ts`). `window-state.json` in the shell data folder holds the normal bounds and `maximized`. It saves on hide and at a close. Missing, bad JSON, bad numbers, or a window with less than 100 × 50 px on any display reads as the default. A size below the minimum rises to it. A failed save never throws.
- **Tray.** It comes first, before the window. A left click is Open. The menu is Open, Start at login, Quit. `bus.onAttention` swaps the icon. The icons are in `packages/desktop/assets`, and `scripts/make-tray-icons.ts` makes them from the app icon and the dark `--needs-you`. `nativeImage` finds the `@2x` file beside each one.
- **Start at login** (`login-item.ts`). The app writes only on the toggle, so it stays off by default. Unpackaged args are `[appPath, '--hidden']`, packaged `['--hidden']`, and a read uses the same args, because on Windows a read compares them. The checkbox shows what a read returns after the write.

## The installer

- **Build.** `pnpm package [--version=<x.y.z>] [--output=<dir>]` runs `pnpm build`, writes the licence notices, and calls electron-builder with `publish: never`, for a per-user one-click NSIS installer. It signs nothing. `build-config.ts` holds the config. The default output is `packages/desktop/release`, which git ignores. `--version` changes only the packaged `package.json`.
- **Layout.** `resources/app.asar` holds `dist/main.cjs`, `assets/`, and `package.json`, and no `node_modules`. `resources/server` comes from `extraResources`. The desktop package has no production dependencies, so the packager has nothing to collect.
- **Names.** The packaged `name` is `pod-board-desktop`. So the default install folder is `%LOCALAPPDATA%\Programs\pod-board-desktop`, and the updater's cache is `%LOCALAPPDATA%\pod-board-desktop-updater`. The exe is `Pod Board.exe`, and the Start-menu entry is `Pod Board`. NSIS's `--delete-app-data` removes `%APPDATA%\<name>`, so the name must never be `pod-board`, the server's config folder.
- **Icon.** `scripts/make-app-icon.ts` makes `assets/icon.ico` from the app icon: BMP entries at 16, 32, and 48 px, and a stored PNG at 256 px. `app-icon.test.ts` compares the bytes.
- **Notices.** `resources/THIRD-PARTY-NOTICES.txt` comes from `pnpm package`, not `pnpm build`. Each bundle's packages come from its esbuild metafile (`packages/server/dist/app.meta.json`, `dist/main.cjs.meta.json`), and the web build's from the web package's production closure. A package with no licence file and no entry in `LICENCE_OVERRIDES` in `scripts/package.ts` fails the step and names the package.
- **How NSIS ends a running app.** In electron-builder 26.18.1, `allowOnlyOneInstallerInstance.nsh` finds each process whose exe path starts with the install folder, and runs `Stop-Process -Id` on each. When PowerShell is blocked, it runs `taskkill /IM` with the image name. Neither takes a tree, so a detached `claude` lives. `build-config.test.ts` fails if an update adds `taskkill /T`.
- **Uninstall** keeps the config folder and Electron's data folder. `build/installer.nsh` removes the Run value `com.iamphduc.podboard`, unless `--updated` is on the command line: an update or an install over an install keeps it.
- **The proof.** `pnpm test:install` runs `src/proof-*.test.ts` on this machine, through `install-check.ts`. It holds a machine-wide lock file in the temp folder, and refuses to run when Pod Board is already installed. It ends with an empty `stateDiff`.

## Updates

- **Files.** `update-flow.ts` holds the rules, with fakes. `updater-main.ts` is the glue, and `startShell` calls its `startUpdater`. `update-feed.ts` is what only a test build reads.
- **When it checks.** Only in a packaged app. An unpackaged run neither checks nor logs, and it never creates the updater. The first check runs 30 s after the first server ready, then every 6 h. A later ready adds no timer. A due check does nothing during a check, a download, an open box, a restart, or a quit.
- **Settings.** `autoDownload` on, `allowPrerelease` and `allowDowngrade` off, `autoInstallOnAppQuit` off, so nothing installs without a yes. `disableWebInstaller` is on. The updater's own `logger` is off, because it prints URLs.
- **When it fails.** Each failed check or download logs one line, `pod-board desktop: update check failed: <reason>`. The reason is an error code or a `net::ERR_` name, never the message, because the messages hold URLs. It shows nothing, and it waits for the next check.
- **When it asks.** A finished download opens one native box that names the version, with `Restart now` and `Later`. Escape counts as Later. One version asks once per app run, and a newer one asks again. A version that arrives while a box is open isn't asked until a later download. No box opens once a quit has begun, and an answer that comes after a quit began installs nothing. Later installs nothing, and the next launch asks again from the cache, with no second download.
- **Restart now.** It hides the windows, stops the server through `host.stop()`, then calls `quitAndInstall(true, true)`. `stopped`, `killed`, and `not running` all go on. A `quitAndInstall` that throws or emits `error` logs and quits normally, because the server has gone by then.
- **Build flag.** `pnpm package --test-feed` bundles with `__POD_BOARD_TEST_FEED__` true, then bundles the default again after the package, so `dist/main.cjs` never stays a test build. In every other build, esbuild removes the test feed's code, and `bundle-desktop.test.ts` checks the text.
- **The test feed.** Only in a test build: `POD_BOARD_UPDATE_TEST_FEED` names a generic feed, and only `http://127.0.0.1:<port>/…` counts. Another value is ignored and logged, and the app then has no feed at all. `POD_BOARD_UPDATE_TEST_ANSWER` (`restart` or `later`) answers the box, and `POD_BOARD_UPDATE_TEST_DELAY_MS` replaces the first 30 s.
- **The test env file.** The installer starts the updated app through the Start-menu shortcut (`StdUtils.ExecShellAsUser`), so that app can have none of the proof's env. A packaged test build reads `update-test-env.json` beside its install folder at the very start. With no temp config and data folders after that, it exits with code 1, so a test build never opens the real config folder. This keeps the proof on the real `--force-run` path.
- **The proof.** `proof-update.test.ts` builds two test versions in a temp folder and serves the newer from a local server. Set `POD_BOARD_PROOF_PORT` and `POD_BOARD_PROOF_FEED_PORT` for its ports (default `3110` and `3111`). Set `POD_BOARD_PROOF_BOX_PICTURE` to a file path to save a picture of the real box. To run only this proof: `pnpm test:install packages/desktop/src/proof-update`.

### What electron-updater 6.8.12 does

Read from the installed source (`electron-updater` 6.8.12, `builder-util-runtime` 9.7.1, `app-builder-lib` 26.18.1):

- **`app-update.yml`.** `PublishManager` writes it to `<resources>`, also under `publish: never`. A default build holds `owner: iamphduc`, `repo: pod-board`, `provider: github`, `releaseType: release`, and `updaterCacheDirName: pod-board-desktop-updater`.
- **How the GitHub provider picks a release.** With `allowPrerelease` off, it reads `/iamphduc/pod-board/releases.atom`, which must have an entry, then `/releases/latest` as JSON for `tag_name`, then `/releases/download/<tag>/latest.yml`. GitHub's latest release is never a draft or a pre-release, so the updater doesn't see those. A new version counts only when it is above the current one, and `allowDowngrade` is off.
- **`verifyUpdateCodeSignature`.** Only the packager reads it (`WinPackager.isForceCodeSigningVerification`). When it is false, `publisherName` stays out of `app-update.yml`. At run time, `NsisUpdater.verifySignature` answers "fine" when `publisherName` is absent. The download's `sha512` is still checked against `latest.yml`.
- **The cache folder.** `%LOCALAPPDATA%\pod-board-desktop-updater`, named by `updaterCacheDirName`. A download goes to `pending\`, and the installer keeps its own copy there as `installer.exe`. A `setFeedURL` feed uses the same folder.
- **`quitAndInstall(true, true)`, in order.** `install()` spawns the cached installer, detached, with `--updated /S --force-run`, and with the app's env. Then a `setImmediate` emits `before-quit-for-update` and calls `app.quit()`, which goes through the quit flow. The installer waits 1.3 s, then ends what still runs from the install folder with `Stop-Process`, by process ID, with no tree. It reads the install folder from `HKCU\Software\<guid>` `InstallLocation`, runs the old uninstaller with `--updated`, installs, and starts the app through the shortcut, with `--updated` on its command line.
- **`quitAndInstall` often doesn't throw.** `install()` catches a failure, emits `error`, and returns with no quit. So the flow treats an `error` after the install call as a throw.
- **Each failure comes twice.** `checkForUpdates()` emits `error` and rejects, and so does the download. The flow logs one line per attempt, and it awaits `downloadPromise` so a failed download is never an unhandled rejection.
- **A first differential try.** The updater first asks for the old version's blockmap beside the new file. A 404 falls back to a full download. The local proof serves only the newer build, so it proves the fallback, not a differential download.

## First release: the human's hand-off

No agent publishes. These two tags are the only proof of the GitHub path: the local proof uses a generic feed, and the owner, repo, and signature-off setting reach each friend's app at the first tag.

1. On the merge target, set `version` in `packages/desktop/package.json` to the first version, and merge it.
2. Run `git tag v<version>`.
3. Run `git push origin v<version>`.
4. Watch the `release` workflow in the Actions tab until it passes. The tag must equal `version` in `packages/desktop/package.json`, or the first check step fails before any build. `publish` needs `build`. An existing release for the tag makes `gh release create` fail, so nothing is overwritten. The build's artifact keeps for 1 day.
5. On a machine with no Pod Board, download `pod-board-setup-<version>.exe` from the Releases page, click through SmartScreen (`More info`, then `Run anyway`), and open the app from the Start menu.
6. Set a higher `version`, merge it, and repeat steps 2 to 4.
7. Leave the installed app open. Within 30 s of its next start, or within 6 h while it runs, it finds the new version, downloads it, and opens the box. Choose `Later`, then open the app again: it asks again. Choose `Restart now`: the app closes, installs, and opens on the new version. The log lines start with `pod-board desktop: update`.
8. To uninstall: Settings, Apps, Installed apps, Pod Board, Uninstall. The config folder `%APPDATA%\pod-board` stays.

**To pull a bad release:** delete it on the Releases page, then tag a higher version, since friends who already updated stay on the bad one until then. The updater never moves down, and it reads `/releases/latest`, so a deleted release stops new downloads at once.

## What this machine shows

Measured with `pnpm test:electron` on Windows 11 and Electron 45.2.1:

- **`taskkill /F` on the main process:** the server dies with it before its parent watch runs, and `auto-continue-owner.json` stays behind. The next start's stale check takes the file over. The contract accepts this outcome. No server is left, and the detached run lives.
- **A normal quit:** the main process and the server end, the owner file is removed, and the detached run lives.
- **`taskkill /F` on the server:** a new one is ready on the same port within seconds. A second kill within 60 s ends in `failed`, with no third start. The detached run lives through both.
- **Inside the `utilityProcess`:** `process.execPath` is Electron's exe, `process.parentPort` exists, and `ELECTRON_RUN_AS_NODE` is unset.
- **Electron 45.2.1 has no install script.** It downloads its binary on the first `require('electron')` under Node, or on the first `pnpm desktop`. So `allowBuilds` needs no entry, and `install.js` doesn't read `ELECTRON_SKIP_BINARY_DOWNLOAD`. CI sets that variable as the contract asks, and nothing in `pnpm verify` loads the package.

Measured with `pnpm test:install` on Windows 11 and electron-builder 26.18.1:

- **A silent per-user install** asks for no admin rights and starts no app. It writes one `HKCU` uninstall key and no `HKLM` key.
- **An uninstall with the app running** ends the main process and the server with `Stop-Process`, so the drain doesn't run and `auto-continue-owner.json` stays for the next start's stale check. A detached `fake-claude` run started through the resume route lives.
- **The proof catches a tree kill.** With a temporary `installer.nsh` that ran `taskkill /F /T /PID` on the app's processes, the fake run died, and `uninstall keeps config and runs` failed.
- **A packaged exe writes to a pipe,** so a proof reads the `toast sent` line from stdout, and needs no log file.
- **electron-builder 26.18.1 downloads no winCodeSign archive,** the one whose symbolic links fail to extract without a Windows setting. It downloads Electron, 7-Zip, NSIS, and NSIS's resources once, to its cache, and still sets the exe's icon and name. This machine has Developer Mode on, so that setting's absence isn't proved here.
- **The installer is about 122 MB.** A package run takes about a minute after the first download.

Measured with `pnpm test:install` on Windows 11 and electron-updater 6.8.12:

- **An update from 0.1.0 to 0.1.1** takes about 25 s from the feed's answer to a new app that answers health. It lands in the same temp install folder, because the installer reads `InstallLocation`.
- **The installer starts the new app.** It answers on the proof's port with the temp folders, through the test env file. No old app process stays, and the new one owns `auto-continue-owner.json`.
- **A detached `fake-claude` run started through the resume route lives through the update.** A Start at login value, `config.json`, `tool-paths.json`, and another file in the config folder stay as they were.
- **A feed that answers 500, a bad `latest.yml`, and a cut download** each log one line with no URL, open no box, and leave the app running on its version.
- **The next launch after a Later** asks again with no second request for the installer.
- **`lazy-val` ships no licence file,** so it has an entry in `LICENCE_OVERRIDES`.
- **Windows reports the exe's version in four parts,** such as `0.1.1.0`.

## Why it's this way

- **Quit never kills a resumed run.** A resumed `claude` is detached on purpose. So there is no tree kill, no `taskkill`, and no Job Object. The only kill is `kill()` on the server's own process, after the timeout. See the plan's key decision in [windows-app.md](../plans/windows-app.md).
- **The server runs in a `utilityProcess`,** so a server crash doesn't take the window down.
- **A silent start's replacement starts at once,** without waiting for the killed process's exit. `kill()` ends the process, and a `kill` with no exit event must not hang the app.
- **`killed` resolves right after `kill()`,** for the same reason. The app's goal at that point is to quit.
- **An update stops the server itself first.** The installer's `Stop-Process` would end the server with no drain. After `host.stop()`, it finds only the main process.
- **The box has no parent window,** because a login start or a closed window leaves none to attach to.

## Watch out

- The templates match a process by the prefix of its exe path, with `StartsWith($INSTDIR)`. A process that runs an exe from a folder whose name starts with the install folder's name also ends.
- An uninstall leaves `%LOCALAPPDATA%\pod-board-desktop-updater`, because NSIS copies the installer there. A proof removes it through `finishProof`.
- A proof's `proofPlace` env has `Path` set to System32, and `POD_BOARD_CLAUDE_BIN` set to a path with no file, so it can't start a real `claude`.
- `withInstallLock` holds through a whole proof. Never call it inside itself: a process waits for its own lock until the limit.
- A test build needs temp folders or it exits, so never run one by hand with no env. `pnpm package --test-feed` is for the proof only: never upload its files.
- The relaunched app has no pipe, so a proof after an update reads health and the owner file, not its output.
- `--updated` is on the command line of an app that the installer started. Nothing reads it today.
- The updater writes `.updaterId` to the shell data folder on its first check, and sends it as a staging ID header. It is a random value that names no one.
- Never import `electron` from a plain module, a test, or a build script. Under Node, loading the npm package downloads the binary, and CI has none. The guarded test resolves the path inside its `beforeAll` only.
- A `real-*.test.ts` file sits in `src/`, so `pnpm verify` collects it. Keep its body inside `describe.runIf`.
- `dialog.showErrorBox` blocks until a click. The probe passes `onFailed` in its place.
- `electron <file>` makes the file's folder the app path, so `serverEntry` would miss the bundle. The probe passes `appPath`.
- Inside a `utilityProcess`, `process.execPath` is Electron's exe. A `claude.cmd` that names a script needs a `node.exe` beside it or a `node` on the merged `Path`. The proof puts a `node.exe` beside the shim.
- Spawn Electron's exe directly in a test, not `cli.js`, so the recorded process ID is the main process.
- Temp paths in tests go through `realpathSync.native`: CI's temp paths have 8.3 names.
- A plain module can't `import type` from `electron` either: `no-electron.test.ts` counts that. Each one declares its own shapes.
- The guarded probe runs from a temp folder, so `app.getAppPath()` there has no `assets`. The tray then has an empty icon. It doesn't throw.
- The tray icons are PNGs with stored, uncompressed data, because zlib's output differs between Node versions and `tray-assets.test.ts` compares bytes.
- `win.maximize()` also shows a hidden window, so a maximized state applies at `ready-to-show`.
- `win.restore()` on a maximized window can take it out of maximized, so call it only when the window is minimized.
- A login start with the app already running comes in as a second launch, which shows the window. The login item only runs at login, so the app isn't running then.

## History

- 2026-11-03 · desktop-shell D1: the package, the server host, the quit, and the real exit proof.
- 2026-11-03 · desktop-shell T1: the window, the tray, close to tray, the link rule, the window state, and Start at login.
- 2026-11-03 · installer-and-updates P1: the per-user installer, the app icon, the licence notices, and the install proof.
- 2026-11-03 · installer-and-updates U1: auto-update, the test feed, the local two-version proof, and the first release hand-off.
