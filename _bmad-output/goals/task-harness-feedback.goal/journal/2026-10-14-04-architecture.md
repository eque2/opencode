# Phase B — bmad-architecture (headless)

- Output: [`../architecture/ARCHITECTURE-SPINE.md`](../architecture/ARCHITECTURE-SPINE.md), AD-1..AD-20, memlog,
  four review lenses in `../architecture/reviews/` (rubric, reality-check, adversary, statechart).
- Status: partial — lint clean, port probes confirmed the key claims; no conflict with a D<n>.
- Owner answers, 2026-10-14 (asked by prepare-goal):
  - Q1 D3 and acceptance: "failed" — every task trusted but a runnable scenario failed or rejected ends `failed`
    ("acceptance not proved"); a parked scenario does not fail the run. Keeps today's `checkDone` rule.
  - Q2 AC 2 re-baselines: "Rewrite, keep intent" — the stop-at-once, waiting-on-cancel and hand-built-State engine
    tests become fact sequences; each keeps its intent; the AC 2 evidence lists each rewritten test.
  - Q4 one live run per directory and resume by path (AD-19, AD-6): "Accept".
- prepare-goal defaults: Q3 a cancel moves waiting and ready units to `cancelled` (D3 needs every region final);
  Q5 the D1/D6 shapes meet the decisions; Q6 the diamond and live durations stop when no live harness job owns the
  run.
- The spine asked for UX revisions (Gantt from `spans`, refusal layout, Board column from tags, no `/task trust`
  hint for an external dependency). Both documents were updated in a second pass.
- Second pass applied the answers: AD-4 rule 3 (failed on a failed or rejected runnable scenario), AD-6 (engine
  tests ported, re-baselined or retired, listed in the test file header), AD-8 (parallel run supervisor with
  heartbeat, wall-clock and stale timer regions), AD-13 (`run.aliveAt`, epoch ms of the last status write; live
  while not ended and within 15 s), AD-19 (`run.claim`/`run.release`, busy reply names the live run). One adversary
  lens on the changed ADs: 2 critical, 3 high, 9 medium, all fixed; lint clean.
- Pending ruling (default 6): a stopped server makes the diamond static and freezes durations — narrows D23 and D21.
  Built as stated unless the owner overrules.
- Deferred: two opencode servers in one directory.
- The spine requires `[CS]` to write an "Owner rulings" section into the SPEC.
