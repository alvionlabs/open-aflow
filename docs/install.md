# Install Pod Board

Pod Board runs on your Windows PC. It shows your pod runs across your repos.

## Download

1. Open the [latest release](https://github.com/iamphduc/pod-board/releases/latest).
2. Download `pod-board-setup-<version>.exe`.
3. Double-click the file. Pod Board installs for your user only. You don't need admin rights.
4. Open **Pod Board** from the Start menu.

## If Windows stops the installer

This build has no code signature, so Windows can warn you.

- **SmartScreen** shows "Windows protected your PC". Select **More info**, then **Run anyway**.
- **Smart App Control** can block the app, and it gives you no **Run anyway** button. If it blocks the app, tell the person who sent you this note. A code signature fixes this, and that work comes later.

## Tools you need

- `git`: [Git for Windows](https://git-scm.com/downloads/win).
- `gh`: [GitHub CLI](https://cli.github.com/). Run `gh auth login` once.
- `claude`: [Claude Code](https://code.claude.com/docs/en/setup). Sign in once. If you installed it with npm, Node must be on your `Path`. A native `claude.exe` doesn't need Node.

## The setup check

The app looks for these tools when it starts. If it can't find a tool, the **Setup check** screen opens.

1. Install the tool, then select **Recheck**.
2. If the tool stays missing, type its full path in the field on that row, then save. For example: `C:\Program Files\Git\cmd\git.exe`.

A typed path also helps when your user folder name has letters outside English, such as `C:\Users\Đức`. The app can fail to read such a folder from your system `Path`, but a typed path still works.

## CLAUDE variables

Runs that Pod Board resumes keep only three `CLAUDE*` variables from your shell:

- `CLAUDE_CONFIG_DIR`
- `CLAUDE_CODE_GIT_BASH_PATH`, which must be an absolute path
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`

Pod Board drops every other `CLAUDE*` variable. To use another one, put it in the `env` block of `%USERPROFILE%\.claude\settings.json`.

## Updates

The app checks for updates and downloads them for you. When an update is ready, it asks you. Select **Restart now** to install, or **Later** to wait. It asks again the next time you start the app. Your running `claude` sessions keep running through an update.

## Uninstall

Open **Settings** > **Apps** > **Installed apps**, find **Pod Board**, and select **Uninstall**. Your running `claude` sessions keep running.

The uninstall keeps your settings in `%APPDATA%\pod-board`. To remove them too, delete that folder.
