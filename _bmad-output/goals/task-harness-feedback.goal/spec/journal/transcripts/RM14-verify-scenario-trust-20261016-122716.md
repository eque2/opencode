# RM14 verify-scenario-trust transcript (2026-10-16 UTC)

Fresh-context semantic verifier, spawned directly by the orchestrator (batch RM10-RM14). Outcome: **trusted**.

## What I read
- Dispatch prompt: scratchpad/prompts/scenario-RM10-RM14-verify-scenario-trust.md.
- references/guardrails.md and semantic-verify-scenario/SKILL.md (eque2-code-develop-spec).
- journal/scenario/RM14.md (the earlier verify run: Layer 1+2 passed, state completed/verified).
- packages/opencode/test/task/verify-spec-RM14.spec.ts (committed in 14cbaffb08; no diff at HEAD).
- spec.md default 4, defects 10 and 12 (SD-18 rule order; obligations keep their states); scenarios.gherkin RM14;
  tasks.md T1.4 (the "State Transitions" row for default 4).
- Code under test (read only): src/task/engine-xstate/machine.ts `CLASS`; src/task/engine-xstate/index.ts
  (`apply`, `waitingOn`, `stopOf`, `ended`); src/task/core/status.ts `project`; src/task/core/supervise/run.ts
  `tagsOf` and the `wallClock` region (the `run.ended` failed fact with "wall clock: ..."); test/task/lib/machine.ts.

## Gherkin steps and the assertions that cover them
1. Given a trusted, a building, a ready and a waiting task: T1.1 `trusted` (tags [ended]); T1.2 `building` on
   attempt 2 (tags [active, building]) with obligations [failed, trusted, trusted, trusted]; T1.3 tags [waiting,
   ready] (only the `ready` state has that phase tag in `CLASS`); T1.4 tags [waiting], waiting on [T1.2, T1.3]; no
   dead task; the run is not ended.
2. When the run is cancelled with a reason: `run.cancelled` "user stop: ctrl+x w".
3. Then the building, ready and waiting tasks are cancelled with that reason: the unfinished tasks are exactly [T1,
   T1.2, T1.3, T1.4, T1.5]; each is `cancelled` with that reason and tags [ended, stopped]; the history adds one
   entry each for T1.2 (building -> cancelled), T1.3 and T1.4 (-> cancelled) with that reason; every scenario is
   `cancelled` with that reason.
4. And the trusted task stays trusted; every obligation keeps its state and ends with its task: T1.1's status entry is
   equal before and after, with no new entry; the obligations map is equal before and after (states, reasons,
   times); no obligation entry is written; each obligation's task has the `ended` tag; the machine is final.
5. And the outcome is cancelled with that reason, because no task died: run `cancelled`, reason exactly the cancel
   reason, tags [ended, stopped], `stopOf` {cancelled, reason}. Control: the same cancel after T1.2 needs a human gives
   `needs_human`, first line "T1.2 needs human", last line the stop reason.
6. And a run wall-clock stop gives the run.ended state as the outcome in the same way: the supervisor's exact fact
   (`run.ended` failed, "wall clock: the run took over 30 min") passes the same unit checks; run `failed` with that
   reason, tags [ended, stopped], `stopOf` {failed, reason}.

Gaps: none. Notes: T1.3 "ready" is read from its tags, not the machine state name; the scenario loop has no count
assertion, but the release-notes plan holds S1-S13 (pinned by RM1). The wall-clock timer itself is covered by
supervise-run.test.ts, not here.

## Commands and results
- `state.mjs <spec> query scenario/RM14` -> completed, trustLevel verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad>/trust-runs/RM14/20261016T122630Z/junit.xml ./test/task/verify-spec-RM14.spec.ts`
  (cwd packages/opencode) -> exit 0, 3 pass, 0 fail, 171 expect() calls, 6.2 s.
- `state.mjs <spec> verdict RM14 trusted --reason "..."` -> {"verdict":"trusted","trustLevel":"trusted"}.
- `state.mjs <spec> query scenario/RM14` -> completed, trusted.

## Outcome
RM14 trusted. No source or test file changed. Nothing committed. No evidence or key file read.
