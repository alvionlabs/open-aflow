# OpenAFlow

OpenAFlow is a Windows desktop app for [pod](https://github.com/iamphduc/claude-pod) runs. Pod is a plugin for Claude Code that builds a plan with agents, wave by wave. OpenAFlow shows every pod run across your repos in one window, and tells you when a run needs you.

## What it does

- **Shows each run:** its stage, the current wave's slices, and each agent's live activity.
- **Tells you what needs you:** a blocked agent, a PR to merge, or a question to answer. A toast appears, and the tray icon shows a dot, also when the window is closed.
- **Lets you act from the app:** merge a PR, answer a question, or send `continue` to the run's Claude session.
- **Can continue for you:** turn on Auto-continue for a run, and the app sends `continue` when pod waits for it.

OpenAFlow runs on your computer only. It reads your repos and Claude's session files, and it never writes inside a repo.

## Install

Windows only for now. Linux and macOS come later.

Follow [the install note](docs/install.md). It covers the download, the warning that Windows shows for an unsigned app, the tools you need (`git`, `gh`, `claude`, and pod), and how to uninstall.

## Develop

To build or change OpenAFlow, see [docs/development.md](docs/development.md).

## License

[MIT](LICENSE).
