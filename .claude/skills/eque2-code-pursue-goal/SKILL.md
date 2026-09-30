---
name: eque2-code-pursue-goal
description: >
  Pursue a goal under the stop gate. A prepared `X.goal/` folder starts
  stage 3. An explicit inline request, “pursue the goal of <task>”,
  creates a direct acceptance contract in the current checkout, then
  starts the same gate. The gate refuses to let the run end until every
  acceptance criterion is met AND evidenced. **Triggers on ANY reference to a path ending in
  `.goal` (or a file inside one — `X.goal/goal.md`, `X.goal/ACs.md`),
  except `X.goal/handover.md`**. A handover document invokes
  `eque2-code-handover-goal`, which resumes the active loop safely.
  however the user phrases it: naming it, pasting it, attaching it,
  "look at X.goal", "here's the goal folder", or a bare path. Referring
  to a prepared goal folder IS the request to pursue it — there is
  nothing else one does with a `.goal` folder. Also triggers on:
  "pursue goal", "pursue-goal", "execute goal", "run the goal", "start
  the goal", "pursue the goal of <task>", "/eque2-code-pursue-goal", or
  Hannibal's [PU]/[DI]. Do NOT use the direct form to plan or prepare a
  separate goal.
---

# Pursue-Goal

The normal path is Hannibal stage 3: stage 1 planned and stage 2 prepared.
**This skill starts the work.** It also owns one deliberate shortcut: an
explicit inline goal creates the same charter and acceptance contract without
the plan, approval, worktree, or fresh-context ceremony.

Given a prepared `X.goal/`, it reads `goal.md` (the charter) and
`ACs.md` (the acceptance contract) as its instructions, writes the loop
state that binds the stop gate to that folder, and then **stops**, so
the gate takes over and blocks every turn end until the criteria are
met and evidenced.

## The one thing to get right

**Write the state, then end exactly one bootstrap turn. Do nothing else
in that turn.**

The gate is passive: it runs at the end of every turn and does nothing
unless it finds loop state to claim. The state file is written
*unclaimed*; the gate claims it on the next turn end and only then
starts blocking. Continuing to work in the same turn leaves the loop
unbound — you would be doing the work with nothing gating the stop,
which looks exactly like the real mechanism and is not it.

That bootstrap end is the **only intentional yield** in this workflow.
It starts the gate; it is not permission to keep ending turns while the
goal is active.

## Direct inline bootstrap

Use this route only when the user says **“pursue the goal of <task>”** and
`<task>` is a clear, single outcome. A generic bare task still starts at
Hannibal's `[PL]`; a `.goal` path still uses the prepared-goal route below.
Do not reinterpret an ambiguous sentence as a direct goal.

The direct route optimizes the interaction, not the integrity bar. It creates
the contract that planning and preparation would have produced, then delegates
all hook checks, locking, and loop-state creation to `pursue-goal.sh`. It does
not call a host agent's built-in goal command.

1. **Preflight before writing.** Resolve the repository root with
   `git rev-parse --show-toplevel`. Use that root as the current checkout.
   Never derive the goal location from a subdirectory. Inspect the checkout and
   the requested task. Derive a short, unique kebab-case slug. If the task has
   more than one independent outcome, cannot name its specified system, or
   produces a slug collision under `<checkout>/_bmad-output/goals/<slug>.goal/`,
   ask the user for the missing scope or a different slug. Run the goal-gate
   status command in that checkout first. If another loop is active, report it
   and do not create a second contract.

