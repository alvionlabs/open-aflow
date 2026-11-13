# Idea: Automatic input through the hosted terminal

Status: parked

## The idea
The third terminal-host plan, after v0.1.0. One send path (gate, word, one Enter, log, check the next `UserPromptSubmit`), the draft rule, idle by the 60 s rule and by hooks, the typing-wait setting (30 s), and auto-continue and the Continue button writing to the hosted terminal. It covers the untested gaps (question dialog, plan approval, trust prompt, subagents after `Stop`) and queue item 2026-11-04 on auto-continue past a gate during a CI wait. The full list of inputs, gates, and tests is [automatic-input.md](../research/automatic-input.md); decisions 9 and 13–17 in [terminal-host.md](../research/terminal-host.md).

## Why it's on hold
It is the riskiest part: a wrong send can drift a whole workflow. Using the app only does not need it, so it does not hold v0.1.0 (decision 2026-11-13). Until then, Continue on a hosted run opens the Terminal tab.

## What would make it worth building
`terminal-host` and `openaflow-plugin` are merged, and typing `continue` by hand in the Terminal tab becomes the main chore.
