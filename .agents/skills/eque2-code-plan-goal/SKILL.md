---
name: eque2-code-plan-goal
description: >
  Hannibal stage 1 — plan a goal. Take a task (a prose brief, a prompt
  file, or an inline description) and produce a reviewable set: the
  technical decisions (decisions.md, each with justification and
  alternatives), the acceptance criteria (ACs.md, which the stop gate
  later enforces), and the plan (plan.md — workflows per stage, lane,
  worktree). Writes _bmad-output/goals/<slug>.goal/ in the
  main checkout and STOPS for the user's approval — it prepares nothing
  and executes nothing. Triggers on: "plan a goal", "plan-goal", "plan
  this task", "make a plan for", "/eque2-code-plan-goal", or Hannibal's
  [PL]. Do NOT use to prepare an approved plan (that is prepare-goal) or
  to execute a prepared folder (that is pursue-goal).
---

# Plan-Goal — Hannibal stage 1

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.

Take a task and decide, in writing, what will be built, when it is
done, and how the work runs — before anything is prepared or built. The
output is three documents the user can read in ten minutes and approve
or push back on: `decisions.md` (every technical choice, with its
justification and alternatives), `ACs.md` (the acceptance criteria), and
`plan.md` (the workflows, lane, and worktree). Because the criteria are
approved here, stages 2 and 3 have a contract they can run against
without asking the user again.

**This skill plans. It does not prepare and it does not execute.** The
deliverable is a goal folder holding the three documents and a copy of
the input, plus — only after the user approves — the approval marker
that unlocks stage 2. Creating the worktree, producing the SPEC, writing
`goal.md`: all of that is `prepare-goal` (stage 2), and running the work is
`pursue-goal` (stage 3). If you find yourself doing any of it here, back
out.

## The folder — where everything lands

