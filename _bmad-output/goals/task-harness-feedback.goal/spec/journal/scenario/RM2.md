# RM2 verification journal (eque2-verifier, action: verify, batch RM2-RM6)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario RM2. No semantic verdict in this dispatch.
- State at start: RM2 not_started, untrusted, retryCount 0. No prior RM2 journal. The test file does not exist.
- Plan: read spec.md, scenarios.gherkin (RM2), tasks.md (T1.2 Supports RM2), machine.ts and machine.test.ts.
  Write packages/opencode/test/task/verify-spec-RM2.spec.ts (titles start with `[RM2]`), trial it with bare
  `bun test`, then `update RM2 start`, one adapter run, and `verify RM2 --evidence=...`.
- I write only the scenario test file. No source edits, no commits, no evidence or key reads.

## 2026-10-16 OUTCOME (test written, Layer 1+2)
- `update RM2 start`: not_started -> executing.
- No sibling verify spec covers RM2, so I wrote the registered file packages/opencode/test/task/verify-spec-RM2.spec.ts
  (4 tests, each title starts with `[RM2]`). It drives the real loader (`Blend.load`, `loadPlan`), the generator
  (`TaskMachine.config`, `machine`, `mapStates`, `stateId`) and the engine (`TaskEngineXState.initial`, `apply`).
- Plans checked: every `task-formats/blend/*.spec` folder that loads, whole-spec and a subtree plan per task.
- Trial runs without the reporter: 4 pass, 0 fail, 520 expect() calls, about 11.4 s. tsgo clean, oxlint 0, prettier clean.
- Real run 20261016T121123Z-a3db4d through the adapter at HEAD 62554af3aa (file untracked, sha256 prefix
  329d5ec4ebbf54f2): bun exit 0, 4 pass, 0 fail, 520 expect() calls. Decision: handed-off, adapter exit 0.
- `verify RM2`: structural pass (testInCommit false, as expected). State completed, trust untrusted -> verified.
- Finding for the semantic verifier: with two task ids that collide, the plain config silently keeps one region
  (Object.fromEntries), so the refusal comes from the unit-key check ("duplicate unit T1_1: T1.1, T1_1"); the
  state-id check is shown by a task id `T1.1.c1` that repeats an obligation's ids ("duplicate state id T1_1_c1/...").
