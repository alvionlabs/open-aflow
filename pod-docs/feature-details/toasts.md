# Toasts and the tray dot's source

## What it is

The Electron shell's notifier reads the live Board in the main process. It sends a Windows toast when something new needs the human, and it sets the tray dot's value on the shell bus. The window can be hidden, so this code runs without the page. See [desktop.md](desktop.md) for the shell.

## How it works

- **Layout.** `attention.ts` turns a Board into items. `board-stream.ts` reads `/api/events`. `notifier.ts` holds the seen set, the baseline, the burst, and the clock. `notifier-main.ts` is the glue: Electron's `Notification`, the host, and the bus. The tray reads only `bus.onAttention`.
- **One rule set.** `attention.ts` copies no rule. It imports `nextSteps`, `hashFor`, and `runName` from `@pod-board/web`, through three subpath `exports`. Those modules are pure, so the main bundle holds no React.
- **Items.**
  - For each run of `listRuns(board, now)`, take `card` plus `rest` of `nextSteps`, and keep the tiers `blocked`, `merge`, and `reply`. `pending` and `info` never count, so an engineer → orchestrator `BLOCKED` doesn't count.
  - A run in `error` or `unsupported` gives no items, even when its queue has entries.
  - Identity is `<repoId>\n<key>`: `entry:<line>`, `pr:<number>`, or for a reply `runReplies(...)[0].key`, the model's key for one stop.
  - An entry two runs list is one item, and the first run in list order opens.
  - A reply whose `pr` is a merge item of that run is no item of its own, so one merge gives one toast.
  - A reply row with `send === 'continue'` on a run in `board.autoContinue` is no item, because the board sends it itself. A toggled run with no session can't send, so it stays an item, and so does a `go` reply.
- **The stream.**
  - It parses `event: board` from a `fetch` stream of `GET http://127.0.0.1:<port>/api/events`, across any chunk split, a split inside a multi-byte character included. Comments, pings, and other events are ignored.
  - Bad JSON, or JSON that isn't a Board, is skipped, and the stream goes on.
  - A rejected fetch, a non-OK answer, or a closed stream retries after 5 s and never rejects. 45 s with no bytes counts as lost. That timer also covers a fetch that never answers.
  - `host.onReady` moves it to the new port at once. The first `before-quit` ends it, because a quit always goes through once it starts.
- **The dot** is on while at least one item exists. The many open `pending` entries never light it.
- **Toast rules.**
  - The first Board of an app run marks its items seen and sends nothing. The dot still shows them.
  - **The hold.** When that first Board has `gh: 'unknown'`, merge and reply items stay quiet too, for `GH_HOLD_MS` (20 s) from that Board, and again from gh's first `ok`. They are marked seen. `missing` or `logged-out` ends the hold at once. A first Board where gh has answered has no hold. A queue's `BLOCKED` line needs no `gh`, so a new one still sends during the hold.
  - The seen set lasts the app run and only grows. An item that goes and comes back, a reconnect, or a server restart never sends again.
  - Items are worked out on each Board and every `LIVE_TICK_MS`, because replies depend on `now`.
  - Up to 3 new items in one pass each get a toast. More than 3 get one toast: the title `<N> items need you`, the body the name of the run it opens, the first new item by tier, then list order.
  - A toast's title is `runName(...)`, and its body is `item.title`. A click calls `bus.showWindow(hashFor(run))`. A run that has since gone falls back through `resolveSelection`, as any hash does.
  - With `Notification.isSupported()` false, nothing sends, items are still marked seen, and nothing throws.
  - Each send logs one line with no entry text: `pod-board desktop: toast sent`.

## Why it's this way

- **Fetch, not `EventSource`.** The main process has no `EventSource`. `/api/events` needs only a loopback `Host`, so the shell never holds the session token.
- **The clock waits while the stream is lost.** The last Board may be stale then. A reply worked out from it could raise a toast about a server that has gone, or move the dot, and the dot keeps its value while the stream is lost.
- **The hold has a time limit after `ok`, not only until `ok`.** The server's `gh` tick and its rebuilds run side by side, so a Board can say `ok` between `gh auth status` and the PR reads. The Board doesn't say when those reads end. `gh` that never answers can't silence toasts: with no repo, `gh` stays `unknown`, and the limit ends the hold.
- **Each item gets one try.** An item is marked seen before its send, so a send that throws can't repeat on every tick.
- **A throw stops at the notifier.** A throw in a timer would end the main process with an error box. The notifier logs it, and the dot keeps its value.

