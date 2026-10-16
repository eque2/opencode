# RM1 verify-scenario-trust transcript (2026-10-16 11:40 UTC)

Fresh-context semantic verifier, spawned directly by the orchestrator. Outcome: **trusted**.

## What I read
- Dispatch prompt: scratchpad/prompts/scenario-RM1-verify-scenario-trust.md.
- references/guardrails.md and semantic-verify-scenario/SKILL.md (eque2-code-develop-spec).
- journal/scenario/RM1.md (the earlier verify run: adapter built, Layer 1+2 passed, state completed/verified).
- packages/opencode/test/task/verify-spec-RM1.spec.ts (committed 22914da6dc; no diff at HEAD 693b687da0).
- scenarios.gherkin RM1; spec.md scope; tasks.md T1.2 and T1.6 (Supports RM1).
- ARCHITECTURE-SPINE.md AD-1, AD-2, AD-3, AD-4, AD-13.
- Code under test (read only): test/task/lib/machine.ts `loadPlan` (real Blend.load + TaskCommand.plan);
  src/task/engine-xstate/machine.ts `config`, `mapStates`, `check`, `fromConfig`, `machine` (WeakMap memo);
  src/task/engine-xstate/index.ts `initial` (initialTransition of `TaskMachine.machine(plan)`).

## Gherkin steps and the assertions that cover them
1. Given the release-notes plan: the real loader output is pinned: tasks [T1, T1.1..T1.5], scenarios S1..S13,
   outside [T8, T9], external [].
2. When the engine generates the run machine: `TaskMachine.machine(plan)` is the same object on a second call;
   every node in `TaskEngineXState.initial(plan)._nodes` belongs to that machine's root; the plain-data config ids
   equal the built machine's ids.
3. Then the root is parallel with active and outcome: `root.type` parallel; keys exactly [active, outcome];
   active parallel; outcome compound with exactly the 7 AD-4 run states, meta kind run.
4. And active order: keys equal tasks in plan order + scenarios in natural order + outside, both derived and as a
   literal list; S2 before S10; each region's first state has the right meta unit and kind.
5. And task regions: each task region parallel, keys exactly [evidence, work]; evidence parallel with one
   sub-region per obligation in plan order (T1.4 literal c1..c8, p1, f1, f2); each obligation region has exactly
   the 6 AD-2 states; work compound with exactly the 12 AD-2 task states; obligation coverage count matches.
6. And every unit state: leaf count equals the AD-2 total and every leaf is a unit state; the gap checker
   (explicit unique id `<unit_>/<state>`, meta exactly {unit, kind, state} with the AD-13 status name, an own
   class tag, tags only own class/phase or `<dependant>:waits:<unit>`, no tags on non-unit nodes) returns [];
   `getStateNodeById` resolves each id to the same node; a negative control on an edited config makes the
   checker name all four injected gaps exactly; the snapshot's tags are a subset of the unit tags.

Gaps: none that block trust. Notes: external kind is out of this plan (machine.test.ts covers it); per-state
class-tag correctness is not checked (not asked by this step).

## Commands and results
- `state.mjs <spec> query scenario/RM1` -> completed, trustLevel verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad>/trust-runs/RM1/20261016T113856Z/junit.xml ./test/task/verify-spec-RM1.spec.ts`
  (cwd packages/opencode) -> exit 0, 5 pass, 0 fail, 1360 expect() calls, 5.82 s.
- `git diff --stat HEAD -- <test file, src/task, test/task/lib>` -> empty.
- `state.mjs <spec> verdict RM1 trusted --reason "..."` -> {"verdict":"trusted","trustLevel":"trusted"}.
- `state.mjs <spec> query scenario/RM1` -> completed, trusted.

## Outcome
RM1 trusted. No source or test file changed. Nothing committed. No evidence or key file read.
