# Idea: macOS support for the terminal host

Status: parked

## The idea
Build, package, and test the app on macOS: node-pty's prebuilt binary in a signed app, the terminal checks with Playwright `_electron`, and ending a session with no cgroups (the process tree and the `OPENAFLOW_RUN` marker only; the run wrapper is empty by default). The run wrapper settings already show on macOS (decision 21).

## Why it's on hold
The order is Windows, then Linux, then macOS (decision 2026-11-02). [terminal-host](../plans/terminal-host.md) ships Windows and Linux only.

## What would make it worth building
Windows and Linux ship, and a friend or user asks for a Mac build.
