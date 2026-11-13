# Idea: Native folder dialog

Status: planned — pod-docs/plans/ui-rework.md

## The idea
A "Browse…" button next to the in-page folder picker. The board's server opens the OS "Select folder" dialog (on Windows, a PowerShell `FolderBrowserDialog` with a TopMost owner form) and returns the chosen path. On error or timeout, it falls back to the in-page picker. Allow only one dialog at a time.

## Why it's on hold
The `calm-dashboard` plan chose the in-page folder browser instead ([research](../research/folder-picker.md)). The dialog can open behind the browser, and the research found no real project that opens one from a local server. It also needs code for each OS, and some Linux machines have no dialog tool at all.

## What would make it worth building
Using the in-page picker turns out to be slower or clumsier than the OS dialog you're used to, especially on Windows.
