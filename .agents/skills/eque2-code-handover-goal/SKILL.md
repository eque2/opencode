---
name: eque2-code-handover-goal
description: Captures and resumes goal handovers. Use when the user says "hand over this goal", "create a goal handover", "resume the handover", invokes `/eque2-code-handover-goal`, or refers to `X.goal/handover.md`.
---

# Handover Goal — Hannibal stage 3 continuation

> **`{skills-root}` token** — like `{project-root}`, a literal token: the active runtime's installed skills root. Resolve it to `{project-root}/.claude/skills` in Claude Code or `{project-root}/.agents/skills` in Codex. Do not select a runtime from folder presence. Substitute the resolved absolute path before running any command — never pass the literal token to a shell.

## Overview

This top-level workflow lets a developer interrupt an active
`eque2-code-pursue-goal` run before its context is exhausted. It writes
`handover.md` in that goal's `_bmad-output/goals/<slug>.goal/` folder.
A fresh context starts the resume path by referring to the document
alone, then revalidates the canonical goal before it works.

`goal.md`, `ACs.md`, and goal-gate state remain authoritative. The
handover is a current briefing. It does not approve work, evidence a
criterion, or change the gate state.

## On Activation

Load `{project-root}/_bmad/config.yaml` and `config.user.yaml`. Use
`{communication_language}` for the conversation and
`{document_output_language}` for the handover. A `handover.md` input
selects resume mode. Any other goal input selects create mode.

## Create the handover

Accept an `X.goal/` folder, a file inside it, or Hannibal's `[HO]`.
Resolve a moved goal to its worktree before reading or writing. A
`.moved` stub or a main-checkout ghost must switch to its recorded
canonical worktree. If the worktree is unavailable, report the path and
tell the developer whether to restore or abandon it. Stop.
If no goal identifies the active loop, ask for its exact folder. Do not
select a goal by inference.

Run the goal-gate status command from that worktree:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh status
```

The command must report an active loop for this goal. Otherwise, report
the status and stop. A handover cannot recreate a completed, cancelled,
blocked, stale, or unknown run.

Write or replace `X.goal/handover.md`. The document must contain YAML
frontmatter with its canonical absolute `goal_folder`, `worktree`,
`written_at`, and observed `gate_status`. It must also contain these
sections:

- `Canonical work` — the authoritative paths for `goal.md` and `ACs.md`;
- `Goal state` — objective plus exact met, outstanding, and blocked criteria;
- `Work completed` — relevant changes, commands, tests, and results;
- `Decisions and risks` — confirmed decisions, failures, dependencies, and assumptions;
- `Continuity gaps` — unknown facts, unverified results, and mandatory rechecks;
- `Next action` — the single next action and any required developer input;
- `Resume` — instruct a fresh context to refer to this `handover.md` path.

Use the current conversation and canonical goal files. Separate facts
from assumptions. Replace stale text instead of appending history.
Verify that the recorded goal folder is the document's parent and that
its authoritative paths exist. Report the document path, then let the
developer start a fresh context. Include the observed goal state, next
action, open risks, and handover time in that receipt. Do not adopt,
cancel, restart, or complete the loop in the interrupted context.

## Resume the handover

Any reference to `X.goal/handover.md` invokes this mode. Resolve the
document's parent goal folder first. Apply the moved-goal and
main-checkout-ghost rules before reading the document, then enter the
canonical worktree. Read the handover and verify its `goal_folder` and
`worktree` fields against the resolved locations. Then read `goal.md`,
`ACs.md`, the working-tree status, and the goal-gate status. The
charter and criteria override the handover if they differ. Report a
conflict and refresh the handover before continuing.

For an active loop, run exactly:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh adopt
```

On exit `0`, report that the fresh context adopts the loop at its next
turn end. End this one transfer turn. The gate then binds the fresh
context with its real identity. Do not call `pursue-goal.sh`, and do
not create another loop.

If no active loop exists, invoke `eque2-code-pursue-goal` with the
canonical goal folder. That workflow validates the prepared folder and
starts a new loop only when it is safe. For any terminal, stale, or
unreadable state, report the result and stop.

## Safety boundary

Do not edit `ACs.md` to make a handover look complete. Do not edit
goal-gate state. Do not use the handover to bypass a stopped, blocked,
or failed gate. The document transfers context; it does not change the
workstream contract.
