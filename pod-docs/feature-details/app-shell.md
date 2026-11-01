# App shell, theme, and install

## What it is

The frame around every screen: the web app at `http://127.0.0.1:<web>/`, the full-height left sidebar ("Pod Board" with `lost · retrying` only while the connection is lost, the runs list, and `Add repo` at the bottom, which opens the folder picker in a modal dialog), the ⋯ menu at the right end of the run header, the theme (System, Dark, Light, in the ⋯ menu; Dark when nothing is stored), the theme applied before first paint, the shared look (tokens, fonts, controls, icons), and the PWA manifest. Covers the features.md rows Web shell, Theme, Theme boot, and PWA. Theme code lives in `packages/web/src/theme/`; the boot script is inline in `packages/web/index.html`.

## How it works

- **Serving.** Vite serves the React app on the web port and proxies `/api` to the API port; both bind `127.0.0.1`.
- **Theme.** `pod-board-theme` in `localStorage`: `dark`, `light`, or `system`. Nothing stored, an unknown value, or storage that throws reads as `dark` (`readChoice`). `light` and `dark` set `data-theme` on `<html>`; `system` removes it so `prefers-color-scheme` decides. The ⋯ menu's `.seg` shows the choice with `aria-pressed`.
- **Theme boot.** An inline script before the module script applies the same rule, and a `color-scheme` meta plus `:root[data-theme]` rules make the browser canvas follow. `theme-color` metas are `#000000` / `#ffffff`; the manifest's colors are `#000000`.
- **Tokens.** Only theme files define colors and fonts. One token per Look palette entry: `--bg --surface --hover --border --border-strong --fg --muted --faint --primary-bg --primary-fg --focus`, status `--blocked --needs-you --running --ready --idle`, and `--shadow` (the menu only). `:root` holds light values; `[data-theme="dark"]` and the dark media query hold dark ones.
- **Fonts.** Geist 400/500/600 for UI and headings, Geist Mono 400/500 for paths, commands, numbers and labels: latin woff2 copied from Fontsource into `public/fonts/` with their OFL texts; `geist-400.woff2` is preloaded. Nothing loads from another host.
- **States.** A dot in the status color plus a word in `--fg` or `--muted` (`.status`, and `.chip`, which keeps its markup). Cards have no colored edge or fill. `chip tag` (the `fix` tag) is outlined with no dot.
- **Icons.** `Icon({ name })`: 16 px SVG, 1.5 px stroke, `currentColor`, `aria-hidden`. Names: `plus`, `more`, `check`, `chevron-right`, `chevron-down`, `arrow-up`, `folder`, `close`. Beside a label (`.btn.lead`, `.btn.trail`) the stroke is 1.75 px and the gap 6 px. No button label uses a text glyph.
- **Controls** (`base.css`): `.btn` 40 px with 20 px sides, `.btn.sm` 32 px with 12 px sides, labels 14 px / 500; `.lead` / `.trail` cut the icon side to 16 px (10 px small); `.btn.icon` is square and needs `aria-label`. `.btn.primary` is `--primary-bg` on `--primary-fg` (white on black in dark), `.btn.quiet` for Cancel. `.input`, `textarea.input`, `.switch` (`role="switch"`, `aria-checked`; the knob moves), `.tabs` / `.tab` (`aria-expanded`, `.n` count), `.seg`, `.menu` (the only shadow), `.card`, `.card.calm` (dashed), `.inplace` / `.inplace-actions`. At 480 px or less, buttons, inputs and switches are at least 44 px tall and icon buttons 44 × 44.
- **Sidebar.** A sticky, full-height left column (260 px by default, resizable from 200 to 400 px by the handle on its right edge; see runs-and-pipeline.md, Layout) with a right border: the title row, the runs, then `Add repo` (`.btn.sm.lead`, the `plus` icon) pinned to the bottom. At 820 px and below it stacks above the main column with a bottom border. No top bar.
- **Add repo dialog** (`AddRepoDialog`): a native `<dialog>` opened with `showModal()`, so the browser makes the page behind inert and sends Escape as `cancel`. A press that starts and ends on the backdrop closes it (`backdropClose`); the Close button, Escape and a successful Add close it too, and focus goes back to `Add repo`. The backdrop is `--bg` at 72 % opacity; the dialog is at most 720 px wide, and 16 px narrower than the screen at 480 px or less.
- **PWA.** `/manifest.webmanifest` and `/icons/icon-192.png`; Chrome offers to install from `127.0.0.1`.

## Why it's this way

