# UI7 verification journal (eque2-verifier, action: verify, batch UI7-UI24)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario UI7. No semantic verdict in this dispatch.
- State at start: UI7 not_started, untrusted. No prior UI7 journal. `update UI7 start` -> executing.
- Read: guardrails.md, verify-scenario/SKILL.md, tasks.md T4.11 (supports UI7), journal/task/T4.11.md and
  T4.11-verify.md, summary.test.ts, prompt.test.ts "summary:" cases, src/task/core/summary.ts, workers.ts `summary`,
  supervise/run.ts (finishing -> summarizing -> closed), session/prompt.ts `say` and `taskOps`, harness.ts,
  command.ts `job`, verify-spec-SV21/SV26 (pattern for a real /task resume), lib/command, lib/supervise, lib/machine.
- No sibling verify spec covers UI7, so write packages/opencode/test/task/verify-spec-UI7.spec.ts, titles `[UI7]`.
- Plan: the product wiring end to end. SessionPrompt's layer graph (as prompt.test.ts builds it) with the scripted
  model server and the process-wide `TaskHarness.Service`; a stored, unended whole-spec slice (T1.5 dead after 3
  failed proofs with reason `Type 'Promise<void>' | x`, T1 blocked, S4 waiting for its judge, S5 blocked, S13 parked on
  T8, a failed then clean spec check); two child sessions of the root that spent 1.5M tokens and $2.31 through real
  step-finish parts; `/task` typed through `SessionPrompt.command`; S4's judge is a scripted model turn that calls the
  real `verdict` tool and rejects S4 with `<`, `|`, `*`, backtick, `_`. Assert: one assistant message in the root
  (header then summary), zero tokens/cost, no model request carrying the root transcript, the exact summary lines.
  A second test draws the said summary with opentui's markdown element as the root transcript's TextPart does and
  checks that the reasons show as written.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (verify consumed failing evidence)
- Wrote packages/opencode/test/task/verify-spec-UI7.spec.ts (2 tests, titles `[UI7]`). oxlint --deny-warnings clean,
  prettier clean, `bun run typecheck` in packages/opencode clean.
- Test 1 (product wiring): Given asserted by folding the stored slice (T1 blocked, T1.1-T1.4 trusted, T1.5
  budget_exhausted, S4 verifying, S5 blocked, S13 parked, warned true, not ended); children spent cost 2 and 0.31.
  After `/task` the job completes, the run is final (`budget_exhausted`, S4 rejected), the lease is free; then
  `summaryLog()` must be empty -> FAILS: "task harness: the closing summary could not be written: Error:
  InstanceRef not provided". The root session holds only the header.
- Test 2 (render) fails because test 1 wrote no summary.
- Trial probe (removed): `say` wrapped in `InstanceStore.provide({ directory }, …)` through `TaskCommand.run` -> both
  tests pass (2 pass 0 fail). This validated every expected line, including the S4 reason line (no "S4: " prefix),
  and showed the opentui markdown element (TUI TextPart options) conceals the escapes, so the reasons show as written.
- Adapter run 20261016T220500Z-5b5b32: exit 1 (handed off, bun exit 1), 2 tests, 0 pass, 2 fail.
- `verify UI7 --evidence=…`: exit 0; structural testPassed false, trust untrusted -> untrusted ("evidence records a
  failing run"). Query after: state not_started, trustLevel untrusted.
- Defect recorded: journal/defects.md D10 (open).

## 2026-10-17 INTENT (fresh verification)
- State: not_started, untrusted, retryCount 1. D10 was fixed in e63744e21b.
- Keep the committed two tests and their assertions. Run the focused trial, lint and format checks, then one adapter run and CLI verify.
- This dispatch records structural evidence only; semantic trust belongs to a separate verifier.

## 2026-10-17 OUTCOME
- Trial: 2 pass, 0 fail (17.58 s). Prettier passed. Oxlint could not parse the committed `.oxlintrc.json`: `options.typeAware` is nested under `options`; no test-file diagnostic was produced.
- Adapter run `20261017T091336Z-f6137d`: 2 pass, 0 fail, exit 0; reporter produced signed evidence.
- `verify UI7`: structural checks pass, trust untrusted → verified. Query: state completed, trustLevel verified.
- The test covers the run fold, real judge verdict, one assistant summary, usage, warning, exact sections, escaping, and markdown render. No scenario coverage gap found.

## 2026-10-17 INTENT (independent semantic review)
- CLI reports completed / verified. Read the Gherkin, committed integration tests, T4.11 journal, summary implementation and UX contract. Run the registered file and assess the final-state trigger, message role and content, warning, model-call boundary and rendered escaping. Issue one CLI verdict. Do not edit tests or source.

## 2026-10-17 OUTCOME (independent semantic review)
- Two tests passed, 27 assertions. The resumed stored slice, real judge and final machine drive the root summary. Exact text and a rendered markdown frame cover every stated output. Called `verdict UI7 trusted` once; CLI query reports state completed, trustLevel trusted. No Gherkin gap found.
