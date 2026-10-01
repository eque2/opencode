---
name: eque2-code-prepare-goal
description: >
  Hannibal stage 2 — prepare an approved goal. Take a goal folder whose
  plan the user approved in stage 1 (plan-goal), create the decided
  worktree, move the folder into it, and build the executable
  workstream the plan binds: the SPEC and design artefacts (heavy lane),
  the hardened charter, and the auto-start files that make the folder
  start itself in a fresh context — all against the acceptance criteria
  the user approved in stage 1. Refuses to run without the stage-1
  approval marker, and refuses a plan, decisions, or ACs file edited
  after approval. Triggers on: "prepare the
  goal", "prepare-goal", "prepare <slug>", "/eque2-code-prepare-goal",
  or Hannibal's [PG]. Prepares only — it does not plan (that is
  plan-goal) and does not execute (that is pursue-goal).
---

# Prepare-Goal — Hannibal stage 2

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.

Stage 1 decided; this stage builds the workstream those decisions
describe. Input: a goal folder `_bmad-output/goals/<slug>.goal/` in the
**main checkout**, carrying the approved `plan.md`, `decisions.md`, and
`ACs.md`. Output: that same folder — moved into its decided worktree,
now carrying `goal.md` (the hardened charter), `ACs.md` stamped ready
for the gate, the SPEC in `spec/` where the plan chose the heavy lane, and the auto-start files
that make a fresh context begin work on sight. The folder's layout
contract is `references/goal-folder.md`; the layout's normative resolver
is `{skills-root}/eque2-code-goal-gate/goal-folder-path.sh`, which stage
3's starter uses when it binds the folder — the `X.goal/` shape this
stage preserves is what that machinery recognises.

**This skill prepares. It does not plan and it does not execute.** The
plan is stage 1's deliverable and this stage treats it as a contract —
executing it, not re-litigating it. Running the charter — the build, the
tests, the loop — is `pursue-goal`, in a **fresh context**, later.
Preparing a folder and then starting its loop in the same conversation
defeats the context separation the auto-start files exist to make cheap.

## The approval gate — pre-flight, before anything else

Approval is a file, never a memory of a conversation. Before touching
anything:

1. **Resolve the folder.** Accept a slug, the folder path, or a file
   inside it. The folder must exist at `_bmad-output/goals/<slug>.goal/`
   in the main checkout and contain `plan.md`, `decisions.md`, and
   `ACs.md`. A sibling `<slug>.moved`
   stub means this goal is **already prepared** — report the worktree
   path the stub names and stop; preparing twice is not idempotent, it
   is a second workstream.
2. **Require the marker.** `_bmad-output/goals/<slug>.goal/.approved`
   must exist. Absent → refuse and say exactly what is missing: the user
   approves the plan in conversation with stage 1, which writes the
   marker. Enthusiasm, silence, or questions about the plan are not
   approval, and neither is this skill being invoked.
3. **`--force` is the only override.** An explicit
   `prepare-goal <slug> --force` writes the marker itself with
   `approved-by: OVERRIDE` (plus `plan-hash` and `at`), then proceeds.
   It never suppresses the marker — the override is recorded, reported
   by the status scan as `approved (OVERRIDE — plan not reviewed)`, and
   journalled. Never reach for `--force` yourself; it is the user's
   deliberate act, spelled out in their invocation.
4. **Stale approval voids.** Re-hash each approved document
   (`git hash-object` on `plan.md`, `decisions.md`, `ACs.md`) and
   compare against the marker's `plan-hash`, `decisions-hash`, and
   `acs-hash`. Any mismatch means a document changed after the user
   approved it: refuse, name the file that drifted, and tell the user to
   re-approve via stage 1. A marker without `decisions-hash` or
   `acs-hash` predates this layout: refuse it the same way. This
   guarantees stage 2 builds what the user actually read — never a
   quietly edited version. Run this check before anything below edits
   `ACs.md`.

## The worktree — created here, folder moved in

Stage 1 decided the worktree; this stage creates it (the plan's
**Worktree** section names the path and branch `goal/<slug>`; the
path convention and the not-a-repo fallback are in
`references/goal-folder.md` §1a). The path is
`{project-root}/.claude/worktrees/<slug>` — inside the repository,
never a sibling of it — unless the user or `git config
eque2.worktreeRoot` named another.

1. **Check for a dirty main checkout first.** `git status --porcelain`
   in the main checkout, **excluding this goal's own folder** (it is
   dirty by construction); any output → stop and ask the user what to do
   with it (commit — recommended / bring along via stash / proceed
   without / cancel), per `references/goal-folder.md` §1a. The worktree
   branches from `HEAD`, so uncommitted work does not come with it.
   Never decide this yourself.
