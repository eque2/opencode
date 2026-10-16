# SV11 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier, spawned by the develop-spec orchestrator (batch SV11-SV15).

## Read
- The dispatch prompt, references/guardrails.md, semantic-verify-scenario/SKILL.md.
- journal/scenario/SV11.md (the earlier Layer 1+2 verify), tasks.md (T2.7, T2.8).
- packages/opencode/test/task/verify-spec-SV11.spec.ts (committed in 237e47bfa1, clean in the worktree).
- test/task/lib/supervise.ts (scripted session boundary: model side only; real Recorder, real event store).
- src/task/core/supervise/task.ts (spendCap guard on turn.status in watching and tool; `ended` checks `capped`
  before `repeated`, `readied` and `nudgeLeft`), workers.ts (turn reads spendCapError after the prompt;
  sessionEvents relay), sessions.ts (SPEND_CAP regex, spendCapError).

## Gherkin step -> assertion
- Given a building task -> `unitState(before,"T1.1") === "building"`, `hasTag("T1.1:building")`, session `ses_T1.1`.
- When a retry status names the spend cap -> test 1 publishes `SessionStatus.Event.Status` retry with a quota
  message on the real bus; the real relay delivers it.
- When the turn's error names the spend cap -> test 2: the turn leaves an assistant message with
  `error.data.message = "insufficient_quota: ..."`, read by the real `spendCapError`.
- Then task.needs_human with "spend cap:" -> `toMatchObject([{type:"task.needs_human",task:"T1.1",reason:"spend cap: <msg>"}])`
  and `reason.startsWith("spend cap:")`; the run actor folds T1.1 to `needs_human`; test 1: cancels = [ses_T1.1].
- And no nudge -> stored types equal exactly `["task.needs_human"]`, `context.nudges === 0`, one prompt, no nudge text.
- Controls: a non-cap retry records `[]` and the turn keeps watching; a non-cap turn error records `task.nudged` 1.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-SV11.spec.ts` (packages/opencode): 2 pass, 0 fail, 26 expect, 18.9 s.
- `state.mjs <spec> verdict SV11 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap found.
