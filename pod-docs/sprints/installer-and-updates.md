# Sprint: installer-and-updates

_From plan: pod-docs/plans/windows-app.md · Slug: installer-and-updates · Status: active · Generated: 2026-11-03_
<!-- autopilot-run: started=2026-11-03T05:06:41Z sprints=3 waves=7 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | P1 | Per-user installer, icons, licence notices, and the install proof | installer-and-updates-P1 | — | pending | — | — |
| 2 | U1 | Auto-update, with the local two-version proof | installer-and-updates-U1 | — | pending | — | P1 |
| 2 | R1 | Release workflow, its local check, and the install note | installer-and-updates-R1 | — | pending | — | P1 |

## Shared contract

**Nothing is published by an agent.** No slice, wave check, or reviewer creates a tag, a GitHub Release, or a draft release, or runs the release workflow. This replaces the plan's Known risks line about two throwaway versions on a test release. The human starts each release by pushing a version tag. The GitHub provider's real path is proved only by the human's first tags (see U1's hand-off).

**Scope.** `pnpm dev`, `pnpm start`, `pnpm desktop`, and `pnpm test:electron` keep their behavior. `pnpm verify` keeps passing on CI's Windows runner with no Electron binary and no packaging. No web screen, color token, or font changes, so there is no `L1`. No signing. Nothing is built for Linux or Mac, and no rule here assumes Windows outside the Windows-named files. No mobile or accessibility criteria; existing code for them stays as it is.

**Checks.** Slice ports: P1 3100/3101, U1 3110/3111, R1 3120/3121. The second port is for a slice's local static server. Use temp copies of `E:\Projects\pod-trial-mock` with temp config, ports, claude, and shell data folders. Never use a real repo or the real config. Never start a real resumed `claude`: use `packages/server/test/fake-claude.mjs`, and kill each fake by its recorded process ID. Temp paths go through `realpathSync.native`. Keep `SystemRoot` in any stripped env: without it `listen` fails in a `utilityProcess`.

**Tests that install.**
- They live in `packages/desktop/src/proof-*.test.ts`, under `describe.runIf(process.env.POD_BOARD_REAL_INSTALL === '1' && process.platform === 'win32')`. `pnpm verify` and `pnpm test:electron` skip them. `pnpm test:install` (P1) runs them, and it fails with a message naming `pnpm package` when no installer exists. **The engineer and the wave check run it on this machine.** A criterion marked *guarded* is one of these.
- Only `main.ts` and `*-main.ts` import `electron` or `electron-updater`, as today. All logic sits in plain modules with fakes.

**Install proof helper.** `packages/desktop/src/install-check.ts` (P1), with no `electron` import. U1, R1, and the release check all use it.

```ts
export type ProofPlace = { root: string; installDir: string; env: NodeJS.ProcessEnv; port: number }
/** Temp root named pod-board-install-proof-*; install folder, config, shell data, ports, and claude folders inside it. */
export function proofPlace(port: number): ProofPlace
/** One holder per machine. Waits up to 30 min; a holder whose process ID is gone is stale and is taken over. */
export function withInstallLock<T>(fn: () => Promise<T>): Promise<T>
/** realConfig: each file's name and modified time in the real config folder; null when there's no folder. */
export type MachineState = { uninstallKeys: string[]; runValue: string | null; startMenu: string[]; apps: number[]; updaterCache: boolean; realConfig: string[] | null }
export function machineState(): Promise<MachineState>
/** Empty when nothing differs. Each line names one leftover. */
export function stateDiff(before: MachineState, after: MachineState): string[]
/** Throws, naming what it found, when Pod Board is already installed for this user. */
export function refuseRealInstall(state: MachineState): void
export function silentInstall(installer: string, place: ProofPlace): Promise<void> // /S /D=<installDir>
export function launch(place: ProofPlace, args?: string[]): Promise<{ pid: number; output(): string }>
export function waitForHealth(place: ProofPlace, ms?: number): Promise<void> // /api/health answers {"ok":true}; a timeout throws, with the output tail
export function silentUninstall(place: ProofPlace): Promise<void> // waits until the install folder is gone: NSIS re-launches itself
```

