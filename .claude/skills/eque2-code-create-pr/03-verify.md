# Stage 3 — Verify (suite green)

Goal: confirm the change is green before it goes up for review. Don't open a PR over a red suite.

## Run the suite

- Run the project's standard test command. If a handoff artifact (e.g. `bug-fix.md`) already records a green full-suite run **on this exact diff**, you may trust it — but if anything has changed since (review fixes in Stage 2, a base sync), re-run.
- If the full suite is impractically large, run the affected package/area in full plus any tests touching the change, and say explicitly what you ran and what you did not — never let a partial run read as a full pass.

## Don't ship red

- If anything fails, stop. Diagnose: is it caused by this change, or pre-existing? If Stage 2 applied styleguide fixes, check whether one of them broke the test before assuming it's the original diff. If it's yours, fix it before proceeding. If it's pre-existing and unrelated, prove it (fails on the base too) and note it in the PR description — don't let it silently ride along.
- Also run lint/typecheck if the project gates on them; a PR that fails CI on format is wasted review latency.

## Output of this stage

- A green suite (or an evidenced, user-acknowledged exception) and the test evidence to cite in the PR description.

Proceed to `04-sync.md`.
