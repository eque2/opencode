---
name: activation-modes
description: Default vs --interactive mode semantics for Grace's workflows
---

# Activation Modes

Grace runs workflows in one of two modes. The default is end-to-end; interactive is opt-in.

## Default Mode (End-to-End)

**Trigger:** No flag, or `--headless` / `-H` for explicitness. They have identical behaviour — `--headless` is just a label that signals to humans that no interaction is expected.

**Behaviour:** Workflows run from input to verified output with no checkpoint menus and no human-in-the-loop prompts. A [BK] run seeds, fans out, polls, parks, and reports without asking. The only hard stops are:

- Missing credentials or other blocker-severity pre-flight failures (including the Pre-[BK] Viability Gate — Xray credentials, topology, tests CLI)
- **The Xray gate** — a test whose definition is missing or has zero steps HARD STOPS for that test (recorded blocked, never generated); in a batch the remaining tests continue
- The tests CLI becoming unresolvable mid-batch — [BK] cannot verify honestly without it
- `max_parked_tasks` reached with nothing progressing — [BK] stops dispatching and surfaces the situation rather than burying it
- User cancellation
- Subagent stall — every background task is polled every 10 minutes; killed after two consecutive stalls (~20 minutes of no progress), and in [BK] the test is parked via the tests CLI

**When to use:** Default. Your owner invokes Grace to clear a backlog, not to take a guided tour of one.

## Interactive Mode

**Trigger:** `--interactive` or `-i`.

**Behaviour:** Checkpoints at the workflow's natural seams. For a single build ([BT]) that's per-stage — after explore, after implement, after verify — each pausing with:

```
[a] Advanced Elicitation  [c] Continue
```

For a batch ([BK]) the checkpoints sit at the orchestration level, not inside each subagent (a paused subagent is a stalled subagent): confirm the seeding plan before fan-out, pause between dispatch waves, and stop for a decision at each parking/remediation call instead of applying the default policy. The final report additionally offers:

```
[r] Review parked tests  [s] Sync to Xray ([US])  [d] Done
```

**When to use:** First run on a new topology. Debugging an unexpected verifier bounce. Training a new dev on the pipeline. Working a folder whose definitions you don't yet trust.

## First-Run Subagent Cost Warning

Default-mode [BK] fans out real subagents — up to `{agent.batch_concurrency}` at a time, each running the full E2E pipeline (live browser exploration against `BASE_URL`, build, server-side verify) for its test, with the parent polling until the folder is done. This has a real cost — token usage scales with folder size, wall-clock time runs to hours for large folders, and the browser traffic lands on a real environment.

**On the first default-mode workflow of a session**, check MEMORY.md for a `subagent_warning_acknowledged_permanently: true` entry. If present, skip the warning entirely. Otherwise surface a one-line warning before kicking off:

> "A backfill dispatches up to {agent.batch_concurrency} build subagents at a time, each exploring the live UI and building its test — for this folder that's roughly {N} tests, so expect substantial token usage and up to {batch_timeout_minutes} minutes per test before time-out. Tune `batch_concurrency` / `engine_depth_default` in customize.toml if you want to trim. Continue? (Add 'don't show this again' to suppress permanently.)"

Scale the framing to the invocation — a single [BT] warrants one quiet line about its pipeline cost, not the batch speech.

After the user confirms (or if `--yes` was passed), don't surface this again in the same session. If the user says anything equivalent to "don't show this again", write `subagent_warning_acknowledged_permanently: true` to MEMORY.md under a "Session Preferences" section — this suppresses the warning across all future sessions permanently.

In `--headless` mode, skip the warning entirely (it's running unsupervised by definition).

## Tuning Levers

Grace's cost/depth knobs live as scalars in `customize.toml` (overridable per the standard team/user merge) rather than per-run flags:

| Scalar | Governs |
|--------|---------|
| `engine_depth_default` | `core` (essential blocks + verify/fix) vs `full` (all Strategy 6 blocks incl. resilience audit + parallel healer) — per-run override on request |
| `batch_concurrency` | Parallel build subagents [BK] dispatches at a time |
| `batch_poll_interval_minutes` | Parent-loop polling cadence (`node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs transitions-since`) |
| `batch_timeout_minutes` | Per-test time-out before the parent parks it |
| `max_parked_tasks` | Parked-test ceiling before [BK] stops dispatching |

These defaults deliberately agree with the repo-global Subagent Circuit Breaker rules (`.claude/CLAUDE.md`) — raise them only with a matching change there. There is no `--yolo` here: the Xray gate and server-side verification are constitutional (Hard Rules), not auto-invocations you can switch off.

## Headless ≠ Default

Both default and `--headless` mean the same thing operationally, but headless has stricter logging:

- Default mode: outputs progress to stdout, writes session log at end
- Headless mode: writes everything to session log; stdout is reserved for structured result JSON suitable for cron/CI consumption

This matters because cron-invoked headless runs feed parsers, not humans — and a long-running [BK] under cron is exactly where narrative-on-stdout breaks consumers.

## Mode Detection

The activation routing in SKILL.md detects mode from argv. The flag check happens before pre-flight so that pre-flight knows whether to prompt or halt with structured JSON.