2. **Create one complete direct contract in the current checkout.** The folder
   is `<checkout>/_bmad-output/goals/<slug>.goal/`. Write these files before
   starting:

   - `prompt.md` — the user's task verbatim.
   - `DIRECT.md` — state that this is a direct inline bootstrap, its slug, the
     absolute current-checkout root, and the original task. This records the
     shortcut and its provenance. It is not approval and it is not loop state.
   - `goal.md` — begin with the direct auto-start banner below. Write a compact
     charter that names the outcome, states that direct bootstrap uses the
     current checkout, links [`./DIRECT.md`](./DIRECT.md) as its provenance,
     and links its contract as [`./ACs.md`](./ACs.md). State the task-specific
     work and verification approach. Never restate checkbox criteria here.
   - `ACs.md` — the complete, task-specific acceptance contract. Start with the
     supplied template, replace every example, begin with the same auto-start
     banner, and include each concrete user outcome plus the repository's real
     quality gate. Every unchecked item must name a real backticked path, entry
     point, or command and carry an indented `- explanation:` line. Do not
     write a generic “finish the task” box.
   - `CLAUDE.md` and `AGENTS.md` — write the same direct auto-start instruction
     in both files. These make the contract safe to resume in a fresh context.

   Use this direct auto-start banner in all four locations: `goal.md`,
   `ACs.md`, `CLAUDE.md`, and `AGENTS.md`:

   ```markdown
   > **DIRECT GOAL — resume safely.** This folder is a direct inline contract.
   > First inspect the goal-gate status in this checkout. If a loop is active
   > for this folder, resume its unchecked criteria. If no loop is active,
   > invoke `eque2-code-pursue-goal` on this folder before doing any work. Do
   > not create state by hand or work with no bound gate.
   ```

3. **Inspect, then validate the contract.** Discover the real quality command
   from the repository instead of assuming one. If no applicable command is
   discoverable, ask the user for it; do not invent one. For “fix all lint
   issues”, the criteria must name the repository lint command and every other
   required quality command. Run both checks before starting:

   ```bash
   bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh <folder>/ACs.md
   bash {skills-root}/eque2-code-goal-gate/charter-check.sh <folder>
   ```

   A failure means the contract is not ready. Fix the files and re-run both
   checks. Do not run the starter against an invalid contract.

4. **Start through the existing starter.** Run:

   ```bash
   bash {skills-root}/eque2-code-goal-gate/pursue-goal.sh <folder>
   ```

   Honour its exit table below. Exit `0` is the only success path. The starter
   alone proves hook registration, obtains the one-loop lock, and writes the
   unclaimed state. Never create or edit state yourself.

5. **End the one direct bootstrap turn.** On exit `0`, report the folder,
   criteria count, and direct mode. Then end this turn immediately. This is the
   sole same-conversation exception: the direct route starts only after the
   complete contract exists and the starter has bound the gate. The next turn
   works the criteria under that gate.

## Procedure

1. **Resolve the prepared folder from what the user gave you.** A path ending in
   `.goal` — or a file inside one — is the folder and is the request:
   start on it immediately, without summarising the charter back or
   asking whether to proceed. `handover.md` inside the folder is the
   sole exception: invoke `eque2-code-handover-goal`; it carries the
   fresh-context transfer and must not start a second loop. The same holds when the working directory
   IS a goal folder and its own `CLAUDE.md` / `AGENTS.md` told you to
   pursue it. An explicit “pursue the goal of <task>” uses the direct route
   above. Any other no-path input has no default folder and no guessing.

2. **Honour the move — switch into the worktree first.** Hannibal
   goals live in `_bmad-output/goals/<slug>.goal/` and stage 2 moves
   them into a worktree, leaving a `<slug>.moved` stub in the main
   checkout. Before starting:

   - Resolved folder inside a **worktree that is not this session's
     working checkout**? **Switch into that worktree before anything
     else** — `EnterWorktree` with `path:` set to the worktree root
     (Claude Code), or open a fresh context with that root as the
     working directory (other agents). The starter, the gate, and every
     turn of the work then run in the worktree. Running them from the
     main checkout binds the gate to the wrong tree and edits files the
     goal's branch never sees. The user quoting a worktree path IS the
     instruction to switch there — do not ask.
   - Handed the **stub** (or a slug that resolves to one)? Follow its
     `moved-to:` path and switch into that worktree per the bullet
     above — the worktree copy is canonical.
   - Handed a goal folder whose **sibling stub exists** — i.e. the
     main-checkout ghost of a moved goal? Switch to the worktree the
     stub names and pursue the copy there. If the switch is impossible
     (worktree unregistered, tool refuses), **refuse to run here**:
     name the worktree path and tell the user to open a fresh context
     in it. Pursuing the ghost drives a folder the gate machinery and
     the branch never see.
   - Stub's `moved-to:` path no longer exists? The goal is **stale** —
     report exactly that. Do not recreate the worktree and do not
     invent a copy; the user decides whether to restore or abandon it.

   (Goals prepared in place — the recorded no-worktree fallback — have
   no stub and run where they stand.)

