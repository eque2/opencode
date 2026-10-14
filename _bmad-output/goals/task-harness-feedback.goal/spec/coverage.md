# Coverage Model: task-harness-feedback

## System Boundary Statement

Inside the boundary: the `/task` harness in `packages/opencode/src/task/` (the blend loader's `VERIFY.md` schema, the
run engine, the fact list, the live supervision actors, the Recorder, the status projection, the `/task` command,
the `Ops` seam and its `SessionPrompt` implementation), the `task-formats/blend/` example folders and README, the
demo seeding script, the conformance harness, and the TUI surfaces that show a run (`packages/tui/src/task-ui/`, the
session transcript header, the prompt footer and the sidebar Context panel).

Outside the boundary: model providers (a scripted model stands in), git hosting, the paused `task-harness` goal
(D27), the paid live check in `tmux` (D25) and the two merges into `dev` (D26). The goal loop runs those three steps,
not `[DS]`. The traceability table at the end maps each acceptance criterion to its scenarios and tasks.

Actors: the harness owner (types `/task`, `/task trust`, reads the TUI), the builder and verifier agents (child
sessions), the scripted model (tests), the opencode server process (one harness root, one lease per directory).

Data entities: facts (EventV2 `task.harness.fact`), the run snapshot (never persisted), `status.json`, spec folders
(`SPEC.md`, `TASK.md`, `VERIFY.md`, `acceptance/S<n>.md`), session messages (run header, refusal, busy reply,
closing summary), session cost and token data.

## Scenario Categories

| Category | Description | Priority |
|----------|-------------|----------|
| Build & Quality Gates | Type check, lint, build, both package test suites, conformance H1–H16, the state audit | high |
| Delivery & Environment Promotion | The demo seed copies every example folder; the phase-1 checkpoint keeps the gate green; the merges and live check are goal-loop steps | medium |
| Core Business Outcomes | One run machine with the cascade and the outcome rules; supervision actors; the status contract; refusals that list every failure; fault and live-check folders; the task-ui shows title, reasons, scenarios, durations, cost, the diamond and the summary | high |
| Negative Paths & Error Handling | Loader faults, cycles, unknown ids, missing `ensures`, subtree dependencies outside the run, mid-run invalid specs, worker failures, stalls, spend caps, rejected scenarios | high |
| Permissions & Access Control | One live run per directory; `/task trust` reaches only `outside` regions; hooks act only for a session's owner; run keys act only while the run is live and owned | medium |
| Data Integrity & Consistency | Pure fold, fold equals live actor, resume equals fold, store order equals fold order, atomic status writes, the shared status fixture | high |
| Auditability & Supportability | Every move in the history with its cause; reasons name the upstream task; the engine test classification list; the closing summary as a lasting record | medium |
| Operational Monitoring & Alertability | The heartbeat (`run.aliveAt`), liveness, the run warning toast, the Ticker toasts, logged touch failures | medium |
| Performance Expectations | Graph walks inside their 60 s timeouts with a measured `limit`; the feed and timers at their stated cadences | medium |
| Backwards Compatibility & Change Safety | Stored runs fold and resume; an older `status.json` still parses; shipped specs still load; conformance H1–H16 still pass; the phase-1 status keeps today's fields | high |
| Concurrency (optional) | Siblings ready in one step; independent timer regions; the Recorder permit; the directory claim | medium |
| Accessibility (optional) | Animations off gives a static diamond; glyphs differ in shape; full reasons reachable | low |

### Scenario Category Map

