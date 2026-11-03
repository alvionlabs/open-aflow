# Sprint: outside-terminal

_From plan: pod-docs/plans/windows-app.md · Slug: outside-terminal · Status: active · Generated: 2026-11-02_
<!-- autopilot-run: started=2026-11-03T05:06:41Z sprints=1 waves=3 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | T1 | Tool finder, tool routes, and a merged `Path` for children | outside-terminal-T1 | — | pending | — | — |
| 1 | L1 | Look: the setup check's styles on the existing tokens | outside-terminal-L1 | — | pending | — | — |
| 2 | C1 | Clean stop and one auto-continue owner | outside-terminal-C1 | — | pending | — | T1 |
| 2 | U1 | Setup check screen | outside-terminal-U1 | — | pending | — | T1, L1 |

## Shared contract

**Scope of this sprint.** `pnpm dev` keeps its behavior. Only the owner file reaches dev. The tool finder, the tool routes, the stop message, and the parent watch run in production only. No Electron code. No change to the model's `Board`. No mobile or accessibility criteria, and existing code for them stays as it is.

**Checks.** Slice ports: T1 3100/3101, L1 3110/3111, C1 3120/3121, U1 3130/3131. Use temp config, ports, and claude folders, and register `E:\Projects\pod-trial-mock` or a temp copy with `POST /api/repos`. Never a real repo, and never the mock's own `.board` config.

**Tool states.**

```ts
// packages/server/src/tool-finder.ts (T1)
export type ToolName = 'git' | 'gh' | 'claude'
export type ToolState =
  | { tool: ToolName; state: 'found'; path: string; source: 'env' | 'settings' | 'path' | 'registry' | 'known' }
  | { tool: ToolName; state: 'missing' }
  | { tool: ToolName; state: 'bad-path'; path: string; source: 'env' | 'settings' }
```

**Find order (first match wins, per tool).**

1. `claude` only: `POD_BOARD_CLAUDE_BIN`, when set. That value only, with no search. No file → `bad-path`, `source: 'env'`.
2. A path in settings. It wins over every search. It fails the path rules below → `bad-path`, `source: 'settings'`, with no search and the tool isn't used. Clearing it brings the search back.
3. The inherited `Path`, absolute entries only.
4. The registry `Path`: HKLM, then HKCU. `%VAR%` expands from the env. An entry with an unknown variable, a relative entry, or a UNC entry is dropped.
5. Known folders, each skipped when its variable is unset: Git's `cmd` and `GitHub CLI` under both Program Files and `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`, `\.local\bin`, and `\.claude\local`, and `%APPDATA%\npm`.

- On other systems, steps 4 and 5 don't run.
- The current folder and a repo folder are never searched.
- **Extensions on Windows:** `git` and `gh`: `.com`, `.exe`. `claude`: `.com`, `.exe`, `.cmd`, `.bat`. A shim keeps the existing handling in `claude-runner.ts`.
- `git` has no caller in the server. The finder reports it and adds its folder to the child `Path`.
- The finder only checks that a file exists. It never runs a tool, so a check starts no tool and shows no window.
- The registry read uses `reg.exe` by absolute path from `SystemRoot`, with `windowsHide` and a 5 s limit. A failed read counts as an empty result, and a finder failure never stops the start.

**Path rules (settings file and route).** A string with no NUL; an absolute drive path (`not absolute`); not two leading separators, refused before any file system call (`not a local path`); a file (`not a file`); and a base name of the tool's name plus an allowed extension (`wrong tool`). The route answers with these words. The file reader turns any failure into `bad-path`.

**Settings file.** `<config dir>/tool-paths.json` = `{ "git"?: string, "gh"?: string, "claude"?: string }`, written through a temp file and a rename. Missing, unreadable, or bad JSON reads as nothing set. A value that isn't a string is ignored. It's read at each check.

**Child env.** `gh` and resumed `claude` get the inherited env with `Path` = inherited absolute entries, then registry entries, then the folders of found tools, with duplicates removed (case-blind on Windows). The existing `safeChildEnv` and `childEnv` rules still apply on top, so `CLAUDE*` variables still drop. Both `gh` uses in `start-server.ts` (the reader and the action routes) read the finder's path and env at each call, so a Recheck takes effect with no restart. In dev, both stay on `defaultGhExec` and the existing runner lookup.

**Routes (production only; dev answers 404).**

