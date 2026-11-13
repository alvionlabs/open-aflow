# Idea: Test the folder dialog on Linux and macOS

Status: parked

## The idea
Test the Add repo folder dialog on Linux and macOS. The [ui-rework plan](../plans/ui-rework.md) opens Electron's folder dialog through a preload, and tests it on Windows only. Electron provides the dialog on all three systems. On Linux it depends on the desktop's portal or GTK, so some setups may show no dialog. There, Add repo would need the path field as a fallback.

## Why it's on hold
Windows ships first, then Linux, then macOS ([decision](../decisions.md)).

## What would make it worth building
The Linux build starts, for example with the terminal host plan, which makes Linux a real target.
