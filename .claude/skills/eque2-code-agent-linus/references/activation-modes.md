---
name: activation-modes
description: Default vs --interactive mode semantics for Linus's workflows
---

# Activation Modes

Linus runs workflows in one of two modes. The default is end-to-end; interactive is opt-in.

## Default Mode (End-to-End)

**Trigger:** No flag, or `--headless` / `-H` for explicitness. They have identical behaviour — `--headless` is just a label that signals to humans that no interaction is expected.

**Behaviour:** Workflows run from input to validated output with no checkpoint menus and no human-in-the-loop prompts. Auto-invocations fire at predetermined points (see each workflow's `SKILL.md` for specifics). The only hard stops are:

- Missing credentials or other blocker-severity pre-flight failures
- `cs-generate-definitions.py` returning `status: failed` after capped self-repair attempts (default 3)
- User cancellation
- Subagent stall — every background task is polled every 10 minutes; killed after two consecutive stalls (~20 minutes of no progress)

**When to use:** Default. Your owner invokes Linus to get an artifact, not a guided tour.

## Interactive Mode

**Trigger:** `--interactive` or `-i`.

**Behaviour:** Per-stage checkpoint menus. After each workflow stage emits its artifact, present:

```
[a] Advanced Elicitation  [c] Continue  [p] Party Mode
```

The user drives progression. Auto-invocations (Party Mode, edge-case-hunter, adversarial-general, checklist pass) are suppressed by default in interactive mode — they're available as menu choices at the appropriate stages instead. Adversarial Review additionally appears at the final stage:

```
[a] Advanced Elicitation  [r] Adversarial Review  [b] BUILD environment  [e] EXECUTE & Verify  [d] Done  [p] Party Mode
```

`[DS]` invokes the `eque2-code-develop-spec` skill. It handles worktree creation (offered in Stage 1), the full build-review-verify loop, and Figma compliance review when the spec references design data.

**When to use:** First run on a new project. Debugging an unexpected spec output. Training a new dev on the pipeline.

## First-Run Subagent Cost Warning

Default mode auto-invokes multiple subagents per [CS] run (Party Mode, edge-case-hunter, adversarial-general). This has a real cost — token usage, time, occasional API-side variance.

**On the first default-mode workflow of a session**, check MEMORY.md for a `subagent_warning_acknowledged_permanently: true` entry. If present, skip the warning entirely. Otherwise surface a one-line warning before kicking off:

> "Default mode will spin up subagents for Party Mode, edge-case-hunter, and adversarial review. Roughly 3-5 minutes and 30-80k tokens of subagent work per spec. Override with `--no-party`, `--no-edge-cases`, `--no-adversarial` if you want to trim. Continue? (Add 'don't show this again' to suppress permanently.)"

After the user confirms (or if `--yes` was passed), don't surface this again in the same session. If the user says anything equivalent to "don't show this again", write `subagent_warning_acknowledged_permanently: true` to MEMORY.md under an "Session Preferences" section — this suppresses the warning across all future sessions permanently.

In `--headless` mode, skip the warning entirely (it's running unsupervised by definition).

## Opt-Out Flags

Each auto-invocation can be disabled per-run:

| Flag | Disables |
|------|----------|
| `--no-party` | Auto-invocation of `bmad-party-mode` after scenarios stage |
| `--no-edge-cases` | Auto-invocation of `bmad-review` (edge-case-hunter lens) after tasks stage |
| `--no-adversarial` | Auto-invocation of `bmad-review` (adversarial lens) before state generation |
| `--no-checklist` | Auto-invocation of the `[CS]`-specific `checklist.md` pass |
| `--yolo` | Shorthand for `--no-party --no-edge-cases --no-adversarial --no-checklist` |

`--yolo` is the "I know what I'm doing, just produce the artifact" escape hatch. Discouraged for production specs.

## Headless ≠ Default

Both default and `--headless` mean the same thing operationally, but headless has stricter logging:

- Default mode: outputs progress to stdout, writes session log at end
- Headless mode: writes everything to session log; stdout is reserved for structured result JSON suitable for cron/CI consumption

This matters because cron-invoked headless runs feed parsers, not humans.

## Mode Detection

The activation routing in SKILL.md detects mode from argv. The flag check happens before pre-flight so that pre-flight knows whether to prompt or auto-bootstrap.