| Route | Guard | Request → answer |
|-------|-------|------------------|
| `GET /api/tools` | request guard, then `readGuard` (`403 bad token`) | Runs a new check, then `200 { tools: ToolState[] }`, always in the order git, gh, claude. Calls during a running check share its result. This is also the Recheck |
| `POST /api/actions/tool-path` | action guard | `{ tool, path }`; `path: null` clears. `200 { tools }`, after a new check. `400 { error }`: `bad request` or a path rule word; nothing is saved. `500 { error: 'settings unwritable' }`. Not in the action log |

**Setup gate (web).** On page load the page asks `GET /api/tools`. Any tool not `found` → the setup check replaces the board, with no way past it. All found, any non-200 answer (dev's 404 included), no page token, a network failure, or no answer in 5 s → the board. The board doesn't show or connect while the answer is pending. The check runs only on load, on Recheck, and after a path save. A tool that goes away while the board is open shows at the next load. Accepted edge: a check slower than 5 s shows the board even with a tool missing, because a hung check must not lock anyone out.

**Server messages (the seam for `utilityProcess`).**

```ts
// packages/server/src/parent-link.ts (C1)
export const STOP_MESSAGE = { type: 'pod-board:stop' } as const
export type ReadyMessage = { type: 'pod-board:ready'; port: number }
export type ParentChannel = { onMessage(fn: (m: unknown) => void): void; send(m: unknown): void }
/** `process.parentPort` (message in `e.data`), else Node IPC (`process.send`), else none. */
export function parentChannel(proc?: ProcessLike): ParentChannel | undefined
```

- **Message.** Only an exact stop message counts. Any other value is ignored and never throws. A stop that arrives during start runs once the start ends. A failed start exits 1 with no ready message. `ready` goes out once, after the bind, and a closed channel never throws.
- **Parent watch.** `POD_BOARD_PARENT_PID` holds the parent's process ID. The shell sets it next sprint. Unset or empty: no watch, so a plain `pnpm start` outlives whatever started it. Bad value: stops the start, naming the variable. It's polled every 2 s and at once at start. Gone → the same stop. A reused process ID reads as alive, so the server then stays up. This is an accepted edge.
- **One stop path.** The message and the watch run the existing `createShutdown` at most once. A repeat never turns into its "second press" `exit(1)`. Ctrl+C keeps its meaning: a second signal quits at once, also after a message started the stop. A signal followed by a message doesn't force a quit.
- **The drain cap stays `DRAIN_CAP_MS` (70 s).** `desktop-shell` must set its kill timeout above it.
- **Closed output.** `EPIPE` on stdout or stderr is ignored in production, so a dead parent's pipe doesn't end the drain. Other stream errors act as today.
- **Quit never kills a detached run.** No tree kill, no Job Object. The stop code ends only its own process.
- Dev attaches no channel and doesn't read `POD_BOARD_PARENT_PID`.

**Owner file.** `<config dir>/auto-continue-owner.json` = `{ pid, id, startedAt }`, `id` being a random value per server. Dev and production both use it.

- **Take:** after the bind, right before the automatic check starts, with an exclusive create. A server that can't start never holds it.
- **Other holder alive** (`process.kill(pid, 0)`; `EPERM` counts as alive): this server runs with no automatic check and logs one line naming the holder's process ID and the config folder. It looks only at start, so it stays off until restart, also after the owner exits.
- **Stale** (process gone, or the file holds bad JSON): remove it and create again. Losing that race reads as another holder.
- **Before each check, the owner re-reads the file.** Another `id` → it stops sending for good and logs one line. File gone → it creates the file again.
- **Any other file error:** fail closed, with no automatic check, and log one line.
- **Release:** at the end of a normal stop, after the drain, only when the file holds its own `id`. A failed release or a forced quit leaves a stale file, which the next start takes over.
- **Not covered:** Continue and Go buttons, and the toggle route, act as today on both servers. A toggle changed on the second server's page reaches the owner only at its next start.

**Not this sprint.** Electron, the Start-menu launch, the shell's restart rule, and the friends' install note. The check doesn't look for pod: the plan's scope, parts, and verification name only `git`, `gh`, and `claude`. For `desktop-shell` to prove: `shimTarget`'s fallback `process.execPath` is Electron's exe in a `utilityProcess`, and a detached child must outlive the app, since libuv doesn't break out of a job.

## Per-slice detail

### T1: Tool finder, tool routes, and a merged `Path` for children
- **Scope:**
  - Build `createToolFinder({ env, platform?, settingsFile, readRegistryPath? })` with `check()`, `states()`, `path(tool)`, `env()`, and `setPath(tool, path | null)`, as the contract says. The registry reader is injectable, so no test depends on this machine.
  - Wire it into production in `startServer`: the first check runs before the watcher starts. Add a `gh` exec and a runner that read the finder at each call, with the current signatures still working for dev. `createClaudeRunner` may take `bin` and `env` as functions.
  - Add both routes. `AppDeps` gets an optional `tools`; with none, `GET /api/tools` is 404 and `tool-path` isn't mounted.
  - Update `server.md`, `resume.md`, and `codebase-structure.md` (the new route, file, and smoke recipe lines). Don't build any web code, the stop message, or the owner file.
- **Files owned:** `packages/server/src/tool-finder.ts` (new), `packages/server/src/tool-finder.test.ts` (new), `packages/server/src/tool-routes.ts` (new), `packages/server/src/tool-routes.test.ts` (new), `packages/server/src/no-terminal.test.ts` (new), `packages/server/src/gh.ts`, `packages/server/src/gh-exec.test.ts`, `packages/server/src/claude-runner.ts`, `packages/server/src/claude-runner.test.ts`, `packages/server/src/app.ts`, `packages/server/src/app.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `pod-docs/feature-details/server.md`, `pod-docs/feature-details/resume.md`, `pod-docs/codebase-structure.md`
- **Success criteria** (finder tests set `Path`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramFiles`, and `ProgramFiles(x86)` to realpath'd temp folders, with empty files as fake tools and a fake registry reader. Nothing rests on what this machine has installed):
  - `[test] An inherited absolute entry finds each tool, source path — packages/server/src/tool-finder.test.ts › finds tools on the inherited Path`
  - `[test] With an empty Path, a registry entry finds the tool, source registry — tool-finder.test.ts › finds tools through the registry Path`
  - `[test] With an empty Path and registry, each known folder finds its tool, source known; an unset variable skips only its folders — tool-finder.test.ts › finds tools in known folders`
  - `[test] With nothing anywhere, all three read missing, in order, with no throw — tool-finder.test.ts › reports missing tools`
  - `[test] Relative and empty Path entries and a fake gh.exe in the current folder are never found — tool-finder.test.ts › never searches the current folder`
  - `[test] Registry text in REG_SZ and REG_EXPAND_SZ forms parses, HKLM before HKCU; %VAR% expands in any case; unknown-variable, relative, and UNC entries drop — tool-finder.test.ts › reads the registry Path`
  - `[test] One failed or timed-out hive keeps the other; both failed reads empty, and the check still ends — tool-finder.test.ts › a failed registry read stops nothing`
  - `[test] A settings path wins over a tool on Path; a bad one is bad-path with no search; clearing it brings the search back — tool-finder.test.ts › a path in settings wins`
  - `[test] POD_BOARD_CLAUDE_BIN wins over settings and, when its file is missing, is bad-path and never finds another claude — tool-finder.test.ts › the env value is the only claude`
  - `[test] gh.cmd is skipped for gh, and claude.cmd is found for claude — tool-finder.test.ts › each tool keeps its extensions`
  - `[test] Bad JSON and non-string values in the settings file read as nothing set; a UNC value is bad-path with no file system call — tool-finder.test.ts › a bad settings file`
  - `[test] A tool added after the first check is found by the next, and two calls during a check share one registry read — tool-finder.test.ts › each check looks again`
  - `[test] env() holds inherited, registry, and found-tool folders in that order, once each, under the existing key, with other variables kept — tool-finder.test.ts › merges the child Path`
  - `[test] On another platform, the registry reader isn't called — tool-finder.test.ts › no registry off Windows`
  - `[test] GET /api/tools answers the three states in order; no token is 403; a foreign Host is 403 — packages/server/src/tool-routes.test.ts › tool states sit behind the guards`
  - `[test] tool-path saves a good path and answers the new states; null clears it — tool-routes.test.ts › sets and clears a path`
  - `[test] A relative path, a UNC path, a folder, a missing file, a wrong base name, an unknown tool, and a non-string each get 400 with its word, and nothing is saved — tool-routes.test.ts › refuses bad paths`
  - `[test] tool-path with no token is 403, and with a failed write is 500 with the old file intact — tool-routes.test.ts › guarded and atomic`
  - `[test] With no tools dep, GET /api/tools and POST /api/actions/tool-path are 404 — packages/server/src/app.test.ts › dev has no tool routes`
  - `[test] A gh stand-in found by the finder runs with an empty inherited Path, and sees the merged Path (a copy of where.exe as gh.exe locates a file in a registry folder) — packages/server/src/gh-exec.test.ts › gh runs from the finder with the merged Path`
  - `[test] gh with no found path answers not-found, and runs after a check finds one, with no restart — gh-exec.test.ts › gh follows a recheck`
  - `[test] A fake claude.cmd found through the fake registry starts with an empty inherited Path; its record shows the merged Path and no CLAUDE variables but CLAUDE_CONFIG_DIR — packages/server/src/claude-runner.test.ts › a stripped Path still starts the found claude`
  - `[test] A missing claude from the finder is a failed start with no spawn — claude-runner.test.ts › no found claude fails the start`
  - `[test] Production startServer exposes the routes and dev doesn't — packages/server/src/start-server.test.ts › tool routes are production only`
  - `[test] Bundle run alone, with Path holding only System32 and tool-paths.json naming temp fakes: /api/tools reads found from settings, and removing a fake reads bad-path on the next GET — packages/server/src/no-terminal.test.ts › the bundle finds tools with a stripped Path`
  - `[manual] Real check on this machine: after pnpm build, start server.mjs from a small Node script with detached: true, stdio: 'ignore', Path emptied, temp folders, and port 3100, with the mock repo registered. /api/tools reads found for git, gh, and claude, the Board's gh status is not not-found, and no console window appears in 60 s. Stop it by process ID and check the port.`
- **Depends on:** —
- **One-way door:** none. The route and file are additive, sit behind the existing guards, and revert with git. The route chooses which file the server later runs, so it takes the session token and the path rules.
- **Model:** opus

### L1: Look: the setup check's styles on the existing tokens
- **Scope:** The plan's Look adds no tokens and no fonts, so don't change `tokens.css`, `fonts.css`, or `base.css`. Add `screens/setup/setup.css` for a page with no sidebar, centered with a max-width per `DESIGN.md`, with one row per tool: a fixed-width status column first, then the tool name, then its path or what to do, then the path field, and one Recheck button. States come from the existing `.status` classes; controls from `.btn` and `.input`. Add a look test that keeps this sprint on the existing look. No TSX: U1 uses these classes.
- **Files owned:** `packages/web/src/screens/setup/setup.css` (new), `packages/web/src/screens/setup/setup-look.test.ts` (new)
- **Success criteria:**
  - `[test] Every var() in setup.css is defined in tokens.css, and it holds no color literal — packages/web/src/screens/setup/setup-look.test.ts › uses only existing tokens`
  - `[test] setup.css defines no -- names of its own — setup-look.test.ts › adds no tokens`
  - `[test] --fg and --muted reach 4.5:1 on --bg and --surface in both themes — setup-look.test.ts › text contrast`
  - `[test] Every font in fonts.css loads from this site's /fonts/, and setup.css sets no font family outside the existing tokens — setup-look.test.ts › self-hosted fonts`
  - `[test] Gaps, padding, and margins in setup.css are multiples of 4 px, and the root rule has a max-width with margin-inline auto — setup-look.test.ts › follows DESIGN.md spacing and layout`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### C1: Clean stop and one auto-continue owner
- **Scope:**
  - Build `parent-link.ts` (channel adapters, stop triggers, parent watch, the `POD_BOARD_PARENT_PID` read, and the output guard) and `owner-file.ts`, as the contract says, with a shared process-alive check.
  - Connect them in `startServer` and `runMain`. In production, the channel and the watch start before `startServer`. `createAutoContinue` gets an optional owner check; with none, it acts as today. `createShutdown` gets an optional release step before a normal exit.
  - Update `server.md`, `resume.md`, and `codebase-structure.md`: the env variable, the owner file, the production stop line in the smoke recipe, and remove the "use separate config folders" notes.
  - Don't change `claude-runner.ts`'s `detached` start or add any process kill.
  - Run tests build their own bundle, as `bundle-app.test.ts` does, with 90 s per test. A run's session comes from the smoke recipe's resume setup, with `fake-claude.mjs` in `wait:` mode, killed in teardown by its recorded process ID.
- **Files owned:** `packages/server/src/parent-link.ts` (new), `packages/server/src/parent-link.test.ts` (new), `packages/server/src/owner-file.ts` (new), `packages/server/src/owner-file.test.ts` (new), `packages/server/src/clean-stop.test.ts` (new), `packages/server/src/bundle-app.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `packages/server/src/shutdown.ts`, `packages/server/src/shutdown.test.ts`, `packages/server/src/auto-continue.ts`, `packages/server/src/auto-continue.test.ts`, `packages/server/src/main.test.ts`, `pod-docs/feature-details/server.md`, `pod-docs/feature-details/resume.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] A fake parentPort's message event with data { type: 'pod-board:stop' } requests a stop, and ready goes through postMessage — packages/server/src/parent-link.test.ts › adapts the parentPort shape`
  - `[test] A process with send uses Node IPC, and one with neither has no channel — parent-link.test.ts › adapts Node IPC and no channel`
  - `[test] null, strings, other types, and a stop with the wrong type are ignored with no throw — parent-link.test.ts › only the exact stop message counts`
  - `[test] A send on a closed channel doesn't throw — parent-link.test.ts › a closed channel is harmless`
  - `[test] Two requests stop once; request then signal forces; signal then request doesn't; signal then signal forces — parent-link.test.ts › one stop path`
  - `[test] A request before stop is attached runs once it's attached — parent-link.test.ts › a stop during start waits`
  - `[test] Unset and empty read as no watch; 0, -1, and abc throw naming POD_BOARD_PARENT_PID — parent-link.test.ts › reads the parent's process ID`
  - `[test] The watch fires once when the fake check turns false, at once when already false, and never after it's stopped; EPERM from the real check reads as alive — parent-link.test.ts › watches the parent`
  - `[test] An EPIPE on a fake stream is swallowed, and another error is not — parent-link.test.ts › a closed pipe doesn't end the drain`
  - `[test] A free folder gives ownership and a file with this process ID — packages/server/src/owner-file.test.ts › takes a free file`
  - `[test] A holder alive gives no ownership and one log naming its process ID and the folder — owner-file.test.ts › a live holder keeps it`
  - `[test] A file naming an exited child's process ID, and a bad JSON file, are taken over — owner-file.test.ts › takes over a stale file`
  - `[test] Another id in the file ends ownership for good, with one log; a gone file is created again — owner-file.test.ts › the owner checks again`
  - `[test] An unwritable folder gives no ownership, with no throw — owner-file.test.ts › an error fails closed`
  - `[test] Release removes its own file and leaves another's — owner-file.test.ts › releases only its own`
  - `[test] With an owner check that says no, a due send doesn't start; with none, it does — packages/server/src/auto-continue.test.ts › only the owner sends`
  - `[test] Release runs after the drain and before exit(0), and a throwing release still exits — packages/server/src/shutdown.test.ts › releases after the drain`
  - `[test] A start that fails on a busy port leaves no owner file — packages/server/src/start-server.test.ts › a failed start holds nothing`
  - `[test] Dev and production both take the owner file, and the first's stop removes it — start-server.test.ts › both modes use the owner file`
  - `[test] Bundle forked with IPC: ready carries the port from the listening line; a stop message exits 0 and removes the owner file — packages/server/src/clean-stop.test.ts › stops by message`
  - `[test] Bundle with a resumed fake claude running: after the stop message, the server is gone and the fake is still alive — clean-stop.test.ts › a stop leaves a resumed run alive`
  - `[test] A helper parent starts the bundle with piped output and POD_BOARD_PARENT_PID, and is then killed: the server exits within 15 s, its owner file is gone (the drain finished), and a resumed fake is still alive — clean-stop.test.ts › a dead parent stops the server and leaves the run`
  - `[test] POD_BOARD_PARENT_PID naming an exited process stops the server soon after its start; a bad value exits 1, naming the variable, with no listening line — clean-stop.test.ts › a parent gone at start`
  - `[test] With no channel and no variable, the bundle stays up after its starting process exits — clean-stop.test.ts › a plain start has no watch`
  - `[test] Two bundles on one config folder with a toggle on and one due stop: the second logs the first's process ID, exactly one fake starts, and the second's health check stays ok — clean-stop.test.ts › one auto-continue owner`
  - `[test] The first's stop leaves the second serving with no send, and a restart of the second takes ownership — clean-stop.test.ts › the second stays off until restart`
  - `[test] The dev entry ignores a stop message over IPC and POD_BOARD_PARENT_PID, and stays healthy — packages/server/src/main.test.ts › dev has no parent link`
  - `[manual] With a temp config folder, run pnpm dev on 3120/3121: both ports answer and the page shows the board as before. Then run the bundle on the same folder on another port: its log says why it doesn't auto-continue, and the board still works there.`
