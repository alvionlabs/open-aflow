# Installer and updates

## What it is

`pnpm package` builds a per-user Windows installer. A pushed version tag runs a workflow that checks the installer and publishes a GitHub Release. An installed app finds a new release, downloads it, and asks before it restarts. No agent publishes anything. Friends read [docs/install.md](../../docs/install.md).

## How it works

- **Package.** One-click NSIS, no admin rights, a Start-menu entry and an Installed apps entry named `Open AFlow`, no desktop shortcut. The installer is `open-aflow-setup-<version>.exe`, the exe `Open AFlow.exe`, the app ID `com.alvionlabs.openaflow`, and the install folder `%LOCALAPPDATA%\Programs\open-aflow`. The update feed is the GitHub releases of `alvionlabs/open-aflow`. `resources/app.asar` holds `dist/main.cjs`, `assets/`, and `package.json`. `resources/server` holds the bundle. `THIRD-PARTY-NOTICES.txt` comes from each bundle's esbuild metafile. A package with no licence file and no override stops the step.
- **After the install.** A normal install opens the app (`runAfterFinish`). A silent install stays closed, so a proof never starts the app with no temp env. The update path is silent with `--force-run`, which starts its one new copy, as it always did. The template rule is `${ifNot} ${Silent} ${orIf} ${isForceRun}` in `installSection.nsh`, and `build-config.test.ts` fails if a new electron-builder changes it.
- **Release.** `release.yml` runs only on a tag `v<major>.<minor>.<patch>` that equals `version` in `packages/desktop/package.json`. Job `build` has a read token: it runs `pnpm verify`, `pnpm package`, and `pnpm release:check`. Job `publish` needs `build`, has the write token, and runs no repo code.
- **Check.** `pnpm release:check` checks the size, `latest.yml`, and the blockmap, then installs, starts, and uninstalls the app. `pnpm test:install` runs the longer proofs. Each ends with `state diff: []`.
- **Update.** Only in a packaged app. First check 30 s after the first server ready, then every 6 h. `autoDownload` on. `autoInstallOnAppQuit` and `allowDowngrade` off.

```mermaid
flowchart TD
  T[Check is due] --> A{Newer release?}
  A -->|no, or an error| Q[One log line with no URL; wait for the next check]
  A -->|yes| D[Download in the background, check sha512]
  D -->|fails| Q
  D -->|done| B[One box: Restart now or Later]
  B -->|Later| L[Install nothing; the next launch asks again from the cache]
  B -->|Restart now| S[Stop the server, drain, then quitAndInstall]
  S --> I[Installer ends what runs from the install folder, by process ID, with no tree]
  I --> N[Installer starts the new app; detached claude runs live]
```

**Example.** A proof installs 0.1.0 and serves 0.1.1 from `http://127.0.0.1:3111/`. The app finds it and logs the ask. On `restart`, it stops the server and quits. About 25 s after the feed's answer, the same install folder runs 0.1.1 (Windows reports `0.1.1.0`) and health answers. A detached `fake-claude` run, `config.json`, and the Start at login value all stay.

**Logic lives in:** `packages/desktop/src/build-config.ts`, `update-flow.ts`, `release-rules.ts`, `install-check.ts`, and `.github/workflows/release.yml`.

## Why it's this way

- **Unsigned, with `verifyUpdateCodeSignature: false`.** Friends won't rebuild, and an unsigned build needs the check off. Turned down for now: signing, which waits for the next plan. Trade-off: nothing proves who published an update, so the GitHub account is the trust boundary. Signing comes before a public launch.
- **Only the human's tag publishes.** The sprint contract replaced the plan's two throwaway test releases with a local feed. Trade-off: the GitHub path stays unproved until the first two tags.
- **`open-aflow` as the packaged name.** It names the install folder and the updater's cache folder. NSIS's `--delete-app-data` removes `%APPDATA%\<name>`, so it must never be `pod-board`, the server's config folder.
- **The server stops first on Restart now.** The installer's `Stop-Process` would end it with no drain.
- **The test feed is compiled out.** A build-time flag removes it from every shipped build, and `release:check` refuses a build that holds its text.

