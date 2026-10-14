---
title: "/task harness feedback — one run machine, supervision actors, validation folders and task-ui"
specSlug: "task-harness-feedback"
ticketType: feature
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
coverage_validated: true
edge_cases_researched: true
status: ready-for-build
created: "2026-10-14"
mode: "spec"
ticket_url: "none (spec mode)"
---

# Feature: /task harness feedback

## Problem Statement

The owner ran `/task` on `release-notes.spec` (`/Users/marknorgate/Projects/eque2/test`). T1.1–T1.3 became trusted,
T1.4 exhausted its budget after three attempts, and T1.5 (`after: [T1.3, T1.4, T9]`) and the parent T1 stayed in
WAITING for ever with no reason. Nothing could move them. The cause is structural: xstate decides only how one unit
moves on one fact; four per-unit machines (obligation, task, scenario, run) are joined by hand-written fold code;
dependencies live only in the runner's `schedule`; the run machine follows a dead task to a final state and strands
the rest; "run done" is a polled check (task-questions.md question 13).

The owner's requirement (2026-10-14): xstate holds every state, transition and state-reading decision of the
harness — no `MutableHashMap`, `Ref`, `let` counter, polled check or string list that encodes a lifecycle. The
durable run lifecycle stays a pure fold of stored facts; live process supervision becomes xstate actors whose
outcomes are recorded as facts.

The owner also asked twelve questions about what the harness checks and what the TUI shows (task-questions.md
questions 1–12): validation before execution and its completeness, how a failure appears, order and dependency
handling, graph checks, fault examples, scenarios in the TUI, a spec title in the run header, an explanation of the
outcome in the main body, token and cost indicators, the `/task-design switch` hint, per-task timings and an
animated diamond.

Affected: the harness owner and every user of `/task` in the opencode fork; the demos run on `dev`.

## Scope

**Exhaustive by default.** Everything the binding inputs imply is in scope. `tasks.md` orders the work in the plan's
four phases, so `[DS]` builds phase 1 first.

### In Scope

**Phase 1 — one run machine (D1–D5; AD-1..AD-7; the AD-20 seam).**
- `machine(plan)`: one generated machine per plan, parallel root (`active`, `outcome`), one region per task (evidence
  sub-regions per obligation plus `work`), scenario regions, outside regions; explicit ids, meta, closed tags; the
  generator dies on a duplicate id; fold-safe config (D1, AD-1).
- Final states per unit (AD-2); the `blocked` cascade and readiness rows, dependency tags, parked scenarios (D2, D4,
  AD-3); the outcome region driven by `active.onDone` through `run.settled`, the four outcome rules, stop rows (D3,
  AD-4, owner ruling 1, default 4); history, causes, times and spans written only by machine actions (AD-5).
- The engine API `initial`, `apply`, selectors and `view` over an opaque snapshot, memoised per plan; the four
  per-unit machines and the fold code removed (D1, AD-6).
- The two live-check folders `example-scenarios.spec` and `example-cascade.spec` (D15, with the parent T1 that R2
  needs), built in phase 1 so that the graph proof walks their loaded plans before the AC 7 merge (T1.15).
- External regions for folder tasks outside a subtree run (AD-15), so every generated guard names a state
  (context.md SD-7); a machine error is a defect, never a frozen run (SD-16).
- The structural totality check inside `machine(plan)` (owner ruling 4): every non-final unit state covers every
  final outcome of what it waits on, before any run (RM29).
- The engine tests rewritten as fact sequences with a classification list (owner ruling 2); the random fold test on
  snapshots with the AD-5 fold tests.
- The progress alphabet, the walk key and the graph proof with its negative control, reduction check and stale walk
  (D5, AD-7); the port conformance test (spine Stack).
- The phase-1 runner seam: snapshot, readiness by tags, end on `done`, no `checkDone`, no trust set (AD-20); the
  phase-1 status projection through `view` (AD-20); the conformance harness follows, and H1–H16 pass at the
  checkpoint (AC 29 at AC 7).

**Phase 2 — live supervision as actors (D6–D9; AD-8..AD-13, AD-17, AD-19).**
- The D9 audit first, with an allowlist that shrinks to the AD-17 entries (plan.md).
- New fact members `task.nudged` and the optional `path` on `run.started` / `run.resumed` (AD-10).
- The AD-13 status contract and the shared status fixture (D8).
- The Recorder and the status writer with the heartbeat (AD-9).
- The `TaskHarness` service: harness root actor, directory leases (one live run per directory, owner ruling 3),
  session index, trust forwarding (AD-8, AD-11, AD-19).
