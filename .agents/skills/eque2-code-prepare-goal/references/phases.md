# Stage-2 phases — from approved plan to executable folder

Detailed phase bodies for `prepare-goal`. The verbatim Phase E stamp
blocks live in `references/emitted-charter.md`; read them when you reach
Phase E. Each phase names the artefact it must leave on disk — verify it
exists before reporting the phase complete, and tell the user which
phase you are entering rather than silently chaining.

## Journalling (standing, applies to every phase)

Write a lightweight entry per executed phase into
`<goal-folder>/journal/`, linked from `<goal-folder>/JOURNAL.md`, and
keep `<goal-folder>/STATE.md` current — that is how a later run (or the
status scan) reads what happened without this conversation. A skipped
phase gets a one-line reason. If the `journal` skill is installed, use
it pointed at the goal folder; absent, write plain markdown entries by
hand in the same shape. Keep entries light — journalling is a record,
not a phase of its own.

## Pre-flight — the approval gate

Resolve the goal folder, require `plan.md`, `decisions.md`, and
`ACs.md`, require `.approved` (or the user's explicit `--force`,
recorded as OVERRIDE), and re-hash all three documents against the
marker's hashes — the four checks in `SKILL.md` §"The
approval gate", in that order, before anything is created. A `.moved`
stub beside the folder means already-prepared: report the worktree it
names and stop.

The folder itself was created by stage 1 under the layout contract
(`references/goal-folder.md`); its collision and safety rules are
implemented by `{skills-root}/eque2-code-goal-gate/goal-folder-path.sh`,
and stage 3's starter resolves the folder with that same machinery — so
never rename the folder, strip its `.goal` suffix, or relocate it
outside the move this stage performs.

**Artefact:** none — this phase only refuses or admits.

## Phase 0.5 — Mechanism verification

The plan's Stage sequence bound each workflow; re-verify each bound skill
on disk now (`[ -d "{skills-root}/<skill-name>" ]`) — install states
change between approval and preparation. Every verified mechanism is
what Phase E stamps into the charter's Build-via directive as the
**Phase 0.5 resolved** mechanism. A bound skill now missing, or one the
plan marked NOT INSTALLED, is a refusal for that row: surface it to
the user with the plan's named alternative; never substitute silently.

**Artefact:** the resolved mechanism list, recorded in the journal
entry.

## Phase W — Worktree, move, stub

Create the decided worktree (branch `goal/<slug>`, path per the plan's
Worktree section and the convention in `references/goal-folder.md`
§1a). **First check the main checkout for uncommitted work
(`git status --porcelain`) and, if there is any, put the choice to the
user** — commit / bring along / proceed without / cancel, per §1a. The
worktree branches from `HEAD`, so this is the last moment that work can
be carried in. Move the goal folder into it at the identical relative path
(`_bmad-output/goals/<slug>.goal/`), commit on the branch, and write the
`<slug>.moved` stub in the main checkout — the exact stub shape is in
`SKILL.md`. From here on, work only in the worktree copy.

No-worktree case (plan said none / not a git repo / creation failed):
prepare in place, no stub, record the fallback in the plan's Worktree
section and the journal.

**Artefact:** the worktree with the folder committed on `goal/<slug>`,
plus the stub — or the recorded in-place fallback.

## Phase B — Build what the plan bound

Run the Stage sequence's stage-2 workflows, every one pointed **into the
goal folder**, with `decisions.md` and `ACs.md` as their input:

- **SPEC** (heavy lane): run `[CS]` create-spec with its output directed
  at `X.goal/spec/`, then `mirror-spec.sh in-place <goal-folder>` to
  record provenance in `MANIFEST.md`. If a pipeline genuinely cannot be
  redirected, mirror its output instead (`mirror-spec.sh mirror`) and
  record that as a finding in the journal — the fallback, never the
  normal course (`references/goal-folder.md` §5).
- **Design / requirements** work the plan bound (`bmad-ux`,
  `bmad-prd`, `bmad-create-epics-and-stories`, …): same rule — artefacts
  land inside the folder, referenced relatively.