Rules for every proof:
- It holds the lock for its whole run, a `pnpm package` included, because one per-user install has one uninstall key and one Start-menu entry, the packager shares one cache, and U1 and R1 run in parallel.
- Before it installs, it records `machineState()` and calls `refuseRealInstall`. A human's real install is never overwritten, and the proof then fails with that message.
- A `finally` uninstalls and removes the temp root and the updater cache, on a pass or a failure.
- **It ends with `stateDiff(before, after)` equal to `[]`.** That is the proof that it left nothing: no uninstall key, no Run value, no Start-menu entry, no app process, no updater cache, and no new or changed file in the real config folder. When another server already holds that folder (an `auto-continue-owner.json` whose process lives, at the first `machineState()`), `realConfig` reads null in both states, and the proof's last line says so. Never stop that server.
- Its final line prints that empty diff, and the engineer pastes it in the report.

**Packaged app.**
- `productName` is `APP_NAME`; `appId` is `APP_ID` (`com.iamphduc.podboard`), both imported from `shell-config.ts`, never copied.
- The server comes in through `extraResources`, at `<resources>/server/server.mjs` with `web/` beside it, the path `serverEntry` already reads. The app's `resources/app.asar` holds `dist/main.cjs`, `assets/`, and `package.json`, and no `node_modules`.
- Per-user one-click NSIS, no admin rights, a Start-menu entry named `Pod Board`, no desktop shortcut. `runAfterFinish` is false, because a run after a silent install would start with no temp env and open the real config folder. A friend opens the app from the Start menu.
- File names have no spaces: `pod-board-setup-<version>.exe`, `.exe.blockmap`, and `latest.yml`. GitHub rewrites spaces in asset names, which would break `latest.yml`.
- Uninstall keeps the config folder and Electron's data folder (`deleteAppDataOnUninstall` stays false). Uninstall removes the Run value `com.iamphduc.podboard`, but an uninstall that is part of an update doesn't.

**Build command.** `pnpm package [--version=<x.y.z>] [--output=<dir>] [--test-feed]` builds first, then packages, with `--publish never` in all cases. `--version` changes only the packaged app's version; it edits no file in the repo. Default output: `packages/desktop/release` (git-ignored). P1 builds it with the first two flags, and U1 adds `--test-feed`. The app's version is `packages/desktop/package.json` `version`, which P1 sets to `0.1.0`.

**Tag rule.** A release tag is exactly `v<major>.<minor>.<patch>`, with digits only and no leading zero. It equals `v` plus the `version` in `packages/desktop/package.json`, or the workflow fails before it builds. Pre-release tags don't start the workflow.

**Update trust.**
- Shipped builds use electron-updater's GitHub provider, owner `iamphduc`, repo `pod-board`, with `verifyUpdateCodeSignature: false`. The GitHub account is the trust boundary.
- A release is a normal published release, never a draft or a pre-release, because the updater doesn't see those.
- The test feed exists only in a `--test-feed` build: a build-time flag removes the code from every other build, so a default `dist/main.cjs` doesn't hold the text `POD_BOARD_UPDATE_TEST`. In a test build, `POD_BOARD_UPDATE_TEST_FEED` names a generic-provider URL. Only `http://127.0.0.1:<port>/…` counts; another value is ignored and logged, and the app then uses no feed at all. `POD_BOARD_UPDATE_TEST_ANSWER` (`restart` or `later`) answers the box, and `POD_BOARD_UPDATE_TEST_DELAY_MS` replaces the first check's 30 s.

**Human list.** What no agent can see goes in a section named `Human list` in the wave PR body, with exact steps. Do it after the sprint's last proof, because a real install makes `refuseRealInstall` stop the proofs. Each item ends with how to uninstall.

## Per-slice detail

