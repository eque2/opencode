---
name: eque2-code-adopt-spike
description: >
  Promotes an adopted spike result into a promotion goal. Use when the user says 'adopt the spike', 'promote the spike', 'AS <slug>', or selects Spike's [AS].
---

# Adopt Spike — Spike's [AS]

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.

## Overview

This skill takes a spike whose verdict is `adopt` to production through
Hannibal's machinery unchanged: Spike writes the **promotion brief**,
`eque2-code-plan-goal` turns it into the **promotion plan** the developer
approves, `eque2-code-prepare-goal` builds the **promotion goal**, and a fresh
context pursues it with `eque2-code-pursue-goal`. Act as Spike, the technical
spike lead. Use with a spike slug (`AS <slug>`). Produces
`_bmad-output/goals/<slug>-promotion.goal/`, prepared once approved.

Promotion runs only **after** the spike loop has ended. The loop never stops
to ask, so the approval cannot happen inside it; starting afterwards also
keeps one loop per checkout and a fresh context per goal.

## Conventions

- Bare paths (e.g. `assets/promotion-brief-template.md`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.

## On Activation

Load available config from `{project-root}/_bmad/config.yaml` and `{project-root}/_bmad/config.user.yaml` (root level and `eque2-code` section). Use `{communication_language}` with the developer and `{document_output_language}` for the brief. If config is missing, `eque2-code-setup` can configure the module.

Unless Spike activated in this conversation, resolve his agent block the way his own activation does — `{skills-root}/eque2-code-agent-spike/SKILL.md`, "Resolve the Agent Block", fallback included, with `{skill-root}` = `{skills-root}/eque2-code-agent-spike` and `{skill-name}` = `eque2-code-agent-spike`: run its `activation_steps_prepend` now, load its `persistent_facts`, and run its `activation_steps_append` before the first question to the developer. Unless Spike already swept in this conversation, run the orphan sweep in `{skills-root}/eque2-code-agent-spike/references/sweep.md`.

Then read the slug's record from `python3 {skills-root}/eque2-code-agent-spike/scripts/spike-status.py {project-root}`
— reuse the sweep's report when the sweep ran in this turn and wrote nothing;
otherwise run it again, so the facts below are current. When `main_checkout`
is false, refuse and name the main checkout: the prepared promotion folder's
auto-start files, read inside a running spike loop, would start a second loop
inside the first. When it is null, refuse: Spike needs a git checkout.

**The spike loop must be idle on every path that reaches prepare-goal**, which
writes those auto-start files: the record's `loop` is `idle` or `n/a`. `active`
means the spike is still running, and `unknown` means its state cannot be read;
either way, stop and name the progress check,
`bash {skills-root}/eque2-code-goal-gate/cancel.sh status <checkout>` on the
spike's `worktree` (the main checkout for a spike prepared in place).

## Resume from disk

The promotion's slug is `<slug>-promotion`; a slug given with the
`-promotion` suffix already on it means the same spike. The most advanced thing on disk in
`{project-root}/_bmad-output/goals/` decides where to start:

| On disk | Start at |
|---|---|
| `<slug>-promotion.moved` | Already prepared. If its worktree is gone, say so; the developer decides. Otherwise run `bash {skills-root}/eque2-code-goal-gate/cancel.sh status <worktree>` and branch: running → report it; complete → report it, and nothing more to do; blocked → report the blocked criteria; cancelled, stalled, or never started → the hand-off again (a fresh context resumes it); anything else → report it and name the check |
| The folder with `goal.md` | Prepared in place, in the main checkout. Run the same status on the main checkout, and read only a line whose `goal folder` or `Most recent` names `<slug>-promotion.goal`. With no such line, count its criteria — `bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh --authoring <folder>/ACs.md`: every one met means complete; otherwise the hand-off. Another folder active means the main checkout's one loop is busy with it — say so |
| The folder with `.approved` | Prepare the promotion goal. To re-approve instead — the brief changed, or prepare-goal refused a stale approval — delete `.approved` and continue at "Plan the promotion"; plan-goal re-presents the set |
| The folder with `plan.md` | Plan the promotion — plan-goal re-presents the existing set for approval or revision |
| The folder with only `promotion-brief.md` | Plan the promotion with the existing brief |
| Nothing | Confirm the spike earned promotion, then write the brief |

## Confirm the spike earned promotion

All of these hold in the slug's record, or promotion waits — with the next
step named:

- **`verdict` is `adopt`.** On `reject` or `inconclusive` there is nothing to
  promote: report the verdict and numbers, point at the journal entry that
  records the dead end, and offer `[PS]` for a follow-up spike.
- **`loop` is `idle` or `n/a`** — the rule above.
- **`sweep` is `clean`.** An outstanding resource is torn down first; one with
  `auto: false` waits for the developer's word.
- **`criteria.done` is true.** Every spike-goal criterion is met and evidenced
  — the full suite on the winner and the teardown included. A spike that ended
  early is reported with what is outstanding or blocked; it is not promoted.
  `criteria` null means the count could not be read: run
  `bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh --authoring <ACs.md>`
  on the spike's `ACs.md` (for a `git:` source, on a `git show` copy in a
  temporary file), report what it says, and promote only once it counts every
  criterion met and evidenced.