- Hooks routed by session to the owning supervisor (AD-11); stateless workers, the `sessionEvents` actor and the
  event-driven builder watch (D7); task, scenario and run supervisors (D6, AD-8); resume by the same path (AD-6).
- The command's check order, claim and release, busy reply and run scope (AD-19, AD-8).
- The polled runner removed; H1–H16 pass on the actors.
- An actor error ends its unit or run and never strands it (SV26); a server stop leaves the run resumable (SV27); the
  directory lease is released once the run machine is final (SD-19).

**Phase 3 — validation and fault folders (D10–D15; AC 1).**
- `ensures` required (D11); every loader failure in the refusal and in `run.reason` (D10, AD-14); a refusal while a
  run is live answers in the session only (AD-19).
- The `spec.checked` fact and the run warning for a spec that stops validating during a run (D12, AD-12).
- The subtree refusal with trust folded from stored slices, and the start-up trust of external regions; left-out
  scenarios named (D13, AD-15).
- Six fault folders, their command test and the graph walks of the ones that load (D14); a check that the two
  live-check folders still load once `ensures` is required, and their scripted end-to-end runs (D15, SD-11);
  `task-demo.sh` copies every `example-*.spec` folder.
- The README "Validation" section (AC 1), with the two rule stages (VF23); a spec with no task is refused (VF22);
  the D13 trust walk from the newest slice (VF24).

**Phase 4 — task UI (D16–D24; EXPERIENCE.md).**
- `@jambudipa/xstate-effect` in `packages/tui`; the `taskView` machine and the `fromActor` adapter; tag
  classification; liveness from the heartbeat (D16, AD-16).
- The run header from structured metadata, and `run.title` in the task-ui (D17).
- The closing summary through `Ops.say` (D18, AD-18).
- The shared region (run warning, outside wait, STOPPED list, SCENARIOS list) in every expanded view; the Peek
  BUILDER heading; reasons (D19); scenarios (D20); durations (D21); the `/task-design` hint removed (D22); the
  animated diamond (D23); run tokens and cost in the footer, the sidebar and the task-ui (D24).
- The final audit with `task-ui` in scope, and the task-ui README.
- The summary escapes model text (SD-20); the lease is free while the summary waits (UI24); an old status file is
  drawn with a defined fallback (UI25).

### Run by the goal loop, not by [DS]

These are in scope for the goal. They are goal-loop steps (plan.md stage rows marked "none"), not `[DS]` tasks, and
not out-of-scope carve-outs.

- **D26 / AC 7 — the phase-1 checkpoint merge** into `dev` with `git merge --no-ff` in the main checkout, after AC 2–6
  and the quality gate pass at the end of T1 (T1.14). No push.
- **D25 / AC 27 — the paid live check** in `tmux` on `example-scenarios.spec` and `example-cascade.spec`, after every
  scripted criterion and the quality gate pass. Spend cap: 4 live runs, re-runs included, and $5 in total.
- **D26 / AC 28 — the final merge** into `dev`, after every other criterion passes. No push.
- **D27 — a scope boundary.** This goal does not edit the paused `task-harness` goal or its criteria; that goal
  re-plans after this goal merges. It has no observable result here.

### Out of Scope

Only items that a binding input itself names out of scope:

- **Two opencode servers in one directory** — the spine (AD-19, Deferred) names it out of scope, and owner ruling 3
  accepted AD-19. Each server has its own lease; a lease file checked by process id is the later fix.
- **The root session's sidebar title** — EXPERIENCE "Deferred" names it out of scope (prepare-goal decision of
  2026-10-14): D17 names the first message only, and opencode's own session title stays as it is.

## Verification Intent

- **The observed bug cannot recur.** Folding the observed facts blocks T1.5 and T1 in the same fold step with the
  named cause (RM7); a graph walk of the release-notes plan and both live-check plans finds no stuck state, and its
  negative control finds the observed one (RM19–RM21).
- **No state lives outside xstate.** The audit fails on any forbidden construct and passes on the final tree with
  only the AD-17 allowlist (SV18, SV19); the runner, the session watch and the hooks hold no such state (SV1, SV14).
- **Supervision behaves as today, through actors.** Conformance H1–H16 pass (BUILD-6); the stall, spend cap, nudge,
  repetition, cancel, resume and failure rules hold (SV3–SV13).
- **Every fault is refused with every failure listed** (VF1, VF3, VF9–VF14); a subtree dependency outside the run is
  refused at the start (VF6); a mid-run invalid spec warns and keeps the plan (VF4, VF5).