For a task slugged `<slug>` (kebab-case, from the task's own name):

```
_bmad-output/goals/<slug>.goal/     <- in the MAIN checkout
├── <original-prompt-file>          <- copied in verbatim; inline input -> prompt.md
├── plan.md                         <- index + how the work runs
├── decisions.md                    <- what gets built, D1..Dn
├── ACs.md                          <- when it is done (no auto-start banner yet)
└── .approved                       <- written ONLY on approval (see below)
```

This stage writes the three documents and the copied input. **Nothing
else, and nothing anywhere else** — not `planning-artifacts/`, not
`features/`, not the repo root. The `.goal` suffix is required: a `.goal`
path is what stage 3 triggers on, and the status scan enumerates
`_bmad-output/goals/` by exactly this shape. Collisions fail closed: an
existing `<slug>.goal/` directory is this workstream's folder and is
reused; an existing file of that name is an error, not an invitation to
invent another name.

Stage 1 always runs in the **main checkout**. Stage 2 may later move the
folder into a worktree; that move and its `.moved` stub are stage 2's
job, never this one's.

## Procedure

### 1. Take in the task

Read the input — a file the user named, or their inline description.
Copy a file input into the goal folder verbatim; write an inline
description to `prompt.md`. The input is the contract: the plan covers
everything it implies, and a "tangent" is only ever a genuinely different
workstream, never a euphemism for dropping implied work.

### 2. Research, only where a decision needs evidence

Where a Decision rests on something not yet known — an unfamiliar
technology, an unclear domain, a genuinely open solution space — run the
matching research workflow **now**, inline, so the plan's justifications
are evidence rather than guesses: `bmad-deep-recon` (technical) for
technology, `bmad-deep-recon` (domain) for domain rules, `bmad-brainstorming`
when several credible approaches exist and no obvious winner. Findings go
into `decisions.md`'s **Research** section. Skip research entirely when the
codebase and the input already answer the question — research that
confirms the known is stage-1 theatre.

### 3. Choose workflows from the matrix

Load `references/decision-matrix.md`. The inline matrix there is
**authoritative** — it decides which skill suits which kind of task.
Runtime discovery (scanning what else is installed) only *adds* rows for
skills the matrix does not mention; it never overrules one. The chosen
workflows become `plan.md`'s **Stage sequence**. Do not treat
`_bmad/_config/bmad-help.csv` as ground truth — the catalogue lags
renames; the filesystem does not.

**Verify every skill the plan names exists on disk** before writing it
in: `[ -d "{skills-root}/<skill-name>" ]`. A named skill that is absent
does not silently vanish from the plan — its Stage sequence row records it as
**NOT INSTALLED**, names the closest installed alternative, and the plan
states plainly that stage 2 will refuse to bind it until it is installed
or the plan is re-approved with the alternative.

### 4. Choose the lane

Load the lane rules in `references/decision-matrix.md` §Lane. The short
form: the task takes the heavier workflows if it touches more than a
couple of files or adds one, adds a dependency, changes a schema or
migration, changes a public interface, changes something the user sees,
touches auth/payment/security, or the user asked for a spec/PRD/epics.
None of those → the light lane: ACs written directly, `bmad-build`
against them, no `[CS]`/`[DS]`, no test state. **Cannot tell → ask the
user.** Never assume either way silently.

"Lightweight" selects away *workflows*, never ceremony: every task started
through this planning workflow still gets the goal folder, the plan, the
approval gate, the acceptance criteria, and the bound stop gate. There is no
bypass lane **inside `[PL]`**. The explicit direct-inline route in
`pursue-goal` is a separate activation that creates and validates its own
contract without calling this workflow. A declined heavyweight workflow is a
**recorded decision** in the plan's "Declined workflows" section, not an
omission.

### 5. Decide the worktree

Decide — do not create. Default: a worktree is required, on branch
`goal/<slug>`, **inside the repo at `{project-root}/.claude/worktrees/<slug>`**
— the agent-managed worktree root, the same place `[DS]` develop-spec
puts its worktrees, already excluded from git. A Codex-only install
(skills at `.agents/skills/`, no `.claude/`) uses
`{project-root}/.agents/worktrees/<slug>` instead. Never a sibling of
the repository, and never anywhere outside it. `git config
eque2.worktreeRoot`, when the repo sets it, overrides the default; a
path the user names in the request overrides both. Record the decided
path and branch in the plan's **Worktree** section. "None" is recorded
only when the user explicitly said so, or this is not a git repo — with
the reason. Stage 2 creates it.

### 6. Write the three documents

Load `references/plan-format.md` and follow it exactly — the shapes are
fixed because stage 2 binds them, the gate enforces `ACs.md`, and the
status scan counts them. Write in this order, since each feeds the next:

1. `decisions.md` — every technical choice as `D<n>` with all four
   fields. A decision with nothing to compare says "None credible"
   under **Alternatives**; it never drops the field.
2. `ACs.md` — the user outcomes the input asks for, one `[D<n>]`
   criterion per decision with an observable result, and the quality
   gate. Fill each decision's **Verified by** as you go. Validate with
   `acs-format-check.sh --authoring`.
3. `plan.md` — the links to the input, `decisions.md`, and `ACs.md`,
   then the Stage sequence, Lane, Worktree, Declined workflows, and
   Skill availability.

### 7. Present, then stop at the gate

Present the set to the user — lead with the lane, the worktree
decision, the decisions that carry real trade-offs, and the acceptance
criteria (the user is approving the finish line, not only the route).
Then **stop and wait**.

- **The user approves** ("approved", "go ahead", or equivalent) → write
  `_bmad-output/goals/<slug>.goal/.approved`:

  ```
  approved-by:    user
  plan-hash:      <output of `git hash-object plan.md`>
  decisions-hash: <output of `git hash-object decisions.md`>
  acs-hash:       <output of `git hash-object ACs.md`>
  at:             <ISO-8601 UTC>
  ```

  Then tell them stage 2 is unlocked: `prepare-goal <slug>`.

- **The user pushes back** → revise the documents, present again. An
  edit to any of the three invalidates any earlier marker by
  construction (a hash moves), so never leave a stale `.approved` beside
  a revised set — delete it when you revise.

- **Anything else** — enthusiasm, silence, a question about the plan —
  is **not approval**. The marker is the only route (stage 2 accepts an
  explicit `--force`, which writes `approved-by: OVERRIDE`; that is stage
  2's affair and the user's deliberate act, never yours). Never infer.

Approval is a file, not a memory of a conversation: a fresh context can
read the three documents cold and write the marker on the user's word, because the
gate reads the file and never the transcript.

## Speed

Plan at the weight the task earns. A one-file fix deserves a one-area
plan with two Decisions, written in minutes — the fixed shape holds, the
length shrinks. Do not pad small plans with ceremony prose, and do not
compress large ones below the point where the user can actually judge
the trade-offs. The heavyweight planning workflows (`bmad-prd`,
`bmad-architecture`, epic breakdowns) are stage-2 mechanisms the plan may
*select* — running them during stage 1 is over-stepping.

## Failure modes to refuse

- Ending the run without `plan.md`, `decisions.md`, and `ACs.md` on
  disk — a plan presented only in conversation is not a deliverable.
- Writing `.approved` on anything short of the user's explicit word.
- Naming a workflow the disk check did not confirm, without the
  NOT INSTALLED marking.
- A decision missing any of its four fields, a plan missing any of its
  sections, or an `ACs.md` that `acs-format-check.sh --authoring`
  refuses.
- A decision with an observable result and no `[D<n>]` criterion.
- Starting stage 2 work — creating the worktree, running `[CS]`,
  writing `goal.md` — from inside this skill.
