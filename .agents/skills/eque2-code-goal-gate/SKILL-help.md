---
name: goal-gate-help
description: >
  Explain what the goal loop is doing right now — which workstream is
  running, which criteria are outstanding, who owns it, and why the
  session is or is not being blocked. Triggers on: "goal status", "what
  is the goal doing", "why can't I stop", "why is it not stopping",
  "explain the loop", "/goal-gate-help". Use when someone needs to
  understand the current loop rather than change it.
---

# What the loop is doing

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh status
```

Reports the gate directory, the workstream, its iteration, the goal folder
and criteria file, the last evaluation's met/outstanding counts, and which
conversation owns it.

## The mechanism, in four sentences

1. `prepare-goal` produces an `X.goal/` folder holding a charter and an
   `ACs.md` acceptance contract.
2. `pursue-goal <folder>` writes loop state binding that folder, then stops.
3. The gate runs at every turn end. While any criterion is outstanding it
   **refuses the stop**, so the session keeps working.
4. When every criterion is ticked **and evidenced**, it permits the stop and
   writes a completion record.

## Why a turn did not end

- **Criteria outstanding** — the ordinary case. Do the work.
- **A tick with no evidence** — refused. Ticks need a `- evidence:` line.
- **An evaluation that could not run** — refused, and reported as `not-run`.
  A check that did not run is never read as a pass.
- **No measurable progress** — a warning, not yet an ending. Nothing has been
  ticked or evidenced, and nothing has been committed or edited, for the
  threshold number of turns (8 by default). Change approach; the loop ends on
  its own at twice the threshold.

  Under a confirmed Codex Stop payload, each new progress state gets one
  single-use recovery token. The refusal gives Codex the exact
  `cancel.sh recovery-ack <token> <goal-folder>` command in the model-visible
  reason. A valid
  acknowledgment credits one accidental Stop. It changes no criterion,
  evidence, owner, iteration, status, or completion record.

  The lifetime raw Stop count remains intact. Progress resets only the active
  progress-period count. A reused, foreign, or expired token is rejected.
  Further unchanged Stops use the standard warning and terminal thresholds.
  New measurable progress creates one new token. Claude uses the same standard
  thresholds without the Codex acknowledgment.

  If unnecessary Codex yields or status-only turns consumed this counter, an
  operator can reset the active loop's accounting with
  `cancel.sh reset-stall` (or `reset-yield`). This resets the baseline only —
  no criterion, evidence, owner, iteration, status, or completion record
  changes — and it is recorded for audit. It is a recovery valve, not a reason
  to end turns while ordinary background work is pending: hard-wait or poll
  that work inside the active turn.
- **`LOOP_BLOCKED`** — a declared external blocker for the WHOLE run. Terminal,
  and it requires a written reason; without one it is refused. The signal file
  is keyed to its workstream: `<gate-dir>/<workstream>.LOOP_BLOCKED`. A bare
  `LOOP_BLOCKED` names no owner, so it is reported and honoured for nobody —
  one session's blocker must not end another session's loop.
- **A criterion you cannot meet is not a reason to keep going.** Mark it
  `- [!]` and give it an indented `- blocked: <reason>` line. A blocked
  criterion is neither met nor outstanding: it stops driving the nudge, and it
  never buys a pass. Use it only where the criterion GENUINELY cannot be met.

## Why a turn DID end, when the goal is not finished

The gate says so on screen whenever it lets a turn end for any reason other
than completion. If you saw nothing, nothing ended the loop.

- **`LOOP_PARTIAL`** — every criterion is either met and evidenced or explicitly
  blocked, and none is outstanding. The loop ends as a REPORTED NON-COMPLETION:
  no completion record is written, no criterion is marked met, and the report
  names each blocked criterion with its reason. This is the honest ending for
  work that cannot be finished — it is not a pass, and it is not a failure of
  the gate.
- **Stalled** — twice the threshold of turns with no measurable progress, or
  a loop oscillating between two states for a full window. Reported, not a
  pass: nothing is ticked and no completion record is written.
- **Recursion bound** — 50 iterations with the host's recursion flag set.
- **Not this conversation's loop** — the loop is owned by another conversation,
  so this one is not held to it. Common after resuming or restarting a session:
  the conversation identity changes and the new one is a stranger to the loop.
  Hand it over:

  ```bash
  bash {skills-root}/eque2-code-goal-gate/cancel.sh adopt
  ```

  The next turn end in this conversation picks the loop up. Nothing about the
  goal changes — outstanding criteria stay outstanding.

A loop that has ENDED, for any of those reasons or by completing, is finished:
no other conversation will adopt it, and `pursue-goal` starts a fresh one rather
than reviving it. Its state file is **renamed, never deleted** — from
`_ws-<conversation>.state` to `_ended-<conversation>-<token>.state` — so it stays
on disk for `cancel.sh status` and audit while being invisible to every
conversation looking for a loop to pick up. Its own owner can still reach it, so
adding an unmet criterion to a finished checklist still withdraws the pass.

## Ending it

`cancel.sh cancel` ends the loop as a **reported non-completion**. There is
no command that marks criteria met — that is what doing the work is for.