### P1: Per-user installer, icons, licence notices, and the install proof
- **Scope:**
  - Add the packaging per **Packaged app** and **Build command**, with the publish settings of **Update trust** in its config, so that `latest.yml` exists for wave 2. Add all this sprint's new dependencies here, each pinned to one exact version, so wave 2 doesn't touch the lockfile: `electron-builder`, `electron-updater`, `@electron/asar`, `yaml`. Pick the newest `electron-builder` that passes the content test below, because the research names silent pnpm faults in some 26.x versions. Nothing the app bundles may stay a production dependency the packager would try to collect. If `electron-builder` needs a Windows setting to extract its signing tools, say so in the smoke recipe.
  - The exe and installer icon: `assets/icon.ico`, made from `packages/web/public/icons/icon-512.png` by a committed script, with bytes that repeat on any Node version: stored (uncompressed) PNG or BMP entries only, as the tray icons do.
  - Licence notices: `THIRD-PARTY-NOTICES.txt` in `<resources>`, generated by `pnpm package`, not by `pnpm build`. It holds each package whose code is in the server bundle, the main bundle, or the web build, with name, version, and licence text, plus the two Geist font licences. For the web build, the web package's production closure is accepted: extra packages are fine, a missed one isn't. A package with no licence file and no entry in the script's short override list fails the package step and names that package. A bundle's package list comes from its esbuild metafile, so a removed dependency leaves the notices.
  - The uninstall rule on the Run value, and `install-check.ts`, `pnpm test:install`, and the proof.
  - **Read first: how the NSIS templates end a running app.** Read the installed `electron-builder` templates before you build. A close by image name is fine. A tree kill (`taskkill /T`) from the exe would reach a detached `claude`, which breaks "Quit never kills a resumed run". A close also only hides this window, so expect the forced path to run. If the templates tree-kill, override that in `installer.nsh`. If no override can avoid it, stop and report.
  - Close `desktop-shell`'s open checks as far as an agent can, and put the rest on the **Human list**: how the toast looks with the app's name and icon, a click on a toast from the notification center, a real login launch in the tray, and the taskbar and exe icons. Add the list to `toasts.md` in place of its waiting section, naming what the proof now covers. A plain `installed build` smoke section goes in the recipe.
  - Not here: the updater, the workflow, or the install note.
- **Files owned:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.gitignore`, `packages/desktop/package.json`, `packages/desktop/scripts/package.ts` (new), `packages/desktop/scripts/make-app-icon.ts` (new), `packages/desktop/scripts/install-tests.mjs` (new), `packages/desktop/assets/icon.ico` (new), `packages/desktop/build/installer.nsh` (new), `packages/desktop/src/build-config.ts` (new), `packages/desktop/src/build-config.test.ts` (new), `packages/desktop/src/app-icon.test.ts` (new), `packages/desktop/src/licence-notices.ts` (new), `packages/desktop/src/licence-notices.test.ts` (new), `packages/desktop/src/install-check.ts` (new), `packages/desktop/src/install-check.test.ts` (new), `packages/desktop/src/proof-install.test.ts` (new), `packages/server/src/bundle-app.ts`, `packages/server/src/bundle-app.test.ts`, `packages/desktop/src/bundle-desktop.ts`, `packages/desktop/src/bundle-desktop.test.ts`, `pod-docs/feature-details/toasts.md`, `pod-docs/feature-details/desktop.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] the config is per-user with no elevation, no desktop shortcut, runAfterFinish false, the shell's APP_ID and name, the exact Electron version, and app data kept on uninstall — build-config.test.ts › per-user NSIS with the shell's identity`
  - `[test] the server comes through extraResources and node_modules is left out of the app — build-config.test.ts › server in extraResources, no node_modules`
  - `[test] artifact names hold no spaces at any version — build-config.test.ts › artifact names have no spaces`
  - `[test] the config has the GitHub provider, owner, repo, a non-draft release type, and the signature check off — build-config.test.ts › publish config`
  - `[test] guarded: pnpm package gives the installer, its blockmap, and a latest.yml, and publishes nothing — proof-install.test.ts › package gives the three files`
  - `[test] --version overrides the packaged version with no change to package.json, and a bad version throws — build-config.test.ts › version override`
  - `[test] the ico holds 16, 32, 48, and 256 px images, and the script gives the committed bytes — app-icon.test.ts › icon sizes and repeatable bytes`
  - `[test] notices hold a planted package's name, version, and licence text once, across two bundles that share it — licence-notices.test.ts › one entry per package`
  - `[test] a package with no licence file and no override fails, naming it — licence-notices.test.ts › missing licence fails by name`
  - `[test] an override supplies text for a package with no file — licence-notices.test.ts › override`
  - `[test] a package only in a metafile's output imports is left out, and one in its inputs is kept — licence-notices.test.ts › reads the metafile inputs`
  - `[test] stateDiff is empty for equal states and names each leftover kind, a new file in the real config folder included — install-check.test.ts › stateDiff names each leftover`
  - `[test] a live owner file leaves the real config folder out, and a stale one doesn't — install-check.test.ts › a live server's folder is left out`
  - `[test] refuseRealInstall throws for an uninstall key or a Start-menu entry, and passes a clean state — install-check.test.ts › refuses a real install`
  - `[test] the lock serves one holder at a time, a stale holder is taken over, and a held lock is freed after a throw — install-check.test.ts › install lock`
  - `[test] guarded: the asar holds main.cjs, assets, and no node_modules; resources hold server.mjs, web/index.html, and notices naming hono, chokidar, react, and Geist — proof-install.test.ts › packaged contents`
  - `[test] guarded: a silent install puts the exe in the temp install folder, adds no HKLM uninstall key, and starts no app process; the Start-menu entry exists, and Get-StartApps gives it the AppID com.iamphduc.podboard — proof-install.test.ts › per-user install with the app's identity`
  - `[test] guarded: the installed exe starts with temp folders, the page and the API answer on one port, and config.json lands in the temp config folder — proof-install.test.ts › installed app runs`
  - `[test] guarded: the exe with --hidden answers health and opens no window — proof-install.test.ts › login start stays in the tray`
  - `[test] guarded: a new BLOCKED line in a temp mock copy logs one "toast sent" from the installed app — proof-install.test.ts › installed app sends a toast`. If a packaged exe gives no stdout through a pipe, add one log file in the shell data folder for this.
  - `[test] guarded: an uninstall with the app running ends every app process, leaves a fake-claude run alive, and keeps the temp config folder — proof-install.test.ts › uninstall keeps config and runs`
  - `[test] guarded: the Run value is gone after an uninstall when Start at login was on — proof-install.test.ts › uninstall removes the login item`
  - `[test] guarded: the state diff is empty after the proof — proof-install.test.ts › leaves nothing behind`
  - `[manual] the exe's icon and name in File Explorer, seen in a screenshot of the install folder, before the uninstall`