- **The TUI shows what the owner asked for** — the title (UI6), reasons and blocked causes (UI1, UI9, UI18),
  scenarios (UI10), durations (UI11), the diamond (UI14), cost (UI15), the summary (UI7) — through scripted renders
  and scripted runs; the paid live check (AC 27) confirms it in the real TUI.
- **Evidence.** Every scenario test is `packages/opencode/test/task/verify-spec-<ID>.spec.ts`; the AC 2 evidence cites
  the classification list in the header of `engine-xstate.test.ts`. The quality gate is the build checks BUILD-1 to
  BUILD-4 and BUILD-6 (conformance), run at the end of phases 1 and 2 and on the final branch (T1.14, T2.14, T4.14).

## Owner rulings

The owner answered these on 2026-10-14 (asked by prepare-goal; recorded in `journal/2026-10-14-04-architecture.md`
and the spine's "Owner answers and defaults"). Each narrows an acceptance criterion as stated. Each test that rests on
a ruling names the ruling in its title.

1. **D3 and acceptance — owner: "failed".** When every task is trusted but a runnable scenario is `failed` or
   `rejected`, the run ends `failed`, reason `acceptance not proved: <id> <state>`. A parked scenario (it waits only
   on outside preconditions) adds `not run: <id> waits on <ids>`, and the run can still end `done`. This knowingly
   overrides the literal text of D3 and AC 4 ("the end state is done when every task is trusted"). Scenarios: RM12,
   RM13, UI20. Tasks: T1.4, T1.7, T4.11.
2. **AC 2 re-baselines — owner: "Rewrite, keep intent".** The stop-at-once, waiting-on-cancel and hand-built-State
   engine tests become fact sequences through the new API. Each keeps its intent; an expected outcome changes only
   where D2 or D3 changes it. A list in the header of `engine-xstate.test.ts` classes each old test as ported,
   re-baselined or retired, and the AC 2 evidence cites that list. This narrows AC 2 ("the existing engine tests pass
   on it"). Scenario: RM4. Task: T1.7.
3. **One live run per directory, resume by the same /task path (AD-19, AD-6) — owner: "Accept".** A second `/task`
   in a directory with a live run answers one busy line that names the live run's spec and path; a resume happens
   only when the latest slice is not ended and its path equals the new path. Scenarios: SV3, SV8, VF2. Tasks: T2.5,
   T2.11, T3.2.
4. **AC 6 and "every reachable state" — owner (2026-10-14): "it needs to be organised such that these states are
   structurally impossible to become stuck! A linting or pre-processing should yield errors. But also fixed order +
   check."** Two parts. (a) The canonical walk with the RM22 reduction check (`@ASSUMPTION:A1.a`) is the accepted
   reading of "every reachable state" in AC 6. (b) A structural totality check runs in phase 1, inside `machine(plan)`,
   before any run: each non-final unit state has a row for every combination of final states of what it waits on
   (all trusted → `ready`; any dead, blocked or cancelled → `blocked`, with its cause); no non-final state lacks a way
   out except a wait on an untrusted outside or external region that a fact moves; the outcome region can settle once
   every region is final. On a gap the generator dies with an error that names the unit, the state and the uncovered
   outcome. Scenarios: RM19, RM22, RM29. Tasks: T1.3, T1.10.
5. **A run that stands still — owner (2026-10-14): "Show it as still".** Prepare-goal default 6 becomes this ruling:
   the D23 diamond is static and the D21 live durations stop at `run.aliveAt` when the heartbeat is older than 15 s and
   the run has not ended (AD-13, AD-16; `@ASSUMPTION:A2.a` is the build rule). This narrows AC 23 and AC 25.
   Scenarios: UI12, UI3. Tasks: T4.1, T4.2, T4.5, T4.9.
6. **Scenario evidence under `bun test` — owner (2026-10-14): the log-proxy recipe is allowed.** The verifier runs
   `bun test --timeout=30000 --reporter=junit --reporter-outfile=<run dir>/junit.xml <file>` from the file's package
   (`packages/opencode` for every scenario here, so `./test/task/verify-spec-<ID>.spec.ts`), and a verifier-scratchpad
   adapter passes each JUnit result unchanged to the public Vitest hook `onTestRunEnd(files)` of
   `scenario-state-reporter.mjs`. The adapter spawns `bun` itself, writes the JUnit report to a fresh per-run path, and
   refuses a report for another file, a count mismatch, a green exit with no report, or a test file edited during the
   run; a non-zero exit sets the file-level result to fail (precedent: `log-proxy.goal/spec/journal/S6.md`). The
   reporter and the state CLI are not changed. Every scenario in `definitions.json` has `workingDirectory:
   "packages/opencode"`; `testFile` stays relative to the repository root, because the state CLI resolves it against
   the project root (context.md SD-21).

## Prepare-goal defaults

Defaults recorded by prepare-goal on 2026-10-14. They are not owner rulings; the owner may overrule each.

- **Default 4 — cancel of waiting work.** A cancel moves waiting and ready units to `cancelled`, because D3 needs
  every region final before the run ends (AD-4). Scenario RM14.
- **Default 5 — the D1 and D6 shapes.** `active` stays the parallel state, the outcome follows `active.onDone`
  through `run.settled`, and the workers run inside the run supervisor's tree (AD-1, AD-4, AD-8).
- Default 6 (a run that stands still) became owner ruling 5. Default 4 keeps its scope: a cancel moves unfinished
  tasks and scenarios to `cancelled`, and obligations keep their states (every obligation state is final, AD-2); the
  end state follows AC 4 when a task died before the stop (SD-18).

## Defects found in the inputs

Against decisions, spine or EXPERIENCE. None was built to where it contradicts a D<n>.

1. **AC 6 needs folders that the plan built in phase 3 (sequencing) — resolved by prepare-goal: folders built in
   phase 1, from the AC 6 and AC 7 text.** AC 6 names "both valid live-check plans", and AC 7 merges only after AC 2–6
   pass, but plan.md put D15's `example-scenarios.spec` and `example-cascade.spec` in phase 3, and AD-7 answered only
   with a hand-built cascade-shaped plan. Prepare-goal resolved it on 2026-10-14: T1.15 builds both folders in
   phase 1, and the graph proof (T1.10) walks the loaded plans, so AC 6 holds as written at the checkpoint. Phase 3
   keeps a check that both folders still load once `ensures` is required (T3.7). No owner choice remains.
2. **AD-19 narrows D10 / AC 12.** A refusal while another run is live in the directory answers in the session only
   and does not write `status.json` `run.reason`. Covered by owner ruling 3 (AD-19 accepted). Scenario VF2.
3. **Default 6 narrows D21 / AC 23 and D23 / AC 25** (AD-16, EXPERIENCE "In the Flow mark" and "Durations").
   Resolved by owner ruling 5 ("Show it as still").
4. **Owner ruling 1 overrides the literal D3 / AC 4 text**, and **owner ruling 2 narrows AC 2.** Both are recorded
   above, not defects to fix.
5. **EXPERIENCE contradicts AD-16 on the tone of a done run's "not run" line.** AD-16: a `done` run's reason line
   (for example `not run: S13 waits on T8`) uses the muted tone and the Ticker raises no notification for it.
   EXPERIENCE ("Component Patterns", "State Patterns") says `{theme.warning}`. The spine wins (precedence); this spec
   builds the muted tone (UI19).
6. **The order of the format-faults lines.** `Blend.load` stable-sorts failures by rule number, so
   `example-format-faults.spec` refuses with R1, R3, R4 in that order. D14 names the three rules; the EXPERIENCE mock
   and Flow 4 show R1, R4, R3, which this spec reads as illustrative. VF9 asserts the loader order.
7. **D15 and EXPERIENCE leave out the parent task the format requires.** R2 makes every top-level id `T<n>`, so the
   live-check folders hold T1.1–T1.3 under a parent T1 with a review obligation. In the cascade run T1 is blocked by
   T1.1 too, so EXPERIENCE Flow 2's "0/3 trusted" reads "1/4 trusted · 1 budget exhausted · 2 blocked". VF15, VF17,
   VF18 and T1.15 include T1.
8. **AD-12 moves the recording of `spec.checked` away from the stale-check actor.** D12 and AC 14 say "the stale-check
   actor records the failures as a fact"; AD-12 has the worker record nothing and the run supervisor record. The ACs
   outrank the spine, so the stale-check worker records `spec.checked` itself (T3.3); `obligation.stale` keeps the
   AD-12 path.
9. **AC 10 gives obligations a blocked cause.** An obligation has no dependency, so it never blocks; AD-13 gives it no
   `blockedBy`. The projection emits none, and SV15 states it.
10. **AD-4's rule order lets a stop outrank a task that died first; AC 4 does not.** AC 4: the end state is "the state
    of the task that died first". The approved AC outranks the spine (as in defect 8), so the outcome rules apply in
    this order: a dead task (with dead lines, blocked lines, then the stop's reason line), then a stop with no dead
    task (`cancelled` or the `run.ended` state), then acceptance (ruling 1), then `done` (SD-18). Default 4 keeps
    moving unfinished tasks and scenarios to `cancelled`. Scenarios: RM14, RM27, UI20.
11. **AD-19's finalizer order holds the directory while the summary waits.** The lease release is the run scope's first
    finalizer, so it runs after the summary, and a summary that waits on a root turn keeps every later `/task` busy.
    AC 33 frees the directory when the run ends, so the run supervisor releases the lease once the run machine is final
    and the writer has written the `done` snapshot, before the summary; the finalizer stays as an idempotent safety net
    (SD-19). Scenario UI24.
12. **AC 31 says a cancel moves obligations to `cancelled`.** Every obligation state is final (AD-2) and the status
    vocabulary has no cancelled obligation, so obligations keep their states and end with their task (RM14).

## Pending owner choices

None. Default 6 became owner ruling 5, and Defect 1 was resolved by prepare-goal.

## Risks for [DS]

- **Scenario evidence under `bun test` — resolved by owner ruling 6.** The verifier uses the log-proxy recipe (`bun test
  --timeout=30000 --reporter=junit --reporter-outfile=<run dir>/junit.xml ./test/task/verify-spec-<ID>.spec.ts` from
  `packages/opencode`, then a scratchpad adapter into the reporter's public `onTestRunEnd(files)` hook). UI scenario
  files run a nested `bun test` in `packages/tui` through the delegate helper, so give each an outer timeout of at
  least 120 s.
- **Phase-2 cut-over.** T2.6–T2.10 build the supervisors beside the polled runner; T2.11 is the single cut-over and
  T2.12 deletes the old code, so the typecheck and H1–H16 stay green at every task.
- **Two runs from one root session.** D24 and AD-18 define the run's sessions as the child sessions of the root, so two
  `/task` runs started from one root session sum their costs together. This follows the decision as written.

## Spec decisions recorded for the build

- **`DISPLAY` covers glyph, tone, Gantt block and Board column** (EXPERIENCE "Open Questions"; consistent with
  AD-16, "the only table keyed by state names in `task-ui` is the display table"). The AD-17 `DISPLAY` allowlist entry
  therefore covers all four fields, and the audit treats it as one presentation table (SV19).
- **An unloadable stored slice** (context.md SD-13): the D13 trust walk starts at the newest slice and stops at the
  first slice that loads and holds the folder task; a slice that does not load refuses the run only when it is newer
  than that deciding slice, with one plain line that names its path and ends "run the whole spec once to record a
  newer run" (VF24). Own judgment; the owner may overrule.
- **A status file with no tags** (SD-17): drawn with a defined fallback — liveness `still`, the muted line "status
  from an older harness — type /task to refresh", glyphs and labels from `DISPLAY`, no classification (UI25).
- **The outcome rule order** (SD-18, defect 10) and **the early lease release** (SD-19, defect 11).
- **Summary escaping** (SD-20): model text in the closing summary is escaped for CommonMark, so a reason shows as
  written (UI7).
- **Scenario working directory** (SD-21, owner ruling 6): `definitions.json` is the output of
  `cs-generate-definitions.py` followed by `python3 spec/scenario-workdir.py spec`, which sets each scenario's
  `workingDirectory` from its `testFile` package. Re-run both after any regeneration.
- **Run tokens** are input plus output plus reasoning tokens of every assistant message of the run's sessions; cache
  reads and writes are not counted, because the cost already prices them (EXPERIENCE "Assumptions"; AD-18 names the
  sum only).

## Source

### Spec mode
- **Input:** `../decisions.md` (prose input, D1–D27), with `../ACs.md`, `../plan.md`, `../task-questions.md`,
  `../architecture/ARCHITECTURE-SPINE.md`, `../ux/EXPERIENCE.md` and `../journal/2026-10-14-04-architecture.md`, all
  loaded in full.
- **Verification Intent:** as stated above; the acceptance traceability table is in `coverage.md`.

## Linked Artifacts

| Artifact | Path | Stage produced |
|----------|------|----------------|
| Technical context | `context.md` | 3 (refined by 4) |
| Coverage model | `coverage.md` | 5 |
| Gherkin scenarios | `scenarios.gherkin` | 6 (refined by Party Mode auto-invocation) |
| Implementation tasks | `tasks.md` | 7 (refined by edge-case-hunter auto-invocation) |
| Definitions | `definitions.json` | 10 |

## Notes

- Tests run only from package directories (`packages/opencode`, `packages/tui`); the root `bunfig.toml` blocks a
  root test run.
- The conformance guard fingerprints both spec trees, the seed and the suite: commit edits there before a conformance
  run.
- Do not edit `decisions.md`, `ACs.md`, `plan.md`, the spine or EXPERIENCE.md; they are hash-locked or approved.
