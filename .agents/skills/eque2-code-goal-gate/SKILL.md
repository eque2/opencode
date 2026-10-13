---
name: eque2-code-goal-gate
description: >
  Inspect or end a running goal loop — report what the stop gate is
  doing, why a turn is not ending, and cancel the run if asked.
  Triggers on: "goal status", "what is the goal doing", "why can't I
  stop", "why is it not stopping", "explain the loop", "cancel the
  goal", "cancel the loop", "stop the loop", "abort the goal",
  "/eque2-code-goal-gate". Use for a loop that is ALREADY running. Do NOT use to
  create a goal folder (that is prepare-goal) or to start one (that is
  pursue-goal).
---

# goal-gate — the running loop

`prepare-goal` makes a planned folder. The direct inline bootstrap in
`pursue-goal` can make a direct contract. `pursue-goal` always starts the run.
This skill is for the run **while it is happening**: explaining it, and ending it.

## What is it doing?

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh status
```

Reports the workstream, its iteration, the goal folder and criteria file, the
met/outstanding counts from the last evaluation, the recent decisions from the
run log, the stall counter, and which conversation owns it. Exit 1 means no
loop is running here — relay that rather than treating it as a healthy report;
the commonest cause is being in the wrong directory.

Full explanation of the mechanism, and the list of reasons a turn does not
end: `SKILL-help.md`.

## Cancel it

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh cancel
```

**Cancelling is not finishing.** The unmet criteria stay unmet, no completion
record is written, and nothing is ticked. Say so when you report it — keeping
"we stopped" and "we finished" apart is the entire point of this mechanism.

| Exit | Meaning | What you do |
|---|---|---|
| `0` | cancelled | Report it, and how many criteria remain outstanding |
| `1` | no active loop | Say so; do not report a successful cancel |
| `3` | the loop belongs to another conversation, or ownership cannot be established | Report the owner. Only add `--force` if the user explicitly means to end someone else's run |
| `5` | filesystem failure | Report it |

Details and the full refusal rationale: `SKILL-cancel.md`.

## "The loop stopped running and nothing is happening"

Almost always the conversation changed identity — a resumed or restarted session
is a stranger to the loop it started, so the gate holds nobody and the goal sits
still. `cancel.sh status` shows the loop claimed by a conversation that is not
this one. Hand it over:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh adopt
```

The loop becomes unclaimed and **this** conversation claims it at its next turn
end. Nothing about the goal changes: outstanding criteria stay outstanding, no
completion is recorded, and the iteration history is kept. The state file is
renamed to `_ws-<this conversation>.state` on the turn it is picked up — the
name always says who holds it now.

Adopting is refused for a loop that has ENDED (complete, cancelled, stalled,
blocked) — that is history, not a run to take over. An ended loop is renamed to
`_ended-<conversation>-<token>.state` and kept on disk for `cancel.sh status`
and audit; no conversation will ever adopt it. Start a new one with
`pursue-goal`.

## Acknowledge an accidental Codex Stop

The Codex Stop refusal can contain an exact command like this:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh recovery-ack <token> <goal-folder>
```

Run only the command from the newest refusal. The token grants one recovery
credit for one unchanged progress state. It does not reset the lifetime raw
Stop count. The active progress-period count controls the stall threshold.
It changes no criterion, evidence, owner, iteration, status, or completion
record. A reused, foreign, or expired token exits with code 4.

The credit prevents one accidental turn ending from causing a false stall. It
does not permit repeated Stops. Further unchanged Stops use the standard
warning and terminal thresholds. Measurable progress creates one new token.

## Reset excess-yield stall accounting

The counter shown by `status` is the gate's **stall counter**: consecutive
identical turn-end evaluations. If needless Codex yields or status-only turns
have consumed it, reset that accounting without weakening the goal contract:

```bash
bash {skills-root}/eque2-code-goal-gate/cancel.sh reset-stall
```

`reset-yield` is an alias. The command clears only the repetition baseline and
sets the counter to zero; it does not change the criterion checklist, evidence,
owner, iteration, status, or completion record. It works only for an active
loop and records when the reset occurred. If the command cannot establish that
the active loop belongs to this conversation, it refuses unless the user has
explicitly directed `--force`.

This is a recovery valve, not a normal waiting pattern: keep the turn open and
hard-wait or poll background work rather than repeatedly ending turns.

## What this skill will not do

- **It will not mark a criterion met.** There is no such command. Ticking a box
  is what doing the work earns, and the tick must carry its `- evidence:` line
  or the gate refuses it.
- **It will not edit the gate's state files** to end or advance a loop. That
  corrupts the loop's account of itself and produces a false record of
  completion — the one failure this whole mechanism exists to prevent.
- **It will not unregister the gate** to get a turn to end.
- **It will not create a direct goal contract.** The direct bootstrap belongs to
  `pursue-goal`; it validates the charter and criteria, then calls the starter.
  This gate skill still never writes a loop state on its behalf.

If the blocker is genuinely external, there are two honest signals, and they
answer different questions.

- **One criterion cannot be met** — mark that criterion `- [!]` in `ACs.md` and
  give it an indented `- blocked: <reason>` line. It is then neither met nor
  outstanding: it stops driving the turn-end nudge, and it never counts towards
  a pass. When nothing is left outstanding and something is blocked, the run
  ends as `LOOP_PARTIAL` — a reported non-completion that names every blocked
  criterion and its reason.
- **The whole run is blocked** — write the reason into
  `<gate-dir>/<workstream>.LOOP_BLOCKED`. The file is KEYED to its workstream so
  it ends that loop and no other; a bare `LOOP_BLOCKED` names no owner and is
  reported rather than honoured.

Both refuse a signal carrying no reason. Neither is a pass, and neither marks
any criterion met — blocking a criterion you could still finish only records
that you did not finish it.