- **Depends on:** —
- **One-way door:** none. Each install is per-user, on this machine, and removed by the proof.
- **Model:** opus

### U1: Auto-update, with the local two-version proof
- **Scope:**
  - The updater per **Update trust**. Before coding, read the installed `electron-updater` and `builder-util-runtime` source, and confirm: the shape of `app-update.yml`, how the GitHub provider picks a release, where `verifyUpdateCodeSignature` is read, the updater cache folder's name, and `quitAndInstall`'s order of events. Write the answers in `desktop.md`. A fact that breaks this contract: stop and report.
  - Public interface: `createUpdateFlow(o)` in `update-flow.ts`, with fakes for the updater, the box, the stop, the clock, and the log; `startUpdater(ctx)` in `updater-main.ts`, called from `shell-main.ts`.
  - **When it checks.** Only in a packaged app. An unpackaged run neither checks nor logs. The first check runs 30 s after the first server ready, then every 6 h. A check, or a download in progress, makes a due check do nothing. `autoDownload` is on; `allowPrerelease` and `allowDowngrade` are off; `autoInstallOnAppQuit` is **off**, so nothing installs without a yes.
  - **When it fails.** Offline, a bad `latest.yml`, a failed download, or any updater error logs one line with no URL and no token, shows nothing, never throws, and waits for the next check.
  - **When it asks.** A finished download opens one native box, naming the new version, with `Restart now` and `Later`. It asks once per version per app run. A newer version after a Later asks again, and a box that's open blocks a second. No box opens once a quit has begun. Later installs nothing, and the next launch asks again.
  - **Restart now.** Stop the server first, through `host.stop()`, so the drain finishes before the installer starts, then call `quitAndInstall` silent, with the app run afterward. `stopped`, `killed`, and `not running` all go on. If `quitAndInstall` throws, log it and quit normally, because the server has gone by then. The tray menu doesn't change.
  - `no-electron.test.ts` also counts `electron-updater`.
  - The proof: two `--test-feed` builds at two versions, in a temp folder, the newer served from a small local static server on port 3111.
  - In `desktop.md`, add the section **First release: the human's hand-off**, with exact steps: set `version` in `packages/desktop/package.json` on the merge target and merge it; `git tag v<version>`; `git push origin v<version>`; watch the `release` workflow; install from the Releases page, click through SmartScreen; repeat with a higher version; see the installed app find, download, ask, and install. Say that these two tags are the only proof of the GitHub path, and how to pull a bad release: delete it, then tag a higher version, since friends already updated stay on it until then.
