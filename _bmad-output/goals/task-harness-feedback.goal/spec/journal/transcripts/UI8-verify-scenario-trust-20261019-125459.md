# UI8 verify-scenario-trust transcript (2026-10-19 12:54:59)

Fresh-context semantic review, dispatched by the orchestrator after commit 688450d923.

## What I read

- The dispatch prompt `journal/prompts/scenario-UI8-verify-scenario-trust.md`.
- `.claude/skills/eque2-code-develop-spec/references/guardrails.md` and `semantic-verify-scenario/SKILL.md`.
- `journal/scenario/UI8.md` (recovery): the state at start was completed, verified.
- `scenarios.gherkin` lines 755-759 (matches the CLI `gherkin` field); `tasks.md` T4.11 (Supports UI7, UI8, UI20, UI23,
  UI24); `spec.md` SD-19 (the lease is released once the run machine is final).
- `git show 688450d923`: only `packages/opencode/test/task/verify-spec-UI8.spec.ts` changed.
- The whole committed test (482 lines). `git diff 688450d923 -- <test>`: the file is identical to the commit.
- Product code it drives: `src/task/core/supervise/run.ts` (`finish`, the `running.main` states `active` →
  `finishing` → `summarizing` → `closed`, `closing`, `awaitClosed`, `cancel`); `src/task/core/harness.ts` (`run.claim`,
  `run.release` guarded by the holder, `live`, `running`); `src/task/core/command.ts` `job` (finalizer order);
  `src/task/core/recorder.ts` (`record` publishes, then sends, under one permit); `src/task/core/workers.ts`
  `summary`; `src/session/prompt.ts` `say` (waits behind a turn in flight through `ensureRunning`);
  `src/task/core/events.ts` `latestRun`; `test/lib/effect.ts` `pollWithTimeout` (20 ms poll).

## The commit

`runFinal` no longer folds the slice every 20 ms. It waits until `harness.live(directory)` is none and the latest slice
holds a fact of type `last`, and it returns that slice. The new `ended(flight, slice)` asserts that the slice folds to
`done`. The run-ends case calls it at once on the result of `runFinal`. The cancel case calls it after `closed` on the
slice captured by `runFinal`. The bound changed from 60 s to 120 s, and the test timeouts from 180 s to 300 s.

## Can the lease wait pass while the machine is not final, or before the summary step?

Ways the lease becomes free (one lease per directory; `run.release` succeeds only for the holder):

1. `finish` in the run supervisor: it runs only when a `run.changed` snapshot is not `active`. It awaits the writer
   fiber, then releases. `summarizing` follows when the actor has no defect.
2. `closing`: a failed start only. It does not apply here, because the run started and S4's judge asked its model.
3. The job scope finalizer: it was added first, so it runs last. It runs after the cancel finalizer, which is
   `RunSupervisor.cancel` on a job cancel (`run.cancelled`, then `untilClosed` bounded by `cancelDeadline`, then
   `removeRun`). Otherwise the job scope closes only after the supervisor closes.
4. The `onExit` handlers of the command or harness on a failed start: they do not apply here.

- Run-ends case: `latestRun` slices from the last `run.started`, so the stored S1-S12 `scenario.verified` facts already
  satisfy `last`. The wait therefore reduces to "lease free". No cancel occurs, so only path 1 applies. A free lease
  means the actor is not active, the writer has ended, and the summary step comes next. `ended(slice)` then checks the
  stored slice. The Recorder stores a fact before it applies it, under one permit, so the stored slice matches the
  actor. The test also asserts that the supervisor is still running 1 s later.
- Cancel case: path 1 is normal. Path 3 frees the lease only after `untilClosed` or the 5 s deadline. `untilClosed`
  cannot finish while `say` waits for the held turn. A release by the deadline removes the supervisor. That logs
  "the closing summary was dropped" and writes no summary, so `summaryLog == []` and the one-summary check fail.
- A slice that does not fold to `done` fails `ended()`. It does not wait and it does not pass.

Conclusion: the change from fold to lease cannot give a false pass. It also does not weaken any step.

## Each Gherkin step and the assertion that covers it

- Given a root session with a turn in flight: `inFlight` stores the unended release-notes slice (it asserts that the
  fold is not ended). It types `/task` through `SessionPrompt.command` (the header text is asserted) and polls for the
  S4 judge's model hit while the judge is held. It forks the user's QUESTION, polls for its model hit while the reply
  is held, and asserts that `SessionStatus` is `busy`.
- When the run ends / the user aborts / the run is cancelled: there is one test for each path. (a) Release the
  judge's verdict, then `runFinal(scenario.verified)` and `ended`. (b) `SessionPrompt.cancel(session)`; then exactly one
  `run.cancelled` and no S4 verdict are stored. (c) A forked `BackgroundJob.cancel(id)`, `runFinal(run.cancelled)`,
  and `ended`.
- Then the summary waits for the turn and is then written once: in (a) and (c), with the turn held and the run final
  with a free lease, no summary and no summary log exist after 1 s or 0.5 s. (a) also asserts that the supervisor is
  still running. The turn is then released, and its answer is asserted. After `closed`, `writtenOnceAfterTheTurn`
  asserts: no summary log (no failure, no drop), exactly one summary that starts with the OUTCOME line, `parentID`
  equal to the run header, the summary as the last message after the question, and only assistant messages between.
  In (b) the abort ends the turn, and the summary is asserted once, after the aborted turn.
- And a later user prompt in the root session still runs a model turn: the LATER prompt returns an assistant message
  with LATER_ANSWER. A new LLM hit holds LATER. The session still holds one summary.

## Commands and results

- `state.mjs <spec> query scenario/UI8`: completed, verified (before).
- `git diff --quiet 688450d923 -- packages/opencode/test/task/verify-spec-UI8.spec.ts`: identical.
- `uptime`: load 26.10.
- `bun test --timeout=30000 ./test/task/verify-spec-UI8.spec.ts` (cwd packages/opencode): 3 pass, 0 fail, 50 expect()
  calls, 32.39 s.
- `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .../state.mjs <spec> verdict UI8
  trusted --reason "..."`: exit 0, `{"verdict":"trusted","trustLevel":"trusted"}`.
- `state.mjs <spec> query scenario/UI8`: completed, trusted (after).

## Outcome

UI8 is trusted. The verdict was issued once through the CLI. Residual note (not a gap): the "waits for the turn"
window is time-based (1 s / 0.5 s), because no signal shows that `say` is blocked. This is unchanged from the earlier
trusted version. The summary worker reaches `say` after two reads and pure text building, so the window is meaningful.
No source, test or state file was edited. Nothing was committed.
