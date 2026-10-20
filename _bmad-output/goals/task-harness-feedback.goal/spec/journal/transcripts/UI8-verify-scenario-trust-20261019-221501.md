# UI8 verify-scenario-trust — 2026-10-19 22:15 (batch UI8, RM19)

Fresh-context semantic review after cfc1bb0948 (owner ruling 10). Dispatched directly by the orchestrator.

## What I read

- Dispatch prompt `journal/prompts/scenario-UI8-RM19-verify-scenario-trust.md`; `references/guardrails.md`;
  `semantic-verify-scenario/SKILL.md`.
- `journal/scenario/UI8.md` (recovery; earlier trust and structural runs).
- The UI8 Gherkin in `scenarios.gherkin` (line 755) and the CLI query; goal.md owner rulings 4, 8 and 10.
- `git show cfc1bb0948` (only `verify-spec-UI8.spec.ts`: bounds and timeouts, one comment).
- The whole committed test `packages/opencode/test/task/verify-spec-UI8.spec.ts` (HEAD equals the working tree).
- Product code: `src/task/core/supervise/run.ts` (`finish`, `finishing` -> `summarizing` -> `closed`),
  `src/task/core/workers.ts` (`summary`: logs a failure or a drop), `src/session/prompt.ts` (`say`, which waits
  through `ensureRunning` until it wrote).

## Gherkin steps and their assertions

| Step | Assertion |
| --- | --- |
| Given a root session with a turn in flight | `inFlight`: real SessionPrompt / TaskHarness / BackgroundJob wiring; `/task` resumes a stored release-notes slice (unended, asserted); S4's judge reaches the model with its reply held; the user's QUESTION reaches the model with its reply held; `SessionStatus` is `busy` |
| When the run ends | (a) the judge is released; `runFinal` waits for a free lease and `scenario.verified`; `ended()` asserts the folded run machine is final |
| When the user aborts the root session | (b) `SessionPrompt.cancel`; exactly one `run.cancelled` stored; no S4 verdict stored (the abort, not the judge, ended the run) |
| When the run is cancelled | (c) `BackgroundJob.cancel` on its own fiber; `runFinal` waits for `run.cancelled` and a free lease; `ended(slice)` |
| Then the summary waits for the turn | (a) after 1 s no summary, no summary log, run still running; (c) after 0.5 s no summary, no summary log; then the root turn is released and returns ANSWER |
| and is then written once | `writtenOnceAfterTheTurn`: no summary failure log; exactly one assistant message starting with the outcome line; parent = run header; last message; after the question with only assistant messages between |
| And a later user prompt still runs a model turn | the LATER prompt returns an assistant message with the scripted LATER answer; the model server records a LATER hit; the summary count stays 1 |

## Can a larger bound hide a failure?

No. The four changed bounds wait for positive progress (a model hit, a free lease plus the last fact, a closed job and
supervisor) or end a hang; the test timeouts only end a hang. The negative checks (the no-summary windows, the summary
log, the one-summary count, the order checks) keep their values. In the cancel case, a summary stopped by the cancel
deadline logs "dropped" and fails `summaryLog`, so load can fail the test but cannot pass a defect.

## Commands and results

- `state.mjs <spec> query scenario/UI8`: completed, verified (before).
- `git diff --stat HEAD -- packages/`: empty.
- `uptime`: load 43.20 / 66.29 / 76.81.
- `bun test --timeout=30000 ./test/task/verify-spec-UI8.spec.ts` (cwd packages/opencode): 3 pass, 0 fail, 50 expect()
  calls, 73.67 s.
- `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .../state.mjs <spec> verdict UI8
  trusted --reason "..."`: exit 0, `{"verdict":"trusted","trustLevel":"trusted"}`.
- `state.mjs <spec> query scenario/UI8`: completed, trusted (after).

## Outcome

UI8 is trusted. One verdict was issued through the CLI. Residual note (not a gap, unchanged): the "waits for the turn"
window is time-based (1 s / 0.5 s); `say`'s wait through `ensureRunning` is structural in the code. No source, test or
state file was edited. Nothing was committed.