| # | Category | Why it matters for this feature | Min scenarios | Sources | Notes / assumptions |
|---|---|---|---|---|---|
| 1 | Build & Quality Gates | AC 29 is critical, and AC 7 needs the gate green at the phase-1 checkpoint | 6 | AC 29, AC 7, D9 | BUILD-1 to BUILD-4, BUILD-6, SV18 |
| 2 | Delivery & Environment Promotion | The live check needs every example folder in the demo seed (AC 17); AC 7, AC 27 and AC 28 are goal-loop steps | 2 | D15, D25, D26, plan.md | VF16, BUILD-6 |
| 3 | Core Business Outcomes | The observed stuck run (question 13) and every TUI question (6–12) | 30 | D1–D24, AD-1..AD-19, EXPERIENCE | RM, SV, VF, UI scenarios |
| 4 | Negative Paths & Error Handling | Question 5 asks for faults in every area; D10–D14 | 12 | D10–D14, AD-8, AD-11, AD-14 | VF1–VF14, SV6, SV10, SV11, RM12 |
| 5 | Permissions & Access Control | AD-19 (owner ruling 3), AD-8/AD-15 trust routing, AD-11 ownership, EXPERIENCE liveness gates | 7 | AD-8, AD-11, AD-15, AD-19 | SV8, SV13, SV20, SV21, VF7, UI3 |
| 6 | Data Integrity & Consistency | The fold is the only durable lifecycle; a mismatch between store, fold and file is silent corruption | 8 | AD-5, AD-6, AD-9, AD-13 | RM5, RM6, RM8a, RM8c, RM25, SV7, SV16, SV17, SV27 |
| 7 | Auditability & Supportability | D2 needs a named cause; owner ruling 2 needs a classification list; D18 is the lasting record | 4 | D2, D3, D18, owner ruling 2 | RM4, RM7, RM11, UI7 |
| 8 | Operational Monitoring & Alertability | A run whose server stopped must read as still (owner ruling 5); a broken spec must alert once; a done run's not-run line must not alert | 4 | AD-8, AD-13, AD-16, D12 | SV5, UI3, UI16, UI19 |
| 9 | Performance Expectations | The graph proof must finish inside `bun test`; the view machine reads at its stated cadences | 3 | AD-7, AD-16 | RM19, RM22 (60 s timeouts), UI2 (1 s, 2 s, 1.5 s, 500 ms) |
| 10 | Backwards Compatibility & Change Safety | Stored runs, older status files, shipped specs and H1–H16 must keep working; the checkpoint TUI must show a blocked task | 6 | AC 3, AD-6, AD-13, D11, AC 29, AC 7 | RM8a, RM8b, RM8c, SV17, VF3, BUILD-6, RM24, RM26, UI25 |
| 11 | Concurrency | Parallel siblings, parallel timer regions, a single writer per directory | 3 | D4, AD-8, AD-9, AD-19 | RM16, SV5, SV7 |
| 12 | Accessibility | EXPERIENCE "Accessibility Floor" | 3 | EXPERIENCE, D23 | UI14, UI18, UI22 |

## Assumptions

Epistemic assumptions. A scenario that rests on one carries the tag `@ASSUMPTION:A<n>.<letter>`.

- **A1 — the reach of "every reachable state" (D5, AD-7 [ASSUMPTION]); accepted by owner ruling 4.**
  - A1.a (adopted, owner ruling 4): every state reachable under the progress alphabet with the canonical
    interleaving, backed by a reduction check on a small plan (canonical walk equals the full walk, with and without
    the `blocked` rows), plus the structural totality check that runs inside the generator before any run (RM29).
    Coverage: RM19, RM20, RM21, RM22, RM29.
  - A1.b: the full interleaving of every plan. Rejected by the spine: the release-notes walk did not finish in 25
    minutes.
- **A2 — a run that stands still; decided by owner ruling 5 ("Show it as still").**
  - A2.a (the build rule): the diamond animates and live durations count only while `liveness` is `live`
    (`now - run.aliveAt <= 15 s`); `still` gives a static diamond and durations frozen at `run.aliveAt`.
    Coverage: UI12, UI4 (an open span runs to the heartbeat while still).
- **A3 — the rule of the D13 refusal line (AD-14 [ASSUMPTION]).**
  - A3.a (adopted): `R12 <run task's folder>: <task id> is after <other id>, which is outside this run and not
    trusted`. Coverage: VF6, VF14.
  - A3.b: a plain line with no rule. Coverage would change only the line's prefix.
- **A4 — the live-check plans at the phase-1 checkpoint (SD-4). Resolved by prepare-goal; no assumption remains.**
  The two live-check folders are built in phase 1 (T1.15), so the graph proof walks the loaded plans before the AC 7
  merge, and AC 6 holds as written. Coverage: RM20, VF15.

## Coverage Checklist

