# Desktop shell

## What it is

`packages/desktop` (`@pod-board/desktop`) is the Electron main process. It runs the production server bundle in a `utilityProcess`, reads the port from the server's ready message, and owns the quit. Start it with `pnpm build`, then `pnpm desktop`. This file covers the shell's start, the server host, the quit, the window, and the tray. Slice N1 (toasts) builds on it.

## How it works

- **Layout.** Only `main.ts` and files named `*-main.ts` import `electron`. All logic sits in plain modules: `shell-config`, `server-launch`, `server-host`, `quit-flow`, `shell-bus`, `window-rules`, `window-state`, `tray-menu`, `login-item`. `no-electron.test.ts` enforces this. `pnpm build` bundles `src/main.ts` into `dist/main.cjs`, with `electron` external.
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

## What this machine shows

Measured with `pnpm test:electron` on Windows 11 and Electron 45.2.1:

- **`taskkill /F` on the main process:** the server dies with it before its parent watch runs, and `auto-continue-owner.json` stays behind. The next start's stale check takes the file over. The contract accepts this outcome. No server is left, and the detached run lives.
- **A normal quit:** the main process and the server end, the owner file is removed, and the detached run lives.
- **`taskkill /F` on the server:** a new one is ready on the same port within seconds. A second kill within 60 s ends in `failed`, with no third start. The detached run lives through both.
- **Inside the `utilityProcess`:** `process.execPath` is Electron's exe, `process.parentPort` exists, and `ELECTRON_RUN_AS_NODE` is unset.
- **Electron 45.2.1 has no install script.** It downloads its binary on the first `require('electron')` under Node, or on the first `pnpm desktop`. So `allowBuilds` needs no entry, and `install.js` doesn't read `ELECTRON_SKIP_BINARY_DOWNLOAD`. CI sets that variable as the contract asks, and nothing in `pnpm verify` loads the package.

## Why it's this way

- **Quit never kills a resumed run.** A resumed `claude` is detached on purpose. So there is no tree kill, no `taskkill`, and no Job Object. The only kill is `kill()` on the server's own process, after the timeout. See the plan's key decision in [windows-app.md](../plans/windows-app.md).
- **The server runs in a `utilityProcess`,** so a server crash doesn't take the window down.
- **A silent start's replacement starts at once,** without waiting for the killed process's exit. `kill()` ends the process, and a `kill` with no exit event must not hang the app.
- **`killed` resolves right after `kill()`,** for the same reason. The app's goal at that point is to quit.

## Watch out

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
