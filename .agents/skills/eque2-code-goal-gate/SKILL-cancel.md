---
name: goal-gate-cancel
description: >
  Cancel an active goal loop — stop the stop-gate from blocking further
  turns for this workstream. Triggers on: "cancel the goal", "cancel
  goal", "stop the loop", "cancel the loop", "abort the goal",
  "/goal-gate-cancel". Use when a run started by pursue-goal must be
  ended before its acceptance criteria are met. Do NOT use to mark work
  complete — cancelling is a reported end, never a completion.
---

# Cancel a goal loop

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh cancel
```

**Cancelling is not finishing.** The loop's unmet criteria stay unmet, no
completion record is written, and nothing in the goal folder is ticked.
Say so when you report it — "cancelled" and "done" are the two things this
whole mechanism exists to keep apart.

| Exit | Meaning | What you do |
|---|---|---|
| `0` | cancelled | Report it, and say how many criteria remain outstanding |
| `1` | no active loop | Say so. Do not treat it as a successful cancel — you may simply be in the wrong directory |
| `3` | the loop belongs to another conversation | Report the owner. Only re-run with `--force` if the user explicitly wants someone else's in-flight run ended |
| `5` | filesystem failure | Report it |

Cancelling does not delete the goal folder or its criteria. The same folder
can be started again with `pursue-goal <folder>`.

Cancelling does not delete the loop's state file either. A loop that ends —
cancelled, complete, stalled, blocked or partial — is **renamed** to
`_ended-<conversation>-<token>.state` inside the gate directory, so it stays
readable by `cancel.sh status` while no longer being a run any conversation can
pick up. Report the end, never the file.

## Acknowledging one accidental Codex Stop

When the Stop refusal gives an exact `recovery-ack` command, run that command
before work continues:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh recovery-ack <token> <goal-folder>
```

The command credits one accidental Stop for the current progress state. It
keeps the lifetime raw Stop history. It changes no goal evidence or completion
state.
Exit 4 means the token is used, foreign, or expired. Do not replace this
single-use acknowledgment with a routine `reset-stall` command.

## Resetting excess-yield accounting without cancelling

When an active loop's stall counter was consumed by unnecessary Codex turn
endings, reset that counter — and only that counter — with:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh reset-stall
```

`reset-yield` is an alias. The reset is recorded and leaves the loop active:
criteria, evidence, ownership, iteration, status, and completion state are
unchanged. It refuses to revive a terminal loop. If ownership cannot be
established, use `--force` only when the user has explicitly requested the
reset. Prefer hard waits or polling inside the current turn for ordinary
background work; resetting is recovery, not a timer.

**Never cancel to escape a criterion you are finding hard.** If the blocker is
genuinely external, say so where it is recorded rather than cancelling:

- one criterion — mark it `- [!]` in `ACs.md` with an indented
  `- blocked: <reason>` line;
- the whole run — write the reason into
  `<gate-dir>/<workstream>.LOOP_BLOCKED` (keyed to the workstream, so it ends
  that loop and no other; a bare `LOOP_BLOCKED` is reported, not honoured).

Either way a signal with no reason is refused, not honoured, and neither marks
anything met. `cancel.sh status` reports the met, outstanding and blocked
counts, and names each blocked criterion with its reason — including after the
loop has ended, which is when anyone actually asks.
