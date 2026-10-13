> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.

> **GOAL-READY 2026-10-13** — spike-task-harness-promotion, heavy lane,
> adversarially reviewed; no spec pipeline — the plan declined `[CS]`/`[DS]`
> (see `./plan.md`, Declined workflows), so the approved `ACs.md` is the
> whole contract. Drive with your agent's completion loop (`pursue-goal`,
> which binds the stop gate). See `./decisions.md` + journal below for the
> full contract.

> **Build via `bmad-build`, against the approved contract.** The plan
> declined `[CS]`/`[DS]`: the spike already produced the design, the tests
> and the conformance guard, and this work transfers, removes and hardens
> tested code. `ACs.md` is the whole contract and `decisions.md` holds the
> approved technical choices — build to them, do not re-decide them. Build
> with `bmad-build` (its spec goes to
> `_bmad-output/implementation-artifacts/spec-spike-task-harness-promotion.md`,
> as AC 8 names), then evidence each criterion in `ACs.md` with real command
> output. If the work turns out to need something the plan did not decide,
> stop and report it: the decisions are stage-1 decisions, and changing one
> means re-planning.

> **Run autonomously (YOLO).** When this charter is executed, run it
> end-to-end **without stopping to ask permission**. Resolve issues
> automatically — investigate-and-fix a failing test, a missing file, an
> unfamiliar flag, a crashed tool; do NOT escalate them. Default
> decisions, never questions:
> - **A fidelity question → choose the HIGHEST fidelity** (full universe /
>   full dataset / the sanctioned venue; never a reduced or local sample
>   as the verdict).
> - **A scope question → choose the WIDEST scope** consistent with the
>   stated intent (do the complete job, not a slice).
> - Do NOT ask *how* to build (the Build-via directive is the answer) or
>   *whether* to spend on the sanctioned compute (yes).
> **Validate before you fan out — MANDATORY, no exceptions.** Autonomy and
> widest-scope do NOT mean launching N parallel/expensive workers on
> unproven code. Before any fan-out (multiple VMs/jobs, a large batch, a
> costly parallel sweep) you MUST, in this order: (1) test the code
> thoroughly (the suite is green); (2) run ONE small real subset
> end-to-end in the LIVE environment — a single VM / a handful of items /
> one shard — and confirm it actually succeeded (correct output, no
> errors, expected cost); only THEN scale to the full fan-out. One canary
> that passes earns the fleet; an unvalidated fleet is forbidden even
> under YOLO. The widest-scope default applies to the *eventual* run,
> never to the first launch. (A single bug fanned across 25 VMs cost $700
> — this gate exists to prevent exactly that.)
> Stop ONLY for a genuine blocker: an interactive credential/auth the
> owner alone can clear, an external precondition outside your control
> (quota exhausted, required data absent), or an ambiguity that would
> change the *verdict* and has no defensible highest-fidelity/widest-scope
> default. Report cost/outcome **after** the fact, not as a gate before
> it. Never fabricate a verdict — it must come from the real run; an
> honest negative is a valid outcome to surface, not a stall.

# Charter — promote the spike-task-harness winner (O2) to production

- Input: [`./promotion-brief.md`](./promotion-brief.md)
- Plan: [`./plan.md`](./plan.md)
- Approved decisions: [`./decisions.md`](./decisions.md) (D1–D9)
- Acceptance contract: [`./ACs.md`](./ACs.md)
- Journal: [`./journal/`](./journal/), index [`./JOURNAL.md`](./JOURNAL.md); state [`./STATE.md`](./STATE.md)
- Provenance: [`./MANIFEST.md`](./MANIFEST.md); external paths (the spike branch and its evidence) are recorded there.

## Scope notes for the executor

- **Compute and spend.** This goal does not fan out. The regression guard runs without `--live`, so it spends no model tokens. A live L1 run is paid, is outside this contract, and needs the developer's word.
- **The spike branch is read-only.** Take code from `goal/spike-task-harness` with `git cherry-pick` or `git checkout <commit> -- <path>`; never commit to it, and never delete it.
- **The main checkout belongs to the developer.** Touch it only for the D8 merge. Never stash there (the stash stack is shared); a merge that would overwrite the developer's uncommitted files is a blocked criterion, with the file names.
- **Commits.** Small atomic commits, each with a Why / Source / Notes body, as the repository's `AGENTS.md` and the developer's rules require. Never push.
- **The guard is never retried until green.** Keep the JSON of every attempt in `./journal/`. A flaky check is a defect to fix, not a run to repeat.
- **Other worktrees.** For the D7 re-plan, switch with `EnterWorktree` (`path:` the task-harness worktree) and back again; for the D8 merge, leave with `ExitWorktree` (`keep`), merge in the main checkout, and re-enter this worktree. If the session refuses git there, block the criterion with the exact commands for the developer.
- **Shared repository hygiene.** The `test:httpapi` gate may leave `opencode/*` branches and temporary worktrees behind. Report them; never bulk-delete branches or worktrees.
- **The paused goal's `spec/` state** changes only through the state CLI, never by hand (the repository's anti-tamper policy).