Then read `findings.md`, `experiment-brief.md`, and `environment.md` together
from the record's `folder` (for a `git:` source, `git show <branch>:<path>`),
and confirm the findings' `spike-commit` is on the spike's history before any
brief names it — `git merge-base --is-ancestor <spike-commit> <branch>`, with
`HEAD` as the branch for a spike prepared in place. The drift since the
baseline is exact too — the main-line commits that touch the winner's files.
The start of the range is `<baseline-commit>` for a spike on its own branch,
and `<spike-commit>` for a spike prepared in place, whose own commits are
already on `HEAD`:

```bash
git -C {project-root} diff -z --name-only <baseline-commit> <spike-commit> \
  | xargs -0 -r git -C {project-root} log --oneline <range-start>..HEAD --
```

## Write the promotion brief

Ask the developer the two things the findings cannot answer: whether to
cherry-pick the winning diff or re-implement it from the outline, and anything
to leave behind. Then fill `assets/promotion-brief-template.md` and write it
to `{project-root}/_bmad-output/goals/<slug>-promotion.goal/promotion-brief.md`.
Copy the experiment brief's "Promotion acceptance criteria, in advance"
verbatim, less its regression-guard line — the template's guard section
states that once, as a same-run comparison against the baseline. Fill the
guard from the harness placement in `decisions.md`; when the harness stays out
of the product, ask the developer for the lighter check if the decision does
not name it.

## Plan the promotion

Invoke `eque2-code-plan-goal` through the Skill tool with the brief path and
the slug `<slug>-promotion`, and carry these into its run:

- **It is ordinary production work.** plan-goal's own lane, workflow, and
  research choices apply.
- **On re-entry**, a folder that already has `plan.md` is presented as it
  stands, for approval or revision.
- **The agreed criteria are binding.** Before presenting, check `ACs.md`
  against the brief: every agreed criterion and the regression guard appear,
  unweakened. Restore any that is missing or weakened, and say so when the set
  is presented.
- **Present the promotion, not just the plan.** Lead with the spike's verdict
  and numbers, the code-transfer approach, the regression guard, and the
  rollout and rollback.
- **The next step is `[AS] <slug>`**, never `prepare-goal <slug>-promotion` —
  `[AS]` re-checks the spike loop before preparation.

plan-goal then stops; the developer's explicit word writes `.approved` —
nothing else counts, and Spike never writes the marker.

## Prepare the promotion goal

Once `.approved` exists, run `spike-status.py` again and apply the loop rule
under On Activation — approval can come many turns after activation. Then list
Spike's own uncommitted files from `git status
--porcelain` in the main checkout: the sweep record, journal entries brought
home, the spike's `.moved` stub. The promotion folder never counts:
prepare-goal excludes it from its dirty check and moves it. Recommend
committing the rest — prepare-goal asks about a dirty checkout. If
`[ "<folder>/promotion-brief.md" -nt "<folder>/.approved" ]` is true, do not
prepare: the approval is a file, so the change goes back through the
`.approved` row above to plan-goal's gate. Then invoke `eque2-code-prepare-goal` with
`<slug>-promotion`. It owns the
approval-hash check, the dirty-checkout question, the worktree from the main
checkout's `HEAD`, the charter, and the auto-start files; its questions go to
the developer, and Spike never passes `--force`. Its own hand-off ends
prepare-goal, not this workflow.

## Hand-off

One block:

1. **Start it.** Open a fresh context with the promotion goal folder as its
   working directory — `cd "<worktree>/_bmad-output/goals/<slug>-promotion.goal" && claude`
   (or `codex`), the real path resolved and quoted; for a folder prepared in
   place, the path is in the main checkout. The folder starts itself under the
   stop gate.
2. **Keep the spike branch**, when there is one, until the promotion has
   merged — it holds the winning diff and the evidence. After the merge, retire
   both: delete the spike's and the promotion's `.moved` stubs and branches, so
   Spike stops listing them.

Then stop — never pursue the promotion goal in this conversation.
