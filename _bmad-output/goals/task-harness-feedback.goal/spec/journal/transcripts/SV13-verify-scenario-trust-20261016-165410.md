# SV13 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier, spawned by the develop-spec orchestrator (batch SV11-SV15).

## Read
- journal/scenario/SV13.md, tasks.md (T2.5, T2.6, T2.8, T2.11).
- packages/opencode/test/task/verify-spec-SV13.spec.ts (committed in 237e47bfa1).
- src/task/core/hooks.ts: sendReady, sendVerdicts return false with no owner; repetitionStop reads the owner's limit.
- src/task/core/harness.ts: ownerOf, hooks, claimSession, removeRun.
- src/session/prompt.ts createTaskHarnessTools: NO_OWNER reply with valid false when the send fails.

## Gherkin step -> assertion
- Given a builder session claimed by its task supervisor -> `ownerOf(session)` equals
  `{owner: task:<run>:T1.3, watch: true}`; claimed by the real supervisor through `harness.claimSession`.
- When task_ready / verdict / repeat past the limit -> the real tools from `createTaskHarnessTools(..., harness.hooks)`
  and the real `TaskHooks.repetitionStop` (none for 1 and 2 calls, the reason at 3, limit 3 from the owner).
- Then the owner receives the event and records its fact when the turn ends -> context `ready` true / the verdicts /
  `repeated`; no matching fact while the turn is held; the fact stored after the release with `at >= release`.
- And an unowned session records nothing and the tool says so -> NO_OWNER replies with valid false; limitOf and
  repetitionStop none; stored types and the owner's context unchanged.
- And every claim of a run is removed when the run ends -> real `TaskCommand.job`, ended by its wall clock and by a
  cancel: run claims gone, another run's claim kept, `running(id)` false, a later call says NO_OWNER.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-SV13.spec.ts` (packages/opencode): 5 pass, 0 fail, 51 expect, 63.6 s.
- `state.mjs <spec> verdict SV13 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap.