- **Light lane**: none of the above run. The approved `ACs.md` is the
  whole contract, and `MANIFEST.md` records "no spec
  pipeline" honestly. `mirror-spec.sh` is a no-op with nothing to
  mirror — never fabricate an empty `spec/`.

Approved decisions (`decisions.md`) bind BOTH the charter and the
SPEC — a spec that contradicts an approved `D<n>` is a defect to fix
here, not downstream. Where the SPEC surfaces a new success condition,
append a criterion to `ACs.md` under the add-only rule in `SKILL.md`.

**Artefact:** `spec/` + `MANIFEST.md` (heavy), or the honest manifest
(light); journal entries per workflow run.

## Phase E — Emit the charter and the acceptance contract

THE deliverable. Write, inside the goal folder:

- **`goal.md`** — the hardened charter: the auto-start banner as its
  very first lines, the status header, the Build-via directive naming
  the Phase 0.5 resolved mechanism, the run-autonomously (YOLO)
  directive with its canary gate, the story/task list from the plan,
  the link to the approved decisions as `./decisions.md`, and the link
  to its criteria as `./ACs.md`. All stamp blocks verbatim
  from `references/emitted-charter.md`. The checklist is LINKED, never
  restated — two copies drift.
- **`ACs.md`** — stage 1 wrote and the user approved it. Prepend the
  auto-start banner and append any criteria Phase B surfaced — nothing
  else (the add-only rule in `SKILL.md`). Confirm the approved content
  still carries the mandatory quality-gate criterion (the codebase's
  real lint + type-check + tests); if it does not, append one.
  Validate before moving on:

  ```bash
  bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh --authoring <goal-folder>/ACs.md
  ```

  Non-zero exit → fix the file, not the checker.
- **`CLAUDE.md` + `AGENTS.md`** — the auto-start instructions for
  whichever agent opens the folder next, followed by the
  worktree-switch block that names this goal's worktree root, resolved
  from disk (shapes in `references/emitted-charter.md` §0 and §0a).
  Written only when `goal.md` and `ACs.md` both landed — a folder that auto-starts against a
  half-written contract is worse than one nobody opens.

Every reference between artefacts inside the folder is **relative** —
that is what lets the folder move as a unit, and it is why the stub can
point at a worktree that may later be relocated wholesale.

**Artefact:** `goal.md`, `ACs.md`, `CLAUDE.md`, `AGENTS.md`, all
verified on disk.

## Phase R — Adversarial contract review

Review the contract this run produced — the charter, the criteria, and
the SPEC where one exists — before handing it off: an unreviewed
contract is one whose gaps the owner discovers mid-build. Fan out the
review lenses (`bmad-code-review` / `bmad-review` with the adversarial
and edge-case-hunter lenses) where installed; a single rigorous
critical pass where not. Findings are **applied in this same run** and
re-validated as landed — a report that lists problems and leaves them is
a failed Phase R. A finding against an approved criterion or decision is
the exception: apply it only by appending a criterion; if it needs a
removal or a rewording, stop and put it to the user. Scale the depth to the lane: a light-lane contract
earns one pass, not a panel.

**Artefact:** the findings report in `<goal-folder>/reviews/`, findings
applied.

## Phase H — The hand-off (the last thing the run does)

Name what was produced: the worktree path and branch, the goal folder
inside it, and the outstanding-criteria count. The folder named is the
**path this run actually produced** — resolve it from disk at hand-off
time, never emit a template or example path, and on a re-run name the
folder as it now stands, never a stale path from an earlier run. Quote
the path whenever it contains spaces or non-ASCII characters, so the
reader's copy-paste survives it. Tell the reader to open a
**fresh context** with that folder (or worktree) as the working
directory — where the folder starts itself — or to run `pursue-goal`
on it there.
Then stop: **do not invoke `pursue-goal` yourself**. The auto-start
files fire for whoever opens the folder NEXT; a preparation run that
reads its own output and starts anyway has routed around the
fresh-context rule, and inheriting the preparation conversation is
exactly what that rule exists to prevent.

A run that produced no folder emits NO hand-off. If the run is
blocked, or Phase E did not land, report what is missing and what was
attempted — an invitation to pursue a half-written contract is worse
than no invitation.