- **A Vercel-style, dark-first, black-and-white look** ([plan Look](../plans/calm-dashboard.md#look), draft `../design-drafts/calm-dashboard-look-3.html`): the human picked it to make the board calm. It replaced the board-read look (slate and cobalt, Bricolage Grotesque, Instrument Sans, JetBrains Mono, tinted chips, colored card edges).
- **Dark by default**, not System: the human's plan choice. The manifest follows it so no white splash shows ([decision](../decisions.md#2026-10-28--app-manifest-colors-follow-the-dark-default), answered at gate 1).
- **States are dots plus words, never text color** ([decision](../decisions.md#2026-10-28--states-are-dots-plus-words-the-ink-tokens-go)): `--faint` and the light status colors fail 4.5:1 as text. This made the 2026-10-19 darker-ink-tokens decision obsolete.
- **An inline boot script plus `color-scheme`**, not `main.tsx`: in dev Vite loads the CSS from the module script, so a stored Dark choice painted white first.
- **Self-hosted fonts:** the plan rules out requests to other hosts.
- **A local web app with a PWA window**, not Tauri or Electron; a wrapper can come later.

## Watch out

- Build to `pod-docs/plans/calm-dashboard.md` `## Look` and its draft, not `docs/design/preview.html`.
- `tokens.test.ts` fails on a CSS file under `packages/web/src` that sets `color` to `--faint` or a status token (rules targeting an `svg`, such as the flow's status marks, may), uses an old token name (`--panel`, `--line`, `--accent`, `--ok`, `--warn`, `--bad`, `--*-soft`, `--*-ink`, `--display`, `--body`), or drops text below 4.5:1.
- `controls.test.ts` fails on any color literal in `base.css` (`transparent` and `currentColor` are allowed). Both tests find rules by selector text: write `textarea.input {` exactly and keep it after `.input`.
- The boot script and the app share `THEME_KEY` and the dark default; change both or neither. `pwa.test.ts` checks the manifest against the dark `--bg`.
- A render error shows `render failed` in place of the board and recovers on the next changed Board; keep the stream in `App`, above the `ErrorBoundary`.
- `showModal()` runs in a layout effect so the dialog is open before the picker's own effect focuses the path box, and the dialog closes before focus goes back to `Add repo`: a focus call while the dialog is still modal lands on an inert button and is lost.
- Native modal focus leaves the dialog for the browser's own UI after the last control (in headless Chrome, `body`); it never reaches the page.
- "Chrome reports installable" hasn't been checked in a review; agent-browser hangs from Git Bash here ([known issue](../known-issues/agent-browser-git-bash.md)).

## History

- 2026-10-19 · board-read · added: the bootstrap page (B1), the look foundation (server-runs L1), screen 1's theme control and PWA (S1), and theme boot (board-engineer X1) · [report](../reports/board-read.html)
- 2026-10-20 · board-read · final review passed at round 5; Theme, Theme boot, and PWA rows driven live · [report](../reports/board-read.html)
- 2026-10-20 · fix-show-fix-runs: an outlined kind tag chip (`chip tag`) marks fix runs in the runs list.
- 2026-10-21 · merge-actions L1: shared controls for the board's actions: `.btn.quiet`, `textarea.input`, `.switch`, `.inplace`, and 44 px controls at 480 px or less.
- 2026-10-25 · fix-render-error-boundary: a render error shows a notice and recovers on the next Board; it used to leave a blank page until a reload.
- 2026-10-28 · calm-screen L1: the calm-dashboard Look. Geist tokens and fonts, Dark by default (nothing stored reads as Dark), states as dots plus words, plain cards, the Look's button sizes, `.status`, `.tabs`, `.menu`, `.seg`, `.card.calm`, and `Icon`.
- 2026-10-28 · calm-dashboard · plan complete: the Vercel-style look on every screen, Dark by default, Geist self-hosted, theme moved into the ⋯ menu, no `live` chip while connected; final PR #54 passed review at round 1 · [report](../reports/calm-dashboard.html)
- 2026-10-28 · fix-sidebar-add-dialog · the full-height left sidebar is back and the top bar is gone: "Pod Board" (with `lost · retrying`) at the top, `Add repo` at the bottom, opening the folder picker in a modal dialog; the ⋯ menu moved to the right end of the run header.
- 2026-10-31 · fix-sidebar-resize · the sidebar resizes from 200 to 400 px by a handle on its right edge (260 by default, kept per browser, off at 820 px and below).
- 2026-11-01 · fix-remove-repo · the ⋯ menu ends with `Remove <repo> from the board` for a repo in the config; it opens an in-place confirm under the run header (Remove, Cancel, Escape; focus goes back to ⋯). After a removal the page moves to the next run, or to the empty state; with no runs left the URL drops its dead `#` hash.