| Category | Min scenarios | Must include | Notes / assumptions |
|---|---|---|---|
| Build & Quality Gates | 6 | happy: BUILD-1, BUILD-2, BUILD-3, BUILD-4, BUILD-6; error: SV18 (the audit fails on a planted construct) | BUILD-6 runs at the end of phases 1 and 2 and at the end |
| Delivery & Environment Promotion | 2 | happy: VF16; edge: BUILD-6 at the phase-1 checkpoint | AC 7, AC 27, AC 28 run in the goal loop |
| Core Business Outcomes | 30 | happy: RM1, RM7, RM10, RM15, RM19, SV2, SV15, VF1, VF18, UI6, UI7, UI10, UI11, UI14, UI15, UI20, UI21; error: RM11, RM12, VF6, VF17; edge: RM13, RM14, RM16, RM17, RM27, SV24, UI4, UI5 | every D1–D24 has at least one scenario |
| Negative Paths & Error Handling | 12 | error: VF1, VF2, VF3, VF4, VF6, VF9, VF10, VF11, VF12, VF13, VF14, VF19, VF20, VF22, VF23, VF24, SV6, SV10, SV11, SV22, SV26, RM28, RM29, UI23; edge: VF5, RM2, RM6, SV23 | one scenario per fault folder |
| Permissions & Access Control | 7 | error: SV8 (busy), VF7 (trust cannot move an external region), VF21 (a typed trust never stands in for a folder task), SV13 (an unowned session records nothing); happy: SV20 (trust reaches the live run once), SV21 (the lease is released); edge: UI3 (keys inert when not live or not owned) | owner ruling 3 |
| Data Integrity & Consistency | 8 | happy: RM5, RM25, SV7, SV16, SV17; edge: RM6, RM8a, RM8c, SV25, SV27 | A run snapshot is never persisted |
| Auditability & Supportability | 4 | happy: RM4, RM7, RM11, UI7 | owner ruling 2 list |
| Operational Monitoring & Alertability | 4 | happy: SV5, UI16, UI24; edge: UI3, UI19 | owner ruling 5; UI19 follows AD-16 over EXPERIENCE |
| Performance Expectations | 3 | edge: RM19, RM22, UI2 | @ASSUMPTION:A1.a; 60 s per walk; view-machine cadences |
| Backwards Compatibility & Change Safety | 6 | happy: RM8a, RM8b, RM8c, SV17, VF3, BUILD-6, RM24, RM26, UI25 | stored slices without `path` are whole-spec slices |
| Concurrency | 3 | edge: RM16, SV5, SV7 | |
| Accessibility | 3 | edge: UI14 (animations off, not bold), UI18 (⊖ and ○ differ in shape), UI22 (every shared entry reachable by keys) | |

### Scenario inventory by prefix

- `BUILD-1` … `BUILD-4`: build checks.
- `BUILD-6`: conformance H1–H16 on the o2 arm (a build check run by command, not a scenario file).
- `DOC1`: the README "Validation" section.
- `RM1` … `RM29`, with `RM8a`, `RM8b` and `RM8c` in place of the old eighth scenario: the run machine (phase 1).
- `SV1` … `SV27`: live supervision, the Recorder, the status contract, the audit, trust routing, the lease (phase 2).
- `VF1` … `VF24`: validation, refusal forms, fault folders, live-check folders, the demo seed (phase 3).
- `UI1` … `UI25`: the task-ui, the run header, the closing summary, the run usage (phase 4).

## Acceptance traceability

AC numbers follow `../ACs.md` in order: AC 1–29 are approved, AC 30–46 are appended. AC 7, AC 27, AC 28 and AC 46 are
goal-loop steps (plan.md rows marked "none"): `[DS]` builds no task for them; their preconditions are listed.

