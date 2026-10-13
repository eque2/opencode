---
name: eque2-code-execute-spike
description: >
  Prepares an approved spike plan for running. Use when the user says 'execute the spike', 'run the spike', 'ES <slug>', or selects Spike's [ES].
---

# Execute Spike — Spike's [ES]

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.

## Overview

This skill takes a spike plan the developer approved in `[PS]` and turns it
into a running experiment, using Hannibal's machinery unchanged:
`eque2-code-prepare-goal` builds the **spike goal**, and a **fresh context**
pursues it with `eque2-code-pursue-goal` under the stop gate. Act as Spike,
the technical spike lead. Use with a spike slug (`ES <slug>`). Produces the
prepared spike goal and one hand-off to the fresh context; it never starts
the loop itself.

The fresh context is not ceremony: pursue-goal forbids starting a loop in the
conversation that planned or prepared its folder, and allows one loop per git
top-level — a worktree gives the spike its own.

## On Activation

Load available config from `{project-root}/_bmad/config.yaml` and `{project-root}/_bmad/config.user.yaml` (root level and `eque2-code` section). Use `{communication_language}` throughout. If config is missing, `eque2-code-setup` can configure the module.

Unless Spike activated in this conversation, resolve his agent block the way his own activation does — `{skills-root}/eque2-code-agent-spike/SKILL.md`, "Resolve the Agent Block", fallback included, with `{skill-root}` = `{skills-root}/eque2-code-agent-spike` and `{skill-name}` = `eque2-code-agent-spike`: run its `activation_steps_prepend` now, load its `persistent_facts`, and run its `activation_steps_append` before the first question to the developer. Unless Spike already swept in this conversation, run the orphan sweep in `{skills-root}/eque2-code-agent-spike/references/sweep.md`. When it reports `main_checkout` false, stop and name the main checkout — a developer back from a spike loop is often still in its worktree; when null, stop: Spike needs a git checkout.

## Route on the spike's state

Read the slug's record from `python3 {skills-root}/eque2-code-agent-spike/scripts/spike-status.py {project-root}`
— reuse the sweep's report when the sweep ran in this turn and wrote nothing;
otherwise run it again, because an earlier report can be stale. With no slug,
list the report's approved spikes and ask which. An inexact slug (`ES mcp`) is
matched against the report's slugs; ask when more than one fits. A slug with no record is not a spike plan: a goal folder without
`experiment-brief.md` belongs to Hannibal's `[PG]`, and no folder at all
belongs to `[PS]`. "The progress check" below is
`bash {skills-root}/eque2-code-goal-gate/cancel.sh status <checkout>`, run on
the record's `worktree`, or on the main checkout for a folder prepared in
place. In the main checkout, read only lines that name this spike's folder:
another goal's loop or signal there is not this spike's, and while another
loop is active the main checkout's one loop is busy — say so, and give no
hand-off.

| The record | Do |
|---|---|
| `planned` | Not approved yet. Send the developer to `[PS] <slug>`, where plan-goal's gate takes the approval. |
| `approved` | Check, then prepare (below). |
| prepared (either kind), loop `active` | Running. Report it and name the progress check. Nothing to prepare. |
| prepared, loop `idle`, `criteria.done` — or `stale` with `criteria.done` | Finished. Report the verdict from the record: `adopt` → `[AS] <slug>`; `reject` or `inconclusive` → the journal entry that records it, and `[PS]` for a follow-up spike. A removed worktree after a finished spike is normal. |
| prepared, loop `idle`, `criteria.blocked` above 0 and `criteria.unchecked` 0 | Ended blocked with nothing left to work — a reported non-completion. Report the blocked criteria and their reasons; give no hand-off. A spike blocked because only production could host it is over: offer `[PS]` for a non-production follow-up. Say what the sweep tore down and what still waits. |
| prepared, loop `idle`, the progress check shows a `BLOCKED` signal for this spike | The loop declared a blocker. Report its reason. If only production could host the experiment, the spike is over: offer `[PS]` for a non-production follow-up. Otherwise the developer resolves the reason and removes the signal (the progress check names its file), then `ES <slug>` again. |
| prepared, loop `idle`, not done, `criteria.unchecked` above 0, no signal (or `criteria` is null — the progress check then decides) | Never started, cancelled, or stalled, perhaps with some criteria blocked. Re-run "Check the prepared folder" below, then give the hand-off again — a fresh context resumes it. A stall on a long benchmark is what the gate's `WAIT` file is for; say so. |
| loop `unknown` | Report it and name the progress check; do not hand off a second loop. |
| `stale`, not done | The worktree is gone before the spike finished. Report the stub's path and branch; the developer decides whether to restore or abandon it. |
| `lost` | Its worktree and branch are both gone. Report "check by tag `spike:<slug>`". |

## Check before preparing

Re-run the spike-criteria check on the approved set — it costs one script
call and catches a set approved without it:

```bash
python3 {skills-root}/eque2-code-plan-spike/scripts/check-spike-acs.py {project-root}/_bmad-output/goals/<slug>.goal
```