2. Create the worktree on branch `goal/<slug>`.
3. **Move** `_bmad-output/goals/<slug>.goal/` into the worktree at the
   identical relative path, and commit it on the branch. There is never
   more than one live copy of a goal folder.
4. Leave a stub at `_bmad-output/goals/<slug>.moved` in the main
   checkout:

   ```
   moved-to: /abs/path/to/worktree
   branch:   goal/<slug>
   moved-at: <ISO-8601 UTC>
   ```

5. From this point the **worktree copy is canonical**. Everything below
   happens inside the worktree; the main checkout is not touched again.
   (Stage 3's starter self-provisions the goal skills and the stop-hook
   registration into the worktree from the originating checkout — that
   is its machinery, not yours to replicate.)

**No worktree** (the plan recorded "none", this is not a git repo, or
creation failed): prepare in place in the main checkout, write **no
stub**, and record the fallback in the plan's Worktree section. Never
`git init`, and never switch the main tree's branch as a substitute.

## Build what the plan bound

Work through the stage-2 rows of the plan's **Stage sequence**, running
each **inside the goal folder** — every artefact lands in `X.goal/`,
every internal reference **relative**, nothing scattered into
`_bmad-output/features/` or any pipeline default. Refuse to bind a
workflow the plan marked NOT INSTALLED — that row goes back to the
user, it does not get silently substituted. `decisions.md` is input to
every workflow here: a SPEC or design that contradicts an approved
`D<n>` is a defect to fix in this stage.

- **Heavy lane** — run the bound workflows: `[CS]` create-spec writes
  the SPEC into `X.goal/spec/` and `mirror-spec.sh in-place` records its
  provenance in `MANIFEST.md` (the mirror fallback, for a pipeline that
  cannot be redirected, is `references/goal-folder.md` §5); design work
  (`bmad-ux`, `bmad-prd`, epic breakdowns) writes into the
  folder likewise.
- **Light lane** — no `[CS]`/`[DS]`, no test state, and the gate does
  not care: the approved `ACs.md` is the whole contract. Record "no spec
  pipeline" honestly in `MANIFEST.md` rather than claiming an empty
  `spec/`. The evidence bar does not drop — criteria are still evidenced
  by real command output at execution time.

### The approved ACs — add, never weaken

Stage 1 wrote `ACs.md` and the user approved it. This stage may change
it in two ways only:

- **Prepend the auto-start banner** (`references/emitted-charter.md`).
- **Append criteria** the SPEC or design work surfaced — for example, one
  per CAP success condition. Append at the end, so the approved AC
  numbers that `decisions.md` cites stay stable. Journal each addition
  with its source.

Never remove, reword, reorder, or tick an approved criterion. A SPEC
that shows an approved criterion is wrong or impossible is a question
for the user: stop and report it, because the fix is a stage-1
re-approval, not a quiet edit. This rule is what lets this stage run
without the user.

Phase detail, ordering, and the journalling discipline live in
`references/phases.md`. The verbatim charter stamp blocks — auto-start
banner, Build-via directive, YOLO directive, Done-when checklist — live
in `references/emitted-charter.md`. The acceptance-criteria format
(checkboxes, evidence lines, the blocked state) is
`references/acs-format.md`, enforced by
`{skills-root}/eque2-code-goal-gate/acs-format-check.sh`. Anti-patterns
to refuse, and the per-agent invocation map for running this under
Claude Code or Codex, are `references/anti-patterns.md` and
`references/agent-mapping.md`.

## Output shape

Success, all inside the worktree's `X.goal/`:

1. `goal.md` — the charter, opening with the auto-start banner, linking
   its criteria as `./ACs.md` (relative — the folder moves as a unit).
2. `ACs.md` — the approved acceptance contract, with the banner and any
   appended criteria, still valid under `acs-format-check.sh
   --authoring`.
3. `spec/` + `MANIFEST.md` — the SPEC with provenance (heavy lane), or
   a manifest that honestly records no spec pipeline (light lane).
4. `CLAUDE.md` + `AGENTS.md` — the auto-start instructions **plus the
   worktree-switch block naming this goal's worktree root**, per
   `references/emitted-charter.md` §0/§0a.
5. The `.moved` stub in the main checkout (worktree case), and the
   journal entries per phase.
6. **The hand-off (Phase H)**: name the worktree and the folder this
   run actually produced, and tell the reader to open a **fresh
   context** there — where the folder starts itself.

**This skill never executes the charter and never starts the loop.**
A run that ends without `goal.md` and `ACs.md` on disk is a failed
run, reported as such — a run that produced no
folder emits no hand-off; it reports what is missing instead.