| AC | Decision | Scenarios | Tasks |
|---|---|---|---|
| 1 | README Validation | DOC1 | T3.11 |
| 2 | D1 | RM1, RM2, RM3, RM4, RM5, RM6, RM23, RM28 | T1.1, T1.2, T1.6, T1.7, T1.8 |
| 3 | D2 | RM7, RM8a, RM8b, RM8c, RM9, RM24, RM25 | T1.3, T1.5, T1.6, T1.7, T1.11, T1.12, T2.11 |
| 4 | D3 (owner ruling 1, default 4, SD-18) | RM10, RM11, RM12, RM13, RM14, RM18, RM27 | T1.4, T1.7, T1.11 |
| 5 | D4 | RM15, RM16, RM17, RM18 | T1.3, T1.7, T1.11 |
| 6 | D5 (owner ruling 4) | RM19, RM20, RM21, RM22, RM29 | T1.3, T1.9, T1.10, T1.15, T3.8 |
| 7 | D26 checkpoint merge | goal loop; preconditions BUILD-6 and BUILD-1 to BUILD-4 green after T1.14, and RM26 (the checkpoint TUI shows a blocked task) | none (RM26 by T1.13) |
| 8 | D6 | SV1, SV2, SV3, SV4, SV5, SV6, SV7, SV8, SV9, SV20, SV21, SV22, SV25 | T2.4, T2.5, T2.8, T2.10, T2.11, T2.12 |
| 9 | D7 | SV10, SV11, SV12, SV13, SV14, SV23, SV24 | T2.6, T2.7, T2.8 |
| 10 | D8 | SV15, SV16, SV17, RM25 | T2.3, T2.4, T1.5 |
| 11 | D9 | SV18, SV19 | T2.1, T2.13, T4.13 |
| 12 | D10 | VF1, VF2, VF19, UI17 | T3.2, T3.4, T4.8 |
| 13 | D11 | VF3, VF13 | T3.1 |
| 14 | D12 | VF4, VF5, UI16 | T3.3, T4.4, T4.9 |
| 15 | D13 | VF6, VF7, VF8, VF20, VF21 | T3.4 |
| 16 | D14 | VF9, VF10, VF11, VF12, VF13, VF14 | T3.5, T3.6 |
| 17 | D15 | VF15, VF16, VF17, VF18 | T1.15, T3.7, T3.9, T3.10 |
| 18 | D16 | UI1, UI2, UI3, UI4, UI5, UI18, UI19, UI21, UI22 | T4.1, T4.2, T4.3, T4.6, T4.7, T4.4, T4.8 |
| 19 | D17 | UI6 | T4.10, T4.8 |
| 20 | D18 | UI7, UI8, UI20, UI23 | T4.11 |
| 21 | D19 | UI9 | T4.4, T4.5 |
| 22 | D20 | UI10 | T2.3, T4.4 |
| 23 | D21 (owner ruling 5) | UI11, UI12 | T4.2, T4.5, T4.6, T4.7 |
| 24 | D22 | UI13 | T4.9 |
| 25 | D23 (owner ruling 5) | UI14, UI12 | T4.9 |
| 26 | D24 | UI15 | T4.12 |
| 27 | D25 live check | goal loop; preconditions VF16, VF17, VF18, UI6, UI7, UI9, UI10, UI11, UI15 and the quality gate green, so no paid run is the first check to find a defect | none |
| 28 | D26 final merge | goal loop; precondition every other criterion met | none |
| 29 | Quality gate | BUILD-1, BUILD-2, BUILD-3, BUILD-4, BUILD-6 | T1.14, T2.14, T4.14 |
| 30 | Owner ruling 1: acceptance not proved | RM12, RM13, UI20 | T1.4, T1.7, T4.11 |
| 31 | Cancel or stop moves unfinished tasks and scenarios; AC 4 rule when a task died first | RM14, RM27 | T1.4, T1.7 |
| 32 | Fold, live and restored actor equal; a machine error is a defect | RM5, RM28 | T1.3, T1.6, T1.8 |
| 33 | One live run per directory; resume by the same path | SV3, SV8, SV21, RM8b | T1.11, T2.5, T2.11 |
| 34 | `/task trust` limits | SV20, VF7, VF21 | T2.5, T2.10, T2.11, T3.4 |
| 35 | The TUI decodes the shared fixture and an old status file | SV17, UI25 | T2.3, T4.2, T4.8 |
| 36 | Scripted live-check runs | VF17, VF18 | T3.9 |
| 37 | Summary written once; directory free once the run machine is final | UI8, UI23, UI24 | T2.10, T2.11, T4.11 |
| 38 | Harness error, task wall clock, a running tool is not a stall | SV6, SV22, SV23 | T2.8, T2.9, T2.10 |
| 39 | Structural totality check (owner ruling 4) | RM29, RM19, RM22 | T1.3, T1.10 |
| 40 | `run.aliveAt` heartbeat every 5 s; still display after 15 s (owner ruling 5) | SV5, UI3, UI12 | T2.4, T2.10, T4.1, T4.9 |
| 41 | An actor error never strands a run | SV26 | T2.4, T2.8, T2.10, T2.11 |
| 42 | A graceful stop leaves the run resumable | SV27 | T2.8, T2.9, T2.10, T2.11 |
| 43 | A spec with no task is refused | VF22 | T1.2, T3.2 |
| 44 | Conformance H1–H16 all run, none skipped, every change listed | BUILD-6 | T1.14, T2.14, T4.14 |
| 45 | The final allowlist holds only the AD-17 entries | SV19 | T2.13, T4.13 |
| 46 | `dev` tracks no `_bmad-output/` path after each merge | goal loop; checked before the AC 7 and AC 28 merges | none |

## Coverage Checklist (template items)

- [x] Happy path scenarios defined
- [x] Error/edge case scenarios defined
- [x] Integration boundaries identified
- [x] BUILD checks defined (lint, type-check, build, test)