- **Files owned:** `packages/desktop/src/update-flow.ts` (new), `packages/desktop/src/update-flow.test.ts` (new), `packages/desktop/src/updater-main.ts` (new), `packages/desktop/src/update-feed.ts` (new), `packages/desktop/src/update-feed.test.ts` (new), `packages/desktop/src/proof-update.test.ts` (new), `packages/desktop/src/shell-main.ts`, `packages/desktop/src/bundle-desktop.ts`, `packages/desktop/src/bundle-desktop.test.ts`, `packages/desktop/src/no-electron.test.ts`, `packages/desktop/src/build-config.ts`, `packages/desktop/src/build-config.test.ts`, `packages/desktop/scripts/bundle.ts`, `packages/desktop/scripts/package.ts`, `pod-docs/feature-details/desktop.md`
- **Success criteria:**
  - `[test] a default bundle holds no POD_BOARD_UPDATE_TEST text, and still has only electron and builtins as external imports — bundle-desktop.test.ts › a default bundle has no test feed`
  - `[test] a test-feed bundle holds it — bundle-desktop.test.ts › a test bundle has the test feed`
  - `[test] a loopback http URL is the feed; https, another host, a bad URL, and an empty value are not — update-feed.test.ts › only a loopback feed counts`
  - `[test] an unpackaged run never checks — update-flow.test.ts › no check when unpackaged`
  - `[test] the first check waits 30 s after ready, later ones come every 6 h, and a server restart's second ready adds no timer — update-flow.test.ts › check times`
  - `[test] a due check does nothing during a check or a download — update-flow.test.ts › no overlapping checks`
  - `[test] an error logs one line without the URL, shows no box, and the next check runs — update-flow.test.ts › a failure stays quiet and retries`
  - `[test] one version asks once in an app run, a newer one asks again, an open box blocks a second, and no box opens once a quit has begun — update-flow.test.ts › when it asks`
  - `[test] Later doesn't stop the server or install — update-flow.test.ts › later installs nothing`
  - `[test] Restart now stops the server, and only after that installs, for each stop result — update-flow.test.ts › restart stops first`
  - `[test] a quitAndInstall that throws logs and quits — update-flow.test.ts › a failed install quits`
  - `[test] electron-updater in a plain module fails the check — no-electron.test.ts › the check sees every import form`
  - `[test] guarded: an installed older version finds the newer, downloads it, logs the ask, restarts on restart, and the exe's version is the newer one, with health answering — proof-update.test.ts › older finds, asks, installs newer`
  - `[test] guarded: on later, the version stays, and the next launch asks again from its cache — proof-update.test.ts › later keeps the version`
  - `[test] guarded: a detached fake-claude run started through the resume route lives through the update, and no old app process stays — proof-update.test.ts › an update never stops a run`
  - `[test] guarded: temp config files and a Start at login value set before the update are still there after it — proof-update.test.ts › an update keeps config and login`
  - `[test] guarded: a feed that answers 500 or stops mid-download leaves the app running on its version — proof-update.test.ts › a bad feed changes nothing`
  - `[test] guarded: the shipped-config build's app-update.yml names github, iamphduc, pod-board — proof-update.test.ts › shipped update file`
  - `[test] guarded: the state diff is empty after the proof — proof-update.test.ts › leaves nothing behind`
  - `[manual] the box names the version and its two buttons read well — screenshot of a run with no POD_BOARD_UPDATE_TEST_ANSWER, in the wave PR`
- **Depends on:** P1
- **One-way door:** none in this sprint: nothing ships until the human tags. At that tag, the owner, repo, and signature-off setting go into each friend's app, and they change only through a later update. The plan and the settled answers approve this.
- **Model:** opus