Exit 1 means a criterion states the answer or evidence is missing. Do not
prepare: prepare-goal only adds criteria, and any edit to an approved file
voids the approval. Send the developer to `[PS] <slug>` with the findings —
for an approved spike sent back from here, `[PS]` deletes the approval, revises
the set, and takes plan-goal's gate again. Exit 2 means the check did not run
(read stderr: the script or the brief is missing): do not prepare. If the
script exists but cannot execute, apply the rules in its docstring by hand.

Two things to say before preparing, when they apply:

- The brief changed after approval —
  `[ "<folder>/experiment-brief.md" -nt "<folder>/.approved" ]` is true. The
  loop reads the brief, and the approval hashes only `plan.md`,
  `decisions.md`, and `ACs.md`, so a word in conversation is not enough: do not
  prepare; `[PS] <slug>` takes the change through the approval gate again.
- Spike's own files are uncommitted in the main checkout — `git status
  --porcelain` lists sweep records or journal entries the sweep wrote.
  prepare-goal will ask about the dirty checkout; name the files and recommend
  committing them, so they are on the spike branch too.

Then note, from the approved brief and decisions, what the hand-off needs: the
environment and its proof, the resources, the budgets, the verdict rule, and
the expected duration. After preparation the folder carries auto-start
instructions: for the hand-off, read only its `experiment-brief.md` and
`decisions.md` — never `goal.md`, `ACs.md`, `CLAUDE.md`, or `AGENTS.md`.

## Prepare the spike goal

Invoke `eque2-code-prepare-goal` through the Skill tool with the slug. It owns
the approval-hash check, the dirty-checkout question, the worktree on
`goal/<slug>` from the main checkout's `HEAD`, the move of the folder, the
charter, and the auto-start files. Its questions go to the developer; Spike
never answers them on the developer's behalf and never passes `--force`.
prepare-goal ends its own stage with a hand-off and a stop — that ends
prepare-goal, not this workflow: continue below, and give the developer one
hand-off, Spike's, in place of two.

If prepare-goal stops early, read why. It refused the approval (a file
changed after it was approved): the approval is void, so `[PS] <slug>` takes
the change through the gate again. The developer cancelled, or another step
failed, with no `<slug>.moved` stub in the main checkout: nothing was prepared
and the plan is still approved. With a stub, preparation got past the move:
run "Check the prepared folder" — it says whether the folder can start.

## Check the prepared folder

prepare-goal may append criteria — for example the quality gate, when the
approved set lacks it. Find the
prepared folder from a fresh `spike-status.py` record (`folder`, `worktree`),
then run each check on its own and read each exit code:

```bash
python3 {skills-root}/eque2-code-plan-spike/scripts/check-spike-acs.py <prepared folder>
```

```bash
bash {skills-root}/eque2-code-goal-gate/charter-check.sh <prepared folder>
```

Either failing means the spike goal could stall or cannot start: do not hand
off. Spike never deletes or rebuilds a prepared spike goal; the next step
depends on what failed:

- **A criterion prepare-goal appended** (it journals each one with its
  source) fails `check-spike-acs.py`. It is not an approved criterion, so the
  add-only rule does not bind it: reword that one line by putting the
  condition in backticks after the evidence file — never weaken it, and never
  edit the brief — commit on the folder's branch (`goal/<slug>`, or the main
  checkout's branch for a folder prepared in place), and run `ES <slug>` again.
- **`charter-check.sh` exits 4** — the charter and its criteria disagree. The
  fix is the charter line it names in `goal.md`, never the criteria: correct
  it, commit on the folder's branch, and run `ES <slug>` again.
- **Anything else** — a finding on approved content, or `charter-check.sh`
  exit 2 or 3 (preparation did not finish, or the criteria cannot be read) —
  means this spike goal cannot start as prepared. Keep it — its branch, or the
  folder in the main checkout when prepared in place, holds the only copy of
  the approved plan. `[PS] <slug>` plans a follow-up, `<slug>-r2`, seeded from
  this brief. Once `-r2` exists, the developer may retire the dead one: its
  worktree, branch, and `.moved` stub.

Edit only the named line. The banner at the top of `ACs.md` and `goal.md` is
for the fresh context, not for this conversation. These are the only edits
Spike makes to a prepared spike goal; owner ruling 3
still holds, because prepare-goal, its approval, and the routes into the goal
are unchanged.

## Hand-off

One block, in this order:

1. **Start it.** Open a fresh context with the goal folder as its working
   directory — `cd "<worktree>/_bmad-output/goals/<slug>.goal" && claude` (or
   `codex`), with the real path resolved and quoted — or open any fresh session
   in the worktree and paste the folder path. The folder's auto-start files
   start the spike goal under the stop gate. For a folder prepared in place,
   the path is in the main checkout, and the loop takes the main checkout's
   one loop.
2. **What starts.** The environment and its non-production proof, the tagged
   resources the approval already permits, the budgets, the verdict rule, and
   the expected duration — as noted before preparing.
3. **Check progress** with the progress check above.
4. **Come back.** When the loop ends — complete, blocked, or cancelled — run
   Spike in the main checkout. The sweep brings the journal entry home and
   removes anything left running; an `adopt` verdict goes to `[AS] <slug>`.
   Keep the `goal/<slug>` branch, when there is one, until any promotion has
   merged. If the spike never seems to start, run `ES <slug>` here again: it
   reads the spike's state and says what to do.

Then stop. Never start the loop in this conversation.
