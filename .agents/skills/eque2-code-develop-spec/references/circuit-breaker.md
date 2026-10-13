# Subagent Circuit Breaker

When a Task subagent runs in the background, the parent receives no real-time feedback. If the subagent gets stuck — a command hangs, a CLI call never returns, or it enters a fix-retry loop — it silently consumes time with no way to signal distress.

## Before launching

Estimate expected duration based on action type:

| Action | Expected duration |
|--------|------------------|
| `build` | ~10–20 min |
| `review` | ~5–10 min |
| `verify` / `verify-scenario-trust` | ~5–15 min |
| `check` | ~2–5 min |
| figma-review | ~10–15 min |

Communicate the estimate: `"Spawning {action} for {task_id}. Expected ~{N} minutes."`

## Poll every 10 minutes

After launching a background Task, poll using `TaskOutput` every 10 minutes. Progress indicators:
- New files written or modified since last check
- New lines of output since last check
- Agent moved to a different phase of work
- A different tool/command running vs last poll

## Kill on stall

If **two consecutive polls** (~20 minutes) show no meaningful progress:

1. Stop the task (`TaskStop`)
2. Log what stage the subagent reached and what it was stuck on
3. Write `journal/{task_id}-circuit-breaker.md` with timestamp, last known state, and reason for kill
4. Route to `03-review.md` — do not retry the same task immediately

## Subagent prompt guardrails

Every Task prompt involving iterative work MUST carry the guardrails. Do not restate them here — read `references/guardrails.md` and point the subagent at it (paste verbatim under a `## Guardrails` heading, or instruct the subagent to read the file before acting). The integrity rules must reach the subagent intact.