## Tasks

1. Transfer the product code (D1): the apparatus commits before the baseline (`d69f2f5ab0..3ffee602cd`, AC 14), the winner diff `3ffee602cd..dbf57fe844` under `packages/`, `task-formats/blend/` and the root files the product needs, then the post-spike product commits listed in the brief. Prefer `git cherry-pick` of the product-only commits, so each keeps its message. Leave the evidence, `launch.sh`, `task-seed.sh` and `task-ui.md` behind.
2. Remove O1's engine, the O3 plugin and the selector, and keep O2 alone (D2).
3. Reduce the conformance runner to the `baseline` and `o2` arms, with the baseline started from a clean export of the branch point (D6).
4. Ship the task-ui with all seven designs and without the demo launch mode (D3).
5. Bring the blend validator's negative-case messages to byte parity with the golden model (D5).
6. Harden through `bmad-build`: spec, build, review, triage log (D1).
7. Re-plan the paused `task-harness` goal and remove its approval marker (D7).
8. Show that the pre-promotion build survives the promotion's stored task events (D9).
9. Take on the production safety items by name: the proof environment allowlist, the read-only verifier and confined builders, and the base branch from the repository (AC 20).
10. Register the task-ui as a built-in, and remove every spike leftover from shipped code (AC 16, AC 21).
11. Bring `dev` into the branch, pass the guard and the quality gate, untrack this folder and the spec, then merge `--no-ff` into `dev` in the main checkout without pushing (D8, AC 15, AC 26).

## Ready-to-execute commands

- Guard: `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1`
- Quality gate, from the worktree root: `bun lint`, `bun typecheck`, `GITHUB_ACTIONS=false bun turbo test`, then `cd packages/opencode && bun run test:httpapi`. Run the tests without the developer's `GOOGLE_CLOUD_LOCATION` and `GOOGLE_CLOUD_PROJECT` (the spike's findings: they override the Vertex provider tests).

## Contract review

Phase R reviewed this contract adversarially before hand-off; the report is in [`./reviews/`](./reviews/).

## What this skill did NOT do

- It did not run `[CS]`: the plan declined it, so there is no `spec/`.
- It did not build, test or merge anything, and did not start the loop.

## Done when

The acceptance contract for this workstream is [`./ACs.md`](./ACs.md)
(28 criteria). It is the file the gate reads; this charter does not
restate it. A criterion tagged `[D<n>]` proves an approved technical
decision in [`./decisions.md`](./decisions.md) — build to the decision,
do not re-decide it.

> **An unchecked box is a question, not a verdict.** If an item is still
> `[ ]`, say plainly *why* — then ask whether there is *truly* nothing you
> can do about it. A blocker you didn't create (a pre-existing repo defect,
> a flaky dependency, a broken fixture) is a reason to FIX it, not a licence
> to stop. Almost always there is a next action: investigate it, repair it,
> route around it. Exhaust the autonomous options and complete the item;
> escalate only the genuine blockers listed in this charter's stop rules.

**To drive this hands-off**, open a fresh context and refer to this
folder — naming the path is enough to start it:

```
/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/spike-task-harness-promotion/_bmad-output/goals/spike-task-harness-promotion.goal
```

Or open it as the working directory (`cd <this folder> && claude`, or
`codex`) and it starts itself. The explicit forms —
`/eque2-code-pursue-goal <this folder>` or `pursue-goal <this folder>` —
do the same thing for anyone who wants to be unambiguous.

That binds the stop gate to this folder's `ACs.md` and refuses to let the
run end while any criterion is outstanding. It is the ONLY supported way to
execute this charter — do not paste the criteria into a host agent's
built-in goal command, which judges a conversation rather than an evidenced
checklist and leaves no record of what it judged.
