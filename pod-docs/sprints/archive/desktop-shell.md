# Sprint: desktop-shell

_From plan: pod-docs/plans/windows-app.md · Slug: desktop-shell · Status: done · Generated: 2026-11-03_
<!-- autopilot-run: started=2026-11-03T05:06:41Z sprints=2 waves=6 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | D1 | Desktop package, server host, and the real exit proof | desktop-shell-D1 | [#77](https://github.com/iamphduc/pod-board/pull/77) merged | done | medium | — |
| 1 | R1 | A resumed run never starts Electron by mistake | desktop-shell-R1 | [#77](https://github.com/iamphduc/pod-board/pull/77) merged | done | medium | — |
| 2 | T1 | Window, tray, close to tray, and start at login | desktop-shell-T1 | [#78](https://github.com/iamphduc/pod-board/pull/78) merged | done | medium | D1 |
| 2 | N1 | Notifier: toasts and the tray dot's source | desktop-shell-N1 | [#78](https://github.com/iamphduc/pod-board/pull/78) merged | done | medium | D1 |

## Shared contract

**Scope.** `pnpm dev`, `pnpm start`, and `pnpm verify` keep their behavior. No installer, auto-update, or release workflow. No new web screen, color token, or font, so this sprint has no `L1`. Desktop width only: no mobile or accessibility criteria, and existing code for them stays as it is.

**Checks.** Slice ports: D1 3100/3101, R1 3110/3111, T1 3120/3121, N1 3130/3131. Use temp config, ports, claude, and shell data folders, with `E:\Projects\pod-trial-mock` or a temp copy registered through `POST /api/repos`. Never use a real repo, the real config, or the mock's own `.board` config. Never start a real resumed `claude`: use `packages/server/test/fake-claude.mjs`, and kill each fake in teardown by its recorded process ID. To run the shell: the smoke recipe's production env, plus `POD_BOARD_DESKTOP_DATA_DIR=<tmp>\shell`, then `pnpm build` and `pnpm desktop`.

**Tests and Electron.** CI has no display and no Electron binary.
- Only `main.ts` and files named `*-main.ts` import `electron`. All logic sits in plain modules with fakes.
- A real Electron test lives in a `real-*.test.ts` file under `describe.runIf(process.env.POD_BOARD_REAL_ELECTRON === '1' && process.platform === 'win32')`. `pnpm verify` skips it. `pnpm test:electron` runs it after `pnpm build`, and fails with a message naming `pnpm build` when the bundle is missing. **The engineer and the wave check run `pnpm test:electron` on this machine.** A `[test]` marked *guarded* below is one of these.
- A native check no agent can drive (the tray menu, how a toast looks) is reported in the wave PR for the human. It doesn't count as a failure.

**Install.** The repo pins pnpm 11 and allows build scripts through `allowBuilds` in `pnpm-workspace.yaml`, today only `esbuild`. Pin `electron` to one exact version with Node 22 or later. Add it to `allowBuilds` as `true` when that version has an install script. CI's `pnpm install --frozen-lockfile` sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: `electron`'s types come from the npm package, and no CI test starts the binary. `@pod-board/desktop` isn't in `pnpm dev`'s filter.

**Identity and paths.**

```ts
// packages/desktop/src/shell-config.ts (D1)
export const APP_NAME = 'Pod Board'
export const APP_ID = 'com.iamphduc.podboard' // agent default; installer-and-updates uses this exact value
export function dataDirOverride(env: Env): string | undefined // POD_BOARD_DESKTOP_DATA_DIR; unset or empty: Electron's own folder

// packages/desktop/src/server-launch.ts (D1)
/** Unpackaged: <appPath>/../server/dist/app/server.mjs. Packaged: <resourcesPath>/server/server.mjs. Never resources/app, which Electron loads as an app. */
export function serverEntry(o: { packaged: boolean; appPath: string; resourcesPath: string }): string
/** A copy of env with POD_BOARD_PARENT_PID = mainPid, an old value replaced, and ELECTRON_RUN_AS_NODE removed in any case. */
export function serverEnv(env: NodeJS.ProcessEnv, mainPid: number): NodeJS.ProcessEnv
```

- The shell data folder holds Chromium's data, the single-instance lock, and `window-state.json`. It is never the server's config folder.
- The server's config folder stays the server's own default, or `POD_BOARD_CONFIG_DIR` when set, so a shell and `pnpm dev` share `config.json` and the owner file.
- The shell doesn't set a port. The server takes `POD_BOARD_API_PORT`, else 47800 with its fallback, and the shell uses the port from the ready message.
- The shell never holds the session token. The window gets it in the page. `/api/events` needs only a loopback `Host`.

**Server host.**

```ts
// packages/desktop/src/server-host.ts (D1). Imports STOP_MESSAGE from @pod-board/server/parent-link.
export const READY_LIMIT_MS = 60_000
export const STOP_KILL_MS = 80_000 // above DRAIN_CAP_MS (70 s)
export const STABLE_MS = 60_000
export type ServerProcess = {
  pid: number | undefined
  postMessage(m: unknown): void
  kill(): boolean // this process only
  onMessage(fn: (m: unknown) => void): void
  onExit(fn: (code: number) => void): void
  onOutput(fn: (text: string) => void): void
}
export type ServerHost = {
  start(): void
  stop(): Promise<'stopped' | 'killed' | 'not running'>
  port(): number | undefined
  onReady(fn: (port: number) => void): () => void // fires at each ready; at once when already ready
  onFailed(fn: (error: string) => void): () => void
}
export function createServerHost(o: { fork(): ServerProcess }): ServerHost
```

- **Ready.** Only `{ type: 'pod-board:ready', port }` with a valid port counts, once per process. Other messages are ignored, with no throw.
- **Failure** means an exit outside a stop, with any exit code, or no ready in `READY_LIMIT_MS`, in which case the host kills that process.
- **Restart once.** A first failure starts a new process. A failure with no restart left ends in `failed`, with the last 2000 characters of server output. A server that stayed ready for `STABLE_MS` earns the restart back. The new port can differ, so `onReady` fires again, and the window and the notifier both move to it.
- **Failed state.** `shell-main.ts` shows `APP_NAME`, one line, and the output tail in a native error box, then quits. The first window never opens on a failed start.
- **Stop.** The host sends the stop message once, then waits for the exit. After `STOP_KILL_MS` it calls `kill()`. A repeat shares one promise. A stop never restarts anything. With no process, it resolves `not running`. A stop before ready still sends: the server runs it after its start.

**Quit.** `app.quit()` is the one way to quit. The first `before-quit` prevents the quit, hides the window, stops the host, then quits again. A repeat does nothing and never forces a quit. **No tree kill, no `taskkill`, no Job Object**: the only kill is `kill()` on the server's own process, after the timeout. A second launch during a stop exits, and the first keeps stopping. An accepted edge. Windows shutdown skips `before-quit`: `session-end` lets the window close, and the server's parent watch does the rest.

**Stale owner file (accepted).** `utilityProcess` exit behavior on Windows is undocumented. A killed main process can end the server in one of two ways. Either the server's parent watch sees it, runs the normal stop within 15 s, and removes `auto-continue-owner.json`. Or the child dies with the main process before the watch runs, and the owner file stays behind. In that case the next start's stale check takes it over. Both are acceptable, as long as no server is left and the detached run lives. D1 records in `pod-docs/feature-details/desktop.md` which one this machine shows.

**If a fake detached run dies in any exit proof, stop.** File a `BLOCKED` to the human. Don't add a process-level workaround: it breaks the plan's "Quit never kills a resumed run".

**Shell bus.** The slices of wave 2 don't share files. They meet here:

```ts
// packages/desktop/src/shell-bus.ts (D1)
export type ShellBus = {
  showWindow(hash?: string): void // from a toast, the tray, or a second launch
  onShowWindow(fn: (hash: string | undefined) => void): void // a call before the listener attaches is kept, and the last one runs on attach
  setAttention(on: boolean): void // from the notifier
  onAttention(fn: (on: boolean) => void): void // fires at once with the current value; a repeat of one value doesn't fire
}
// packages/desktop/src/shell-main.ts (D1) calls these. D1 ships them as empty stubs; T1 and N1 own them next.
export type ShellContext = { host: ServerHost; bus: ShellBus; env: NodeJS.ProcessEnv }
// window-main.ts: export function startWindow(ctx: ShellContext): void
// notifier-main.ts: export function startNotifier(ctx: ShellContext): void
```

**What needs the human.** The notifier reads one existing rule set and copies nothing. `@pod-board/web` exports `next-step.ts` (`nextSteps`), `selection.ts` (`hashFor`, `LIVE_TICK_MS`), and `plan-view.ts` (`runName`), all pure. These build on the model's `isAnswerable`, `waitingPrs`, and `runReplies`, and carry the run-to-entry join.
- **Items.** For each run of `listRuns(board, now)`, take `card` plus `rest` of `nextSteps`, and keep tiers `blocked`, `merge`, and `reply`. `pending` and `info` never count. An engineer → orchestrator `BLOCKED` is `info`, so it doesn't count.
- **Identity.** `<repoId>\n<key>`. An entry uses `entry:<line>` and a PR uses `pr:<number>`. A reply uses `runReplies(...)[0].key`, the model's key for one stop, because `reply:<run>` would read two stops as one item. An entry shared by two runs is one item, and the first run in list order opens.
- **A reply on a merge.** A reply whose `pr` equals a merge item's number in that run isn't its own item. One merge gives one toast.
- **A toggled run.** A reply row with `send === 'continue'` on a run in `board.autoContinue` isn't an item, because the board sends it itself. (Agent default.)
- **The tray dot** is on while at least one item exists. It keeps its value while the stream is lost. The many open `pending` entries never light it.

**Toast rules.**
- **Baseline.** The first Board of an app run marks its items seen and sends nothing. The dot still shows them.
- **Once.** The seen set lasts the app run and only grows. An item that goes and comes back, a stream reconnect, or a server restart never sends again. It resets only when the app restarts.
- **Time.** Items are worked out on each Board and every `LIVE_TICK_MS`, because replies depend on `now`.
- **Burst.** Up to 3 new items in one pass each get a toast. More than 3 get one toast, `<N> items need you`, which opens the first item by tier, then list order. All are then seen. (Agent default.)
- **Text.** Title `runName(...)`, body `item.title`. The Windows toast names the app.
- **Click** calls `bus.showWindow(hashFor(run))`. A run that has since gone falls back through `resolveSelection`, as any hash does.
- `Notification.isSupported()` false: nothing sends, items are still marked seen, and nothing throws.

**Checks that wait for `installer-and-updates`.** An unpackaged Electron has no Start-menu shortcut with `APP_ID`, so it can't prove these:
- the toast shows at all, with the app's name and icon
- a click on a toast from the notification center opens the run
- a real login launches the installed exe, in the tray
- the taskbar and exe icons

This sprint proves the sends through fakes, plus the real toggle of the login item. The plan's Verification **Toast** row stays open until that sprint.

**Not this sprint.** `electron-builder`, `extraResources` packing, signing, licence notices, and the 2026-11-03 queue entries on `gh` Recheck delay and non-ASCII registry text.

## Per-slice detail

### D1: Desktop package, server host, and the real exit proof
- **Scope:**
  - Create `@pod-board/desktop`: exact-pinned `electron`, workspace deps on `@pod-board/model`, `@pod-board/server`, and `@pod-board/web`, `lib` ES2023 and DOM, `main` = `dist/main.cjs`, `typecheck`, and a `build` script that bundles `src/main.ts` with `electron` external (`bundleDesktop`).
  - Add root scripts `desktop` and `test:electron`. Export `./parent-link` and `./shutdown` from `@pod-board/server`. Set the Install rule in `pnpm-workspace.yaml` and `pod-ci.yml`.
  - Build `shell-config`, `server-launch`, `server-host`, `quit-flow`, and `shell-bus` as plain modules, per the contract. Build the glue: `main.ts`, `shell-main.ts` (name, `APP_ID`, data folder, single-instance lock before any server starts, empty app menu, a listener that keeps the app alive with no window, the failed box), and `host-main.ts` (`utilityProcess.fork` with `stdio: 'pipe'`, the bundle's folder as `cwd`, and `serverEnv`).
  - A second launch exits with no server, after `bus.showWindow()` in the first through `second-instance`.
  - The guarded probe (`test/probe-main.ts`) calls the same `startShell` as `main.ts`, calls `app.quit()` when a test file appears, and writes a status file that `real-exit.test.ts` polls: each server's process ID, the bound port, and `onFailed`. The test records the fake's process ID through `FAKE_CLAUDE_PIDS`. It uses the real bundle, a real resume through the route per the smoke recipe, and `fake-claude.mjs` in `wait:` mode behind a `claude.cmd`.
  - Write `pod-docs/feature-details/desktop.md` and the desktop part and smoke lines in `codebase-structure.md`. No window, tray, or toast code.
- **Files owned:** `packages/desktop/package.json` (new), `packages/desktop/tsconfig.json` (new), `packages/desktop/scripts/bundle.ts` (new), `packages/desktop/scripts/real-tests.mjs` (new), `packages/desktop/src/main.ts` (new), `packages/desktop/src/shell-main.ts` (new), `packages/desktop/src/host-main.ts` (new), `packages/desktop/src/window-main.ts` (new), `packages/desktop/src/notifier-main.ts` (new), `packages/desktop/src/bundle-desktop.ts` (new), `packages/desktop/src/bundle-desktop.test.ts` (new), `packages/desktop/src/shell-config.ts` (new), `packages/desktop/src/shell-config.test.ts` (new), `packages/desktop/src/server-launch.ts` (new), `packages/desktop/src/server-launch.test.ts` (new), `packages/desktop/src/server-host.ts` (new), `packages/desktop/src/server-host.test.ts` (new), `packages/desktop/src/quit-flow.ts` (new), `packages/desktop/src/quit-flow.test.ts` (new), `packages/desktop/src/shell-bus.ts` (new), `packages/desktop/src/shell-bus.test.ts` (new), `packages/desktop/src/no-electron.test.ts` (new), `packages/desktop/src/real-exit.test.ts` (new), `packages/desktop/test/probe-main.ts` (new), `packages/server/package.json`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/pod-ci.yml`, `pod-docs/feature-details/desktop.md` (new), `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] Only main.ts and *-main.ts files import electron — packages/desktop/src/no-electron.test.ts › plain modules stay free of Electron`
  - `[test] The bundle builds with no Electron binary and leaves electron external — packages/desktop/src/bundle-desktop.test.ts › bundles the main process`
  - `[test] Unpackaged and packaged entries follow the contract, and packaged is never under resources/app — packages/desktop/src/server-launch.test.ts › finds the bundle`
  - `[test] serverEnv sets the parent ID, replaces an old value, drops ELECTRON_RUN_AS_NODE in any case, keeps Path and POD_BOARD_*, and leaves its input alone — server-launch.test.ts › builds the server env`
  - `[test] dataDirOverride reads unset and empty as none — packages/desktop/src/shell-config.test.ts › reads the data folder`
  - `[test] A valid ready gives the port; other messages and bad ports are ignored; a second ready doesn't fire again — packages/desktop/src/server-host.test.ts › reads the ready message`
  - `[test] A listener added after ready fires at once — server-host.test.ts › a late listener gets the port`
  - `[test] An exit outside a stop starts one new process; onReady fires with its new port — server-host.test.ts › restarts once`
  - `[test] A second failure within STABLE_MS ends in failed with the output tail, cut to 2000 characters, with no third fork — server-host.test.ts › a second failure reports the error`
  - `[test] After STABLE_MS of ready, a failure restarts again — server-host.test.ts › a stable server earns its restart back`
  - `[test] No ready in READY_LIMIT_MS kills that process and counts as a failure — server-host.test.ts › a silent start fails`
  - `[test] Stop sends STOP_MESSAGE once, and an exit resolves stopped with no restart — server-host.test.ts › stops by message`
  - `[test] No exit in STOP_KILL_MS calls kill once and resolves killed; a repeat stop shares the result — server-host.test.ts › kills only after the timeout`
  - `[test] STOP_KILL_MS is above the server's DRAIN_CAP_MS — server-host.test.ts › the timeout outlasts the drain`
  - `[test] Stop with no process resolves not running, and a stop before ready still sends — server-host.test.ts › stop at the edges`
  - `[test] The first before-quit prevents, hides, stops, then quits; a repeat does nothing; killed also quits — packages/desktop/src/quit-flow.test.ts › quit waits for the server`
  - `[test] A session end never blocks on the server — quit-flow.test.ts › a Windows shutdown doesn't wait`
  - `[test] A show before a listener runs on attach; a repeated attention value doesn't fire — packages/desktop/src/shell-bus.test.ts › slices meet on the bus`
  - `[test] guarded: inside a real utilityProcess, execPath is Electron's exe, process.parentPort exists, and ready carries the bound port — packages/desktop/src/real-exit.test.ts › real parentPort carries ready`
  - `[test] guarded: a normal quit ends the main process and the server within 30 s, removes the owner file, and the fake stays alive — real-exit.test.ts › a normal quit stops the server and leaves the run`
  - `[test] guarded: taskkill /F on the main process only: the server is gone within 15 s, the fake stays alive, and a later bundle start on that folder owns auto-continue with either owner-file outcome — real-exit.test.ts › a killed main process leaves no server and leaves the run`
  - `[test] guarded: taskkill /F on the server: a new one is ready within 30 s and the fake lives; a second kill leaves no server, onFailed fires, no third starts, and the fake stays alive — real-exit.test.ts › a killed server restarts once, then fails, and leaves the run`
  - `[test] guarded: a second launch on one data folder exits within 15 s, and the server count stays one — real-exit.test.ts › a second launch starts no server`
  - `[manual] pnpm dev on 3100/3101 and pnpm start on 3100 with temp folders behave as before: ports, log lines, and the page.`
  - `[manual] The wave PR's verify job passes on windows-latest with no display. In a temp clone, pnpm install --frozen-lockfile exits 0 with no build-script approval error. The PR names the Electron version.`
- **Depends on:** —
- **One-way door:** none. The package is additive and reverts with git. The proof touches only temp folders and processes it started.
- **Model:** opus

### R1: A resumed run never starts Electron by mistake
- **Scope:**
  - Today `shimTarget` falls back to `process.execPath` when a `.cmd` shim names a script and no `node` is found. In a `utilityProcess` that is Electron's exe, so it would open an app.
  - New rule: the fallback applies only under plain Node. `createClaudeRunner` takes an optional `fallbackNode: string | undefined`, defaulting to `process.versions.electron ? undefined : process.execPath`. With none, and no `node.exe` beside the shim or on the merged `Path`, the start answers `failed` with the message `node not found`, and starts no process.
  - A native `claude.exe`, a shim with its own `node.exe`, and a shim with `node` on `Path` act as today. An unknown shim keeps its cmd.exe path. Don't add `ELECTRON_RUN_AS_NODE`: a packaged build may turn that off.
  - Note the rule in `resume.md`.
- **Files owned:** `packages/server/src/claude-runner.ts`, `packages/server/src/claude-runner.test.ts`, `pod-docs/feature-details/resume.md`
- **Success criteria:**
  - `[test] With fallbackNode undefined and no node anywhere, an npm shim fails with node not found, no process starts, and execPath never runs — packages/server/src/claude-runner.test.ts › Electron's exe is never the fallback`
  - `[test] With fallbackNode undefined and a node on the merged Path, that node runs the script — claude-runner.test.ts › a found node still runs the shim under Electron`
  - `[test] A shim's own node.exe wins, with fallbackNode undefined — claude-runner.test.ts › the shim's own node wins under Electron`
  - `[test] A native exe needs no node, with fallbackNode undefined — claude-runner.test.ts › a native claude ignores the fallback`
  - `[test] Under plain Node the default keeps today's execPath fallback — claude-runner.test.ts › plain Node keeps its fallback`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### T1: Window, tray, close to tray, and start at login
- **Scope:**
  - Plain modules:
    - `window-rules` covers window options (1280 × 800 by default, minimum 800 × 600, background `#000000`, the dark `--bg`), the close action, the link rule, and the URL for a ready port plus a hash.
    - `window-state` covers `window-state.json` in the shell data folder.
    - `tray-menu` covers the menu, in the order Open, Start at login (checkbox), Quit.
    - `login-item` covers the options and the `--hidden` read.
  - Glue `window-main.ts`:
    - Tray first; window on ready. A left click on the tray icon is Open. `bus.onAttention` swaps the icon.
    - **Close** hides, unless quitting or in a session end.
    - **Later ready** (a restart): load the new origin, keeping the hash, so the page gets the new token.
    - **`bus.showWindow`:** restore, show, focus, and set the hash. Before the first ready, it runs on ready.
    - **Login start:** `--hidden` starts in the tray with no window. Any other start shows it. (Agent default.)
  - **Link rule:** an off-origin `http` or `https` link opens in the system browser and never in the app. This covers the setup check's install links (`setWindowOpenHandler` and `will-navigate`). A same-origin new window is denied, with nothing opened. Any other scheme or an unreadable URL is denied, with nothing opened. Same-origin navigation is allowed.
  - **Window state:** missing or bad JSON, or bounds on no display, reads as the default. It saves on hide and quit.
  - **Login item:** the app calls `setLoginItemSettings` only on the toggle, so it stays off by default. Unpackaged args are `[appPath, '--hidden']`, packaged `['--hidden']`, and a read uses those same args. The checkbox shows what a read returns after the write.
  - **Tray assets:** `scripts/make-tray-icons.ts`, using `pngjs` as a dev dependency (pure JavaScript, no build script) for both the script and its test, makes `assets/tray.png` (16 px), `tray@2x.png` (32 px), and `tray-dot.png` and `tray-dot@2x.png` from `packages/web/public/icons/icon-512.png`. The dot takes the dark `--needs-you` value from `tokens.css`, with no new token. Commit the output.
  - Update `desktop.md`, `codebase-structure.md`, and `app-shell.md` (Electron replaces "a wrapper can come later").
- **Files owned:** `packages/desktop/src/window-main.ts`, `packages/desktop/src/window-rules.ts` (new), `packages/desktop/src/window-rules.test.ts` (new), `packages/desktop/src/window-state.ts` (new), `packages/desktop/src/window-state.test.ts` (new), `packages/desktop/src/tray-menu.ts` (new), `packages/desktop/src/tray-menu.test.ts` (new), `packages/desktop/src/login-item.ts` (new), `packages/desktop/src/login-item.test.ts` (new), `packages/desktop/src/tray-assets.test.ts` (new), `packages/desktop/scripts/make-tray-icons.ts` (new), `packages/desktop/assets/tray.png` (new), `packages/desktop/assets/tray@2x.png` (new), `packages/desktop/assets/tray-dot.png` (new), `packages/desktop/assets/tray-dot@2x.png` (new), `packages/desktop/package.json`, `pnpm-lock.yaml`, `pod-docs/feature-details/desktop.md`, `pod-docs/feature-details/app-shell.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] Options keep the normal frame, isolate the page, set no preload, and don't show until ready — packages/desktop/src/window-rules.test.ts › the window is plain and isolated`
  - `[test] Close hides by default, and closes while quitting or at a session end — window-rules.test.ts › close hides to the tray`
  - `[test] Off-origin http and https open externally; same-origin new windows are denied; file, javascript, a custom scheme, and an unreadable URL open nothing — window-rules.test.ts › links go to the system browser`
  - `[test] Same-origin navigation is allowed; off-origin is blocked and opened externally; the origin follows the current port — window-rules.test.ts › the window stays on the board`
  - `[test] A ready after a restart gives the new origin with the kept hash — window-rules.test.ts › a restart moves the window to the new port`
  - `[test] A missing file, bad JSON, bad numbers, and off-screen bounds read as the default; a saved state on a display reads back, below-minimum sizes rise to the minimum — packages/desktop/src/window-state.test.ts › reads the window state`
  - `[test] The menu is Open, Start at login, Quit, in that order, with the checkbox following its input; Quit calls quit and Open calls show — packages/desktop/src/tray-menu.test.ts › the tray menu`
  - `[test] Options on and off carry the same args, unpackaged with appPath and packaged without — packages/desktop/src/login-item.test.ts › login item options`
  - `[test] --hidden reads as a tray start, and no flag shows the window — login-item.test.ts › a login start stays in the tray`
  - `[test] With no toggle, no write happens — login-item.test.ts › off by default`
  - `[test] Each icon has its size; running the script again gives the same bytes; dot pixels equal the dark --needs-you; the no-dot icons hold no such dot — packages/desktop/src/tray-assets.test.ts › tray icons come from the app icon`
  - `[manual] Shell on 3120 with the mock registered: at desktop width the normal Windows title bar shows, no splash, no tour, no app menu bar, and the board shows the mock's runs. Copy and paste work in the Add repo path box.`
  - `[manual] Close: the window hides, the tray stays, and the port still answers /api/health. Open and a tray click bring it back. Move and resize, Quit, start again: it keeps its place.`
  - `[manual] A second pnpm desktop with the same data folder focuses the first window, also when hidden, and starts no second server.`
  - `[manual] With a tool hidden per the smoke recipe, the setup check's install link opens the system browser, and the app stays on the setup check.`
  - `[manual] Start at login: on, then reopen the menu, shows it checked, and reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run lists the entry. Off removes it. It must end off. A real login start waits for the installer.`
  - `[manual] The tray icon reads at 100 % and 200 % scale, with and without the dot, on a dark taskbar.`
- **Depends on:** D1
- **One-way door:** none. The login item is one reversible user-level entry, off by default. It is the app's own, and this slice's check removes it.
- **Model:** opus

### N1: Notifier: toasts and the tray dot's source
- **Scope:**
  - Add the three `exports` to `packages/web/package.json`, per the contract, with no change to those modules.
  - Plain modules:
    - `attention` turns a Board into items, per **What needs the human**.
    - `board-stream` is a `fetch` stream of `GET http://127.0.0.1:<port>/api/events` with an SSE parser. It handles `event: board`, chunks split anywhere (a multi-byte character included), and comment lines.
    - `notifier` holds the seen set, baseline, burst, and tick, per **Toast rules**.
  - **Stream edges:** bad JSON is skipped, and the stream goes on. A failed or closed stream retries after 5 s and never rejects. 45 s with no bytes (pings come every 15 s) counts as lost. `host.onReady` moves it to the new port. The app's exit ends it.
  - Glue `notifier-main.ts`: `Notification` with click wired to the bus, a reference kept until close so a click isn't lost, and one log line per send with no entry text, `pod-board desktop: toast sent`. The tray reads only `bus.onAttention`.
  - Write `pod-docs/feature-details/toasts.md`, listing the checks that wait for the installer.
- **Files owned:** `packages/web/package.json`, `packages/desktop/src/notifier-main.ts`, `packages/desktop/src/attention.ts` (new), `packages/desktop/src/attention.test.ts` (new), `packages/desktop/src/board-stream.ts` (new), `packages/desktop/src/board-stream.test.ts` (new), `packages/desktop/src/notifier.ts` (new), `packages/desktop/src/notifier.test.ts` (new), `pod-docs/feature-details/toasts.md` (new)
- **Success criteria:**
  - `[test] A BLOCKED → human entry, a waiting PR, and a sendable reply are items; a PENDING entry and an engineer → orchestrator BLOCKED aren't — packages/desktop/src/attention.test.ts › only three tiers count`
  - `[test] A run whose card is blocked and whose rest holds a waiting PR gives two items — attention.test.ts › items come from the card and the rest`
  - `[test] An autopilot run's waiting wave PR that autopilot merges is no item — attention.test.ts › autopilot's own merges don't count`
  - `[test] A wave-waiting reply and its merge give one item — attention.test.ts › one merge is one item`
  - `[test] Two stops of a run give two identities; the same stop on a later Board gives one — attention.test.ts › a reply is keyed by its stop`
  - `[test] The same plan slug in two repos gives two items; an unjoined entry listed for two runs gives one, opening the first — attention.test.ts › identity spans repos`
  - `[test] A toggled run's sendable continue is no item; off, or a go reply, it is — attention.test.ts › auto-continue needs no human`
  - `[test] The item's click hash equals hashFor(run), for a plan run with characters to encode, a fix run, and a plan-less repo row — attention.test.ts › a click names the run`
  - `[test] A repo in error or unsupported gives no items and no throw — attention.test.ts › a bad repo is quiet`
  - `[test] Whole events parse across any chunk split, including inside a multi-byte character; pings and other events are ignored — packages/desktop/src/board-stream.test.ts › parses the stream`
  - `[test] Bad JSON is skipped, and the next Board arrives — board-stream.test.ts › bad data doesn't end the stream`
  - `[test] A rejected fetch and a closed stream retry after 5 s; 45 s of silence reconnects, on fake timers — board-stream.test.ts › a lost stream comes back`
  - `[test] A new port moves the stream, and close ends it with no later retry — board-stream.test.ts › follows the server`
  - `[test] The first Board sends nothing, and its items light the dot — packages/desktop/src/notifier.test.ts › the first Board is the baseline`
  - `[test] A new item sends once, across later Boards, a reconnect, and a server restart — notifier.test.ts › once per item`
  - `[test] An item that goes and comes back doesn't send again, and the dot follows it off and on — notifier.test.ts › a returning item stays quiet`
  - `[test] A reply that appears only as time passes sends at the next tick with no new Board, on fake timers — notifier.test.ts › the clock can raise an item`
  - `[test] 3 new items send 3; 4 send one summary that opens the top item; none send again — notifier.test.ts › a burst is one toast`
  - `[test] Title and body follow the contract, and a click calls showWindow with the hash — notifier.test.ts › what a toast says and opens`
  - `[test] An unsupported system sends nothing, marks seen, and doesn't throw; the dot still works — notifier.test.ts › no toast support`
  - `[test] The desktop bundle built with the notifier holds no React — notifier.test.ts › the main bundle holds no React`
  - `[manual] Shell on 3130 with a temp copy of the mock: add a BLOCKED → human line to its queue. The shell's log shows one send and the tray dot lights; answer it on the page and the dot goes off. If the unpackaged toast shows, a click on it brings the hidden window to that run. If not, record that here for installer-and-updates.`
- **Depends on:** D1
- **One-way door:** none
- **Model:** opus

## Sprint summary

- **Synced with merge-target:** up to date
- **Slices shipped:** D1, R1, T1, N1
- **Queue entries:** resolved 0, deferred 2 — the toast after an answer, and late `gh` items (both decisions)
- **Slice log:**
  - D1: opus · medium · test-first yes, with exceptions named in its report · runtime real Electron exits, `pnpm desktop`, `pnpm dev`, `pnpm start` · 11 NOTEs · time lost a 5-minute mutation run
  - R1: opus · medium · test-first partly — four guard tests proved by mutation · runtime real bundle with `fake-claude.mjs`, Electron simulated · 9 NOTEs · time lost none
  - T1: opus · medium · test-first yes · runtime real window, tray objects, login item toggled and turned off · 9 NOTEs · time lost none
  - N1: opus · medium · test-first yes · runtime real shell, notifier, page answers, server kill · 5 NOTEs, 3 PENDINGs (1 re-judged as a NOTE) · time lost none
  - Wave fixes: none. Stalls: none.
- **Agent context at hand-back:** 1,058,530 tokens (planner, D1, R1, T1, N1) — *each agent's final context size, not tokens billed*

**For `installer-and-updates`:**
- Open plan checks: the toast with the app's name and icon, a click from the notification center, a real login launch, and the taskbar and exe icons.
- `APP_ID` is `com.iamphduc.podboard`, and it must match the installer's.
- Third-party licence notices must ship (queued).
- A bad `POD_BOARD_CLAUDE_BIN` gives a setup row with no install link.
- Removing `SystemRoot` from the server's env makes `listen` fail in a `utilityProcess`.
- Electron is pinned at 45.2.1.
