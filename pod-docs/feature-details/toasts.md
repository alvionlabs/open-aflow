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
  - The seen set lasts the app run and only grows. An item that goes and comes back, a reconnect, or a server restart never sends again.
  - Items are worked out on each Board and every `LIVE_TICK_MS`, because replies depend on `now`.
  - Up to 3 new items in one pass each get a toast. More than 3 get one toast: the title `<N> items need you`, the body the name of the run it opens, the first new item by tier, then list order.
  - A toast's title is `runName(...)`, and its body is `item.title`. A click calls `bus.showWindow(hashFor(run))`. A run that has since gone falls back through `resolveSelection`, as any hash does.
  - With `Notification.isSupported()` false, nothing sends, items are still marked seen, and nothing throws.
  - Each send logs one line with no entry text: `pod-board desktop: toast sent`.

## Why it's this way

- **Fetch, not `EventSource`.** The main process has no `EventSource`. `/api/events` needs only a loopback `Host`, so the shell never holds the session token.
- **The clock waits while the stream is lost.** The last Board may be stale then. A reply worked out from it could raise a toast about a server that has gone, or move the dot, and the dot keeps its value while the stream is lost.
- **Each item gets one try.** An item is marked seen before its send, so a send that throws can't repeat on every tick.
- **A throw stops at the notifier.** A throw in a timer would end the main process with an error box. The notifier logs it, and the dot keeps its value.

## Checks that wait for `installer-and-updates`

An unpackaged Electron has no Start-menu shortcut with `APP_ID`, so it can't prove these. The plan's Verification **Toast** row stays open until that sprint.

- the toast shows at all, with the app's name and icon
- a click on a toast from the notification center opens the run
- a real login launches the installed exe, in the tray
- the taskbar and exe icons

## Watch out

- **A repo id change sends again.** A repo's id changes when a name clash forms or ends. Its items then have new identities, so each one sends once more.
- **An edited queue line sends again.** An entry's identity is its whole line, so a line someone rewrites is a new item.
- **A PR that only `gh` can name arrives after the baseline.** The first Board at a start can come before `gh` answers. A fix PR or a merged-PR reply first shows on a later Board, so it sends once after each start, also when it is old. A wave PR isn't affected: an unknown state counts as open.
- Never import `@pod-board/web`'s `.tsx` files or its package root from the shell. Only the three subpaths are exported. `notifier.test.ts` bundles the main process and checks that it holds no React.