### R1: Release workflow, its local check, and the install note
- **Scope:**
  - `.github/workflows/release.yml`, named `release`. Trigger: a push of a tag matching the **Tag rule** only, so no `workflow_dispatch`, no `pull_request`, and no branch. All jobs on `windows-latest`, Node 22, pnpm from `packageManager`, and `pnpm install --frozen-lockfile`.
  - Two jobs. `build` has `permissions: contents: read`: tag check, `pnpm verify`, `pnpm package`, then the release check, then it uploads the three files. `publish` needs `build` and has `permissions: contents: write`, with the token only on its one step: it downloads the files and runs `gh release create <tag>` with them, as a normal release. An existing release for the tag makes that command fail, and nothing is overwritten. No code from the repo runs in `publish`, so it has no checkout. Top-level `permissions: {}`.
  - Each action is pinned to a full commit SHA, with its version in a comment. No dependency cache. `persist-credentials: false` on checkout.
  - `packages/desktop/scripts/release-check.ts`, run as `pnpm release:check <output dir>` in the workflow and on this machine, publishing nothing. It fails with a non-zero exit, naming the step, on: a bad size; a `latest.yml` whose `path` isn't the installer or whose `sha512` doesn't match its bytes; a missing blockmap; `POD_BOARD_UPDATE_TEST` in the asar's `main.cjs`; or a failed install, launch, or health check, with the app's output tail. It installs through `install-check.ts`, so its rules hold, and it uninstalls in every case. It needs no repo, since a runner has no config, and an empty temp config counts as a start.
  - `release-rules.ts` holds the plain rules: `tagVersion(tag, packageVersion)`, `checkSize(bytes)`, `checkUpdateFile(yml, installerBytes, name)`. Size limits: floor and ceiling constants, set to 80% and 130% of the measured installer, and recorded in a comment with the measured value.
  - `pod-ci.yml` stays as it is: `pnpm verify` runs no packaging and needs no Electron binary.
  - `docs/install.md`, short, for friends. It covers: where to download; SmartScreen and Smart App Control (the plan's Known risks and Key decisions); the tools a friend needs; the setup check, with a typed path for a tool it can't find, as non-ASCII user folders may need (queue, 2026-11-03); the `CLAUDE*` note: these variables belong in `settings.json` `env`; updates ask before a restart; how to uninstall, naming the config folder that stays. Link it from `README.md`.
  - In `codebase-structure.md`, add to `## CI` and the smoke recipe: the release workflow, `pnpm package`, `pnpm test:install`, and `pnpm release:check`.
- **Files owned:** `.github/workflows/release.yml` (new), `package.json`, `packages/desktop/scripts/release-check.ts` (new), `packages/desktop/src/release-rules.ts` (new), `packages/desktop/src/release-rules.test.ts` (new), `packages/desktop/src/release-workflow.test.ts` (new), `packages/desktop/src/install-note.test.ts` (new), `packages/desktop/src/proof-release.test.ts` (new), `docs/install.md` (new), `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] v1.2.3 with version 1.2.3 passes; a mismatch, v1.2, v1.2.3-beta, 1.2.3, and v01.2.3 fail — release-rules.test.ts › tag matches the package version`
  - `[test] a size below the floor and above the ceiling fails, and one at each limit passes — release-rules.test.ts › installer size limits`
  - `[test] a wrong path, a wrong sha512, and unreadable YAML each fail by name — release-rules.test.ts › update file matches the installer`
  - `[test] the only trigger is a version tag — release-workflow.test.ts › runs on a version tag only`
  - `[test] every uses: in the file is a 40-hex SHA — release-workflow.test.ts › actions are pinned`
  - `[test] top-level permissions are empty, build reads, and only publish writes — release-workflow.test.ts › least-privilege token`
  - `[test] publish needs build, and has no checkout — release-workflow.test.ts › publish waits for the check`
  - `[test] in build, the release check comes after packaging, and no step there has a write token or publishes — release-workflow.test.ts › build checks and never publishes`
  - `[test] no step uses a draft or pre-release flag — release-workflow.test.ts › a normal release`
  - `[test] pod-ci.yml's verify job has no package step and keeps ELECTRON_SKIP_BINARY_DOWNLOAD — release-workflow.test.ts › verify stays free of packaging`
  - `[test] guarded: pnpm release:check passes on a real build, and the state diff is then empty — proof-release.test.ts › the check passes on a good build`
  - `[test] guarded: it exits non-zero, with no app left running, for an app with a broken server.mjs — proof-release.test.ts › fails when the app doesn't start`
  - `[test] guarded: it exits non-zero for a shrunken installer and for an asar whose main.cjs was repacked with the POD_BOARD_UPDATE_TEST text — proof-release.test.ts › fails on size and on a test feed`
  - `[test] guarded: a pinned actionlint release, downloaded to a temp folder with its checksum checked, reports nothing on release.yml — proof-release.test.ts › actionlint passes`
  - `[test] docs/install.md covers each topic above, and README.md links it — install-note.test.ts › note covers its topics` (checks for the topic's key term only: SmartScreen, Smart App Control, git, gh, claude, CLAUDE, settings.json, uninstall)
  - `[manual] a friend can follow the note with no other doc — read it through, once, as someone new`
- **Depends on:** P1
- **One-way door:** none in this sprint: no agent runs this workflow. The door is the human's tag. A tag publishes to friends, and the updater carries that build to every installed app until a higher version ships. The `build` job gates `publish`.
- **Model:** opus