## Watch out

- **Start the app's exe with `windowsHide: false` in a proof.** `windowsHide` starts it with SW_HIDE, and Windows applies that to the first `ShowWindow`, so the window never shows on a sound app. The exe has no console, so nothing extra opens. `hidden-processes.test.ts` allows this only in the files it names. After a failed `installed app runs`, the next tests fail too: that test throws before it stops the app, so the app keeps the lock and later launches exit at once.
- **Quit and update must never tree-kill.** electron-builder 26.18.1 uses `Stop-Process -Id` or `taskkill /IM`. `build-config.test.ts` fails if a bump adds `taskkill /T`.
- **The workflow has never run on GitHub.** Its launch check on `windows-latest`, `gh release create`, and the GitHub provider are unproved.
- **Open queue item (now):** the updater starts after the first server ready, so a build whose server can't start on one machine can't update itself out.
- **Open queue item (before hosting):** no Electron fuses are set, so `ELECTRON_RUN_AS_NODE` still works on the shipped exe.
- A real install makes `refuseRealInstall` stop every proof. Uninstall first.
- `pnpm package --test-feed` is for proofs only. Never upload its files.
- An uninstall leaves `%LOCALAPPDATA%\open-aflow-updater`, about 122 MB. It keeps `%APPDATA%\pod-board`.
- `quitAndInstall` often emits `error` and doesn't throw, so the flow treats that as a failed install: it logs and quits.
- The templates match a process by `StartsWith($INSTDIR)`, so an exe in a sibling folder with that prefix also ends.
- The local proof shows the full-download fallback, not a differential download.
- This machine has Developer Mode on, so "no Windows setting needed" for electron-builder isn't proved.

### First release: the human's hand-off

1. Set `version` in `packages/desktop/package.json` on the merge target, and merge it.
2. Run `git tag v<version>`, then `git push origin v<version>`. Watch the `release` workflow until it passes.
3. On a machine with no Open AFlow, download `open-aflow-setup-<version>.exe` from Releases, click through SmartScreen (`More info`, `Run anyway`), and open the app from the Start menu.
4. Set a higher `version`, merge it, and repeat step 2.
5. Leave the app open. Within 30 s of its next start, or 6 h while it runs, it opens the box. Choose `Later`, and open the app again: it asks again. Choose `Restart now`: it installs and opens on the new version.
6. To uninstall: Settings, Apps, Installed apps, Open AFlow, Uninstall.

To pull a bad release, delete it on the Releases page, then tag a higher version. Friends who already updated stay on the bad one until then, because the updater never moves down.

## History

- 2026-11-03 · installer-and-updates P1 · the per-user installer, the app icon, the licence notices, and the install proof · [PR #80](https://github.com/iamphduc/pod-board/pull/80)
- 2026-11-03 · installer-and-updates U1 · auto-update, the test feed, and the local two-version proof · [PR #82](https://github.com/iamphduc/pod-board/pull/82)
- 2026-11-03 · installer-and-updates R1 · the release workflow, its local check, and the install note · [PR #82](https://github.com/iamphduc/pod-board/pull/82)
- 2026-11-03 · windows-app · final PR #83, verdict fix at round 2 · [report](../reports/windows-app.html)
- 2026-11-04 · fix-late-merge-continue · a normal install opens the app. A silent install still stays closed.
- 2026-11-04 · fix-late-merge-continue · fixed: `proof-install` failed its window check since 2026-11-03 (`b32d1a2`), when `windowsHide: true` reached the proof's app start. A login start's no-window check also meant nothing while that flag was on.
- 2026-11-05 · fix-rename-open-aflow · renamed: the app is Open AFlow. New installer and exe names, app ID, install folder, updater cache folder, and the update feed at `alvionlabs/open-aflow`.
