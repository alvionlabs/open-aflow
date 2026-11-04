# A question in other words doesn't stop a run

Severity: medium
Status: open · found 2026-11-03 · PR #81

**Who it affects:** anyone whose plan waits on a plain question from the orchestrator.

**What you see:** the run reads `running` or `idle` while pod waits for you. The entry stays listed in the Waiting tab, and you can answer it there, but nothing draws your eye to it.

**How to reproduce:**
1. On an active plan with no engineer at work, add a `PENDING · orchestrator → human` entry with no kind word and no default, in words outside the list, such as `The title still needs a name from the team.`
2. The run doesn't read `needs you`.

**Cause:** confirmed, by design. A plain entry stops a run only by its words (`ASKS` in `packages/model/src/pipeline.ts`): `needs you`, `needs your …`, `waiting on you`, `your go`, `your call` and similar, a sentence that starts with `please`, `pick`, `confirm` and similar, or a closing `?`. The board guesses meaning from prose.

**Workaround:** check the Waiting tab count on a run that seems to wait with no reason.

**Fix idea:** have `claude-pod` write `ask:` on every real question. The board already stops on `ask:` whatever the words. This needs a change in that repo.

**Evidence:** the rule is pinned by tests, and `Please pick a title.` and `ask:` were seen on the page. This exact sentence is traced from the regex, not run. No real entry of this shape has been seen.