- **Depends on:** T1 (both change `start-server.ts`)
- **One-way door:** none. The file is additive and removable. Deleting it, or a revert, restores today's behavior. No process other than the server's own is ever ended.
- **Model:** opus

### U1: Setup check screen
- **Scope:**
  - Build `setup-client.ts` (reads `/api/tools` with the page token, gives the gate's answer per the contract) and `setup-view.ts` (the rows, words, and fixes), with their tests. Paths go through the existing `postAction`.
  - Build `SetupScreen.tsx` as glue, using L1's classes, and a thin gate in `main.tsx` or `App.tsx` so the board's stream starts only once the gate says board.
  - A row shows a dot plus word: `found` a ready dot and its path; `missing` and `bad-path` a blocked dot, what to do, and a path field. One install command or link per tool, taken from that tool's current docs. A `bad-path` from `env` shows the variable's name and no path field, since settings can't override it.
  - One Recheck button. A note, always on the screen, says `CLAUDE*` variables belong in `settings.json` `env`, because resumed runs drop those set only in a shell.
  - When a check or save shows all found, the board appears. Add the note to `README.md` and the screen to `app-shell.md`.
- **Files owned:** `packages/web/src/screens/setup/SetupScreen.tsx` (new), `packages/web/src/screens/setup/setup-view.ts` (new), `packages/web/src/screens/setup/setup-view.test.ts` (new), `packages/web/src/screens/setup/setup-client.ts` (new), `packages/web/src/screens/setup/setup-client.test.ts` (new), `packages/web/src/screens/setup/setup.css`, `packages/web/src/App.tsx`, `packages/web/src/main.tsx`, `README.md`, `pod-docs/feature-details/app-shell.md`
- **Success criteria:**
  - `[test] GET /api/tools carries the token header, and a tool not found gives setup with the rows — packages/web/src/screens/setup/setup-client.test.ts › a missing tool opens the setup check`
  - `[test] All found gives board — setup-client.test.ts › all found opens the board`
  - `[test] 404, 403, 500, bad JSON, a shape with no tools, a rejected fetch, and no token each give board — setup-client.test.ts › no answer never blocks the board`
  - `[test] A fetch that never settles gives board after 5 s, on fake timers — setup-client.test.ts › a slow answer opens the board`
  - `[test] The gate reads checking until the answer, then setup or board — setup-client.test.ts › the board waits for the gate`
  - `[test] Rows keep the order git, gh, claude, with the status class and word for each state — packages/web/src/screens/setup/setup-view.test.ts › rows show each state`
  - `[test] A missing tool and a bad-path tool have a fix and a path field; a found one has neither — setup-view.test.ts › what to do per state`
  - `[test] A bad-path from env names the variable and has no path field — setup-view.test.ts › an env path can't be overridden here`
  - `[test] The note names settings.json, env, and CLAUDE — setup-view.test.ts › the note on CLAUDE variables`
  - `[test] A 400 on save keeps the setup rows and shows that word on that row; a save reply with all found moves to board — setup-view.test.ts › saving a path`
  - `[test] A failed Recheck keeps the rows and shows that it failed, and a Recheck with all found moves to board — setup-view.test.ts › rechecking`
  - `[manual] Hide claude for a temp config: pnpm build, then the bundle on 3130 with the mock repo registered and tool-paths.json naming a temp claude.cmd that doesn't exist. At desktop width in Dark and Light: the screen replaces the board, names claude and how to fix it, and shows the note; dots line up on one rail, spacing follows DESIGN.md, and there is no splash or tour.`
  - `[manual] Create that file and press Recheck: the board shows the mock's runs. Delete it, reload, and type the path of another fake claude.cmd in the field: it's saved and the board shows. Type a wrong path: the row shows why.`
  - `[manual] pnpm dev on 3130/3131 with a temp config: the board shows, with no setup check. On the bundle with a tool hidden, the network panel shows no /api/events request while the setup check is up.`
- **Depends on:** T1, L1
- **One-way door:** none
- **Model:** opus