3. **Run the starter.** It is the single source of truth for every
   check — the folder is prepared, the criteria are readable and
   outstanding, the gate is registered and can actually run, and no
   loop is already active:

   ```bash
   bash {skills-root}/eque2-code-goal-gate/pursue-goal.sh <path>
   ```

   It accepts the folder, the folder with a trailing slash, a relative
   path, `X.goal/goal.md`, or the idea document `X.md` — all name the
   same workstream. In a fresh worktree it also self-provisions the
   goal skills and the stop-hook registration from the originating
   checkout; let it.

4. **Honour the exit code. Do not work around a refusal.**

   | Exit | Meaning | What you do |
   |---|---|---|
   | `0` | loop state written | Report it, then **end this one bootstrap turn immediately** |
   | `2` | not a prepared goal folder, or an empty/absent checklist | Report exactly what is missing. Offer `prepare-goal`. Do not invent criteria |
   | `3` | the folder or contract could not be read | Report it. Do not proceed on a contract you cannot read |
   | `4` | every criterion already met | Say so. Do NOT start a loop that can never block |
   | `5` | filesystem failure | Report it |
   | `6` | **the gate is not registered, or is registered and inert** | **Refuse.** Say the gate is missing and how to install it. Starting anyway would drive the folder to completion with nothing checking it |
   | `7` | a loop is already active | Report which. Do not start a second one |

   A refusal is the answer, not an obstacle. There is no exit code here
   that means "proceed carefully".

5. **On exit 0, report and stop once.** Tell the user, in one short
   block, the folder bound, the criteria file, and the outstanding
   count — then end this bootstrap turn. The next turn is where work
   begins, under the gate.

6. **From then on, keep the turn alive while work is in progress.** A
   Stop hook runs whenever a turn ends, so an ordinary "waiting"
   response, status-only reply, or gratuitous yield consumes a gate
   evaluation without advancing the goal. Do not end a turn merely
   because a command, subagent, browser action, build, or test is still
   running — wait inside the turn (foreground execution, or a bounded
   hard wait / poll, repeated as necessary), and continue from the
   result. End a later turn only when the current work is genuinely
   complete, the user must supply a decision or authority, or a real
   external blocker has been recorded with its written reason. Never
   use an end-of-turn as a timer for background work.

   **Recovering a counter consumed by excess yields:** first run
   `cancel.sh status`. If it shows the active loop's stall counter was
   consumed by needless turn endings, explain that finding and, **only
   when the user explicitly directs it**, run `cancel.sh reset-stall`
   (or `reset-yield`). This clears repetition accounting only; it does
   not mark work done or bypass criteria. Do not use it to conceal real
   inactivity or to revive a loop that has already ended.

7. **Work the charter.** Each turn: read `ACs.md`, pick the outstanding
   criteria, do the work, and tick a criterion **only** when it is
   genuinely met and the evidence is written into its `- evidence:`
   line. A tick without evidence is refused by the gate, so a
   self-certified tick costs a turn and gains nothing. The charter's
   fidelity and scope directives hold — never substitute a smaller run
   for the real one. A criterion tagged `[D<n>]` proves an approved
   decision in the folder's `decisions.md`: build to that decision, and
   never re-decide it or edit the criterion to fit what was built.

## What you never do

- **Never tick a criterion you have not met.** The gate cross-checks
  evidence; the only thing forging a tick achieves is a false record.
- **Never work around the gate** — do not unregister it, do not edit
  its state files by hand, do not write `LOOP_BLOCKED` to escape a
  criterion that is merely hard. `LOOP_BLOCKED` is for a real external
  blocker and requires a written reason.
- **Never start a loop on a folder you planned or prepared in this same
  conversation.** Execution starts in a **fresh context** — that separation is
  the point. The explicit direct inline bootstrap is the only exception. It
  has no plan or preparation run to bypass, and it may start only after it
  validates the complete contract and the starter writes unclaimed state.
- **Never pursue the main-checkout ghost of a moved goal** (step 2).
  The worktree copy is canonical from the end of stage 2.
- **Never run the starter or the work from outside the goal's
  worktree** when the folder lives in one (step 2). Switch in first.

## Cancelling

`goal-gate` cancel ends an active loop; help explains the current
state. Both are companions to this skill, not part of it. Cancelling is
a reported end, never a completion: unmet criteria stay unmet.
