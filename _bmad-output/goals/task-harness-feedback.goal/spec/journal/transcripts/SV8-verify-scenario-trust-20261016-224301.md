# SV8 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (semantic trust), batch SV6-SV10, OpenCode runtime.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; journal/scenario/SV8.md; tasks.md T2.5, T2.11;
  spec.md owner ruling 3; EXPERIENCE.md "Busy reply".
- Test `packages/opencode/test/task/verify-spec-SV8.spec.ts` (unchanged since 6841bc0e5d).
- Code: `src/task/core/command.ts` (lines 395-515), `test/task/lib/command.ts`.

## Gherkin step -> assertion
- Given a live run of the release-notes spec in a directory -> real `/task` start (registry "run" mode runs the job's
  effect): run.started and two task.started stored, `harness.running` true, `harness.live` = {runID, spec, path},
  status.json written.
- When /task runs for a valid spec in the same directory -> example-scenarios, its task folder, release-notes.
- Then it starts nothing and answers one line that names the live run's spec and path -> reply equals the literal
  EXPERIENCE busy line, no newline; no new job start; no fact for the other spec; lease unchanged; status.json still
  the live run's (not refused); the live run gains no run.* fact.
- And a claim whose background job does not start is released, so the next /task is not busy -> test 2: start dies
  (lease none), job already running elsewhere (lease none), then the next /task claims and starts; test 1: after cancel
  the directory is free.

## Gaps
- None against the Gherkin. Minor: spec and path are the same string for the live run, so the test does not separate
  the two fields.

## Commands
- `state.mjs <spec> query scenario/SV8` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-SV8.spec.ts` (packages/opencode) -> 2 pass, 0 fail, 10.5 s.
- `state.mjs <spec> verdict SV8 trusted --reason ...` -> exit 0, trustLevel trusted.

## Outcome
Trusted.
