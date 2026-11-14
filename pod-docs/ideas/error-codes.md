# Idea: One list of error codes, and clear messages in every form

Status: parked

## The idea
Give every failure in OpenAFlow one defined error code, as a word (`already_registered`, `no_claim`, `config_unwritable`), not a number. Keep the codes in one shared, typed list that the server and the web app both use, with one line on what each means. Then:
- Every form turns a code into a short, warm message (the style the human picked on 2026-11-13 in PR #113: "This repo is already here", "Something went wrong. Please try again"). No raw server word or `HTTP 500` reaches the screen.
- The exact code and HTTP status go to the console, and to the app's log file in the desktop app, so a bug report can name them. An optional muted **Details** line with a copy button can show them.
- The build fails when a code has no message.

It also covers the 8 forms the 2026-11-13 audit found breaking the new `DESIGN.md` "Forms and errors" rules: the answer form (the field goes red on a server error; Save stays on after a text error), the merge panel, the setup tool path field and Recheck, Close and Keep, the reply panel's Continue and Go, the Auto-continue switch, and the button and spacing rules in Remove repo and Forget. Today `actions-client.ts` passes the server's raw word, or `HTTP <status>`, straight to the screen; only Add repo maps it.

Options not chosen: number codes such as `E1043` (rejected by the human: a word says what went wrong without a lookup table, and a number table must be kept up to date).

## Why it's on hold
It touches every server route and every form, so it is bigger than PR #113, which only does Add repo, Remove repo, and Forget.

## What would make it worth building
Before v0.1.0. The human, on 2026-11-13: "I think this one is crucial for the release because it helps us track bugs."
