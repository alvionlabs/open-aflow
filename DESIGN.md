# OpenAFlow design rules

Read this before any UI change. It holds all design rules.

## Layout

- Center the main content column in the space beside the sidebar: give it a max-width and `margin-inline: auto`, so the empty space splits evenly on both sides. Never let a capped column hug the left edge with a large empty area on the right.
- Pick the cap by content type: screen 1 uses one shared column as wide as the run flow (about 1120 px max), with text inside cards capped near 72ch; the wave board may use the full width.
- On narrow screens (≤ 820 px), the sidebar stacks above the main column instead of squeezing beside it.
- Sidebar run items are separate cards with a small gap, not one bordered box with divider rows.
- The sidebar is resizable on wider screens (200–400 px, 260 by default, kept per browser); the main column stays centred in the space left, and the page never scrolls sideways. The handle is off where the sidebar stacks.
- Sidebar cards change layout through a named container query (`run-card`), not a media query, because the sidebar resizes while the viewport doesn't.

## Buttons with icons

- Balance a button on its ink, not its boxes. An icon has empty space inside its box, so measure the visible space on both sides and make it equal.
- Give the icon side less padding than the text side (about 2–4 px less) in a left-aligned button; in a centered button, center the icon and label as one group on their ink.
- Match the icon to the label: 16 px icons with 14 px labels, and a stroke weight close to the label's stem (1.5–2 px at 16 px).
- Keep the visible gap between icon and label at about 6–8 px, counting the icon's own empty space.
- Never use text glyphs (`+`, `⋯`, `↑`) as icons; use SVG icons from the shared set.
- Size inline controls such as breadcrumbs to their text; never give them a fixed min-width that leaves uneven gaps.
- Icon-only buttons such as ⋯ use the ghost style (`.btn.ghost`): transparent at rest, a see-through fill on hover, focus, and while open, and the normal focus ring.
- Danger menu items use red text on a light red tint on hover and focus (color-mix of `--danger` at 14%, 18% on press), at 4.5:1 or more.

## Spacing

- Use multiples of 4 px for gaps, padding, and margins; 2 px is allowed only for cell padding inside tight rows.
- Keep inside space at or below outside space: rows in a group sit closer than the groups do.
- In a padded box, make horizontal padding larger than vertical (about 12 px by 16 px). Line height already adds vertical air.
- Put status values in a fixed-width, left-aligned column, so their dots line up on one rail. The column holds the status only (dot and word), so it never wraps.
- The status dot comes first, in a fixed-width column, everywhere.
- Show attributes and figures (confidence, model, minutes, tokens) as tags or inline text after the title, never in the status column.

## Forms and errors

Decided on 2026-11-13 in the Add repo modal ([choices](pod-docs/design-drafts/add-repo-error-choices.html)).

- Show each error in one place only. Never show the same error on the field and in a box.
- An error about one field goes directly under that field: red text (`--danger`, 14 px) with the 16 px alert icon, and no box. The field gets `aria-invalid="true"` and a red border (`--blocked`), and `aria-describedby` points at the error.
- While an invalid field has focus, its focus ring is red (`--blocked`), not blue. Never draw a blue ring around a red border.
- Use the alert box (a 1 px `--blocked` border, a light red tint, the alert icon) only for an error that is not about one field: the app failed, the server is out of reach, or the page must reload.
- Keep the submit button off only while the same input would fail again, such as a path that is already added. After an error where a retry can work, keep it on.
- Open a form with its field first. A picker button fills the field; it never submits by itself.
- Put a picker button, such as **Browse…**, on the same row as its field, at the right. On a narrow screen it may wrap under the field.
- In a form, a field and its label or error sit 8 px apart. Groups sit 16 px apart. The actions row sits at least 24 px below the last group.
- Write error text as what you can do next ("Couldn't add the repo. Try again."), not as a server code. Put the exact cause in the console.