## What this machine shows

Measured on Windows 11 and an unpackaged Electron 45.2.1, on a temp copy of the mock repo:

- A new `BLOCKED → human` line gives one `toast sent` line in the shell's log, and the bus's attention value goes on. The log holds no entry text.
- `Notification.isSupported()` is true, and Electron's `show` event fires on an unpackaged toast. That event doesn't prove the toast was on the screen. No agent can see it, so it stays a check for a person.
- Firing the `click` event on the real `Notification` object calls `bus.showWindow` with the run's hash. A real click isn't proved.
- A start with a registered repo and an open `BLOCKED → human` sends nothing, and the attention value goes on. The server builds its first Board before it listens, so that Board is never empty.
- After a `taskkill /F` on the server, `onReady` fires again. The old item stays quiet, and a new line sends one toast.
- Answering an entry that joins no plan, on the page, sets the attention value off.
- Answering a plan's `BLOCKED` doesn't set it off. See **Watch out**.

## Human list

`pnpm test:install` proves these on the installed app: the exe runs with a Start-menu entry that `Get-StartApps` gives the AppID `com.iamphduc.podboard`, a new `BLOCKED → human` line logs one `toast sent`, and `--hidden` answers health and opens no window. No agent can see the items below. Do them after the sprint's last proof, because a real install makes `refuseRealInstall` stop the proofs.

First, if `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk` exists, delete it (see **Watch out**). Then run `pnpm package`, run `packages/desktop/release/pod-board-setup-<version>.exe`, and open Pod Board from the Start menu. Then check each item.

1. **The toast shows at all, with the app's name and icon.** Register a temp copy of `E:\Projects\pod-trial-mock`. Append a `BLOCKED · orchestrator → human` line to the copy's `pod-docs/handoff-queue.md`. A toast shows, with the name `Pod Board` and its icon.
2. **A click on a toast from the notification center opens the run.** Wait for the toast to leave the screen. Open the notification center and click the toast. The window opens on that run.
3. **A real login launches the installed exe, in the tray.** Turn on Start at login in the tray's menu. Sign out and sign in. The tray icon shows, and no window opens.
4. **The taskbar and exe icons.** With the window open, the taskbar shows the Pod Board icon. In File Explorer, `%LOCALAPPDATA%\Programs\pod-board-desktop\Pod Board.exe` shows it too.

To uninstall, go to Settings > Apps > Installed apps > Pod Board > Uninstall. This removes the login item. It keeps `%APPDATA%\pod-board` and `%APPDATA%\Pod Board`. Delete `%LOCALAPPDATA%\pod-board-desktop-updater` by hand to get its space back.

## Watch out

- **A dev toast can leave a Start-menu shortcut.** This machine has an `Electron.lnk` from 2026-11-03, with the AppID `com.iamphduc.podboard`, that targets the `electron.exe` of a `desktop-shell-w2` worktree. No code here writes it, so it likely came from Electron at a toast of an unpackaged run. `Get-StartApps` then lists `Electron` for that AppID, also beside `Pod Board.lnk`, and a toast may show that name. A friend's machine has no unpackaged run, so it doesn't apply there.
- **Answering a plan's entry raises a reply.** pod reads an answer only when it resumes, so the model then offers `continue`. The `BLOCKED` item goes, and a new reply item comes in the same pass: the dot stays on, and a `Send continue` toast follows the answer at once. On a toggled run with a session, the board sends it, so there is no item.
- **A repo added after the start isn't in the baseline.** Its open items are new, so they send, or give one summary toast.
- **A repo id change sends again.** A repo's id changes when a name clash forms or ends. Its items then have new identities, so each one sends once more.
- **An edited queue line sends again.** An entry's identity is its whole line, so a line someone rewrites is a new item.
- **A slow `gh` can still outlast the hold.** With many repos, or PR reads near their 10 s limit, the reads can end more than 20 s after gh's first `ok`. An old fix PR or merged-PR reply then sends once at that start.
- **A new merge or reply in the hold sends nothing.** It is marked seen, and the dot shows it. The same goes for a server restart in the hold: the new server's PR items can send once, if the first hold has ended.
- Never import `@pod-board/web`'s `.tsx` files or its package root from the shell. Only the three subpaths are exported. `notifier.test.ts` bundles the main process and checks that it holds no React.

## History

- 2026-11-03 · windows-app plan fix · fixed: old items that only `gh` can name no longer send at every app start. The baseline holds merge and reply items until `gh` has answered or reads as unavailable.
