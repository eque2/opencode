# The `X.goal/` folder-layout contract

Normative. Every artefact `prepare-goal` produces for a workstream lives inside a
single sibling folder, so the workstream is self-contained and portable.

Supports **S1** (a prepared idea document gains a self-contained sibling goal
folder) and **S2** (no workstream artefact is left scattered outside it, and the
folder moves as a unit).

---

## 1. Derivation

For an idea document `X.md`, the goal folder is `X.goal/`, created **as a sibling
of `X.md`** — the same filesystem directory, never a subdirectory of it and never
a parallel tree elsewhere.

```
ideas/
  X.md            <- the idea document
  X.goal/         <- its goal folder (sibling, same level)
```

**Naming rule.** The folder name is the document's basename with **only the final
extension** removed, plus the literal suffix `.goal`.

| Idea document | Goal folder | Note |
|---|---|---|
| `X.md` | `X.goal/` | the ordinary case |
| `a.b.md` | `a.b.goal/` | only the last extension is stripped |
| `notes/deep.md` | `notes/deep.goal/` | sibling in the document's own directory |

**Input rules.**

- The idea document MUST be an existing regular file with a `.md` extension.
- A path with no extension, a non-`.md` extension, an empty path, a path naming a
  directory, or a path naming a file that does not exist is **rejected**. There is
  no default and no inference.

## 1a. The worktree

The goal folder lives inside a **git worktree of its own**, on branch `goal/<slug>`,
created by prepare-goal's pre-flight. The idea document is brought into the worktree
and the goal folder is derived from that copy.

**The invariant is that the main working tree is not disturbed** — nothing is written
into it and its branch, index, and working state are left exactly as found.

*Where* it goes is fixed, not discovered: `{project-root}/.claude/worktrees/<slug>`
— inside the repository, in the agent-managed worktree root that `[DS]` develop-spec
already uses and that git excludes. A Codex-only install (skills at `.agents/skills/`,
no `.claude/`) uses `{project-root}/.agents/worktrees/<slug>`. A **sibling directory of
the repository is never the answer**, and neither is any other path outside it. Two
things override the default, in this order: a path the user named in the request, then
`git config eque2.worktreeRoot` when the repo sets one. Pre-flight creates it with

```
# keep the nested worktree out of both trees' git status
EX="$(git rev-parse --git-common-dir)/info/exclude"
grep -qxF '/.claude/worktrees/' "$EX" || echo '/.claude/worktrees/' >> "$EX"
git worktree add .claude/worktrees/<slug> -b goal/<slug>
```

and names the chosen path in the hand-off.

### A dirty main checkout — ask, never decide

The new worktree branches from `HEAD`. **Uncommitted work in the main checkout does
not come with it**, so a goal prepared over a dirty tree builds against a base the
user believes is there and is not — the failure surfaces much later, as code that
mysteriously does not exist. Before `git worktree add`, run
`git status --porcelain -- . ':(exclude)_bmad-output/goals/<slug>.goal'` in the main
checkout — the goal folder itself is always "dirty" at this point and is about to be
moved, so it never counts. Anything else → **stop and ask the user**, listing the
paths (a `--stat` summary when the list is long):

> The main checkout has N uncommitted change(s). The worktree branches from `HEAD`,
> so this work will NOT be in it.
> - **[C] Commit them first (recommended)** — the goal branches from a complete base.
> - **[B] Bring them along** — I stash them here and apply the stash in the worktree.
>   Use this when the changes ARE the starting point for this goal.
> - **[P] Proceed without them** — the goal branches from `HEAD` as it stands.
> - **[X] Cancel** — nothing is created.

Never pick for the user, and never commit their work on your own initiative. Record
the answer in the journal, and name it in the hand-off (`[P]` especially, so the
absent work is on the record). Untracked files that git already ignores do not count
as dirty and never trigger this.

Not a git repo, or the worktree cannot be created → prepare in place and record that
in the journal. Do not `git init` one, and never switch the main tree's branch as a
substitute — that is the disturbance the worktree exists to avoid.

## 2. Contents

`X.goal/` is the whole workstream:

| Artefact | Purpose |
|---|---|
| `<prompt-file>` | the original input, verbatim (stage 1) |
| `plan.md` | index + execution plan: stage sequence, lane, worktree (stage 1) |
| `decisions.md` | the approved technical decisions, `D1`..`Dn` (stage 1) |
| `ACs.md` | the acceptance-criteria checkbox file — the acceptance contract (stage 1; stage 2 adds only) |
| `.approved` | the approval marker, hashing the three stage-1 documents |
| `goal.md` | the hardened charter (stage 2) |
| `spec/` | the SPEC artefacts, written here directly by the pipeline (see §5) |
| `MANIFEST.md` | the SPEC's provenance |
| `CLAUDE.md`, `AGENTS.md` | auto-start instructions — opening the folder invokes `pursue-goal` |
| everything else | journal, research, review reports — all workstream output |

**No artefact produced for the workstream may be written outside `X.goal/`.** That
includes the SPEC: the pipeline is pointed at `X.goal/spec/` and writes there, so
nothing is left in `_bmad-output/features/<slug>/` or anywhere else. §5 covers the
one fallback, for a pipeline that genuinely cannot be redirected.

## 2a. The folder starts itself

**Referring to the folder is enough.** A path ending in `.goal` is a trigger for
`pursue-goal`: naming it, pasting it, or attaching it IS the request to execute it,
because there is nothing else one does with a prepared goal folder.

The folder then repeats that instruction wherever a reader might land, so a reference
the agent goes on to *read* does not read as a description. Four copies of one
sentence — *this is a prepared goal folder, invoke `eque2-code-pursue-goal` on it
now, before anything else, without waiting to be asked*:

| Where | Covers |
|---|---|
| banner atop `goal.md` | someone opens the charter |
| banner atop `ACs.md` | someone opens the criteria |
| `CLAUDE.md` | Claude Code, folder as working directory |
| `AGENTS.md` | Codex and other agents, same |

The redundancy is the point: an instruction present only in the file the reader did
not open is not an instruction.

This does not weaken the fresh-context rule — it is what makes it cheap. The folder
starts itself for whoever opens it NEXT; the preparation run still never starts it.

A run that did not land `goal.md` and `ACs.md` does **not** get these files. A folder
that auto-starts work against a half-written contract is worse than one nobody opens.

## 3. Collision rules

Collisions are **explicit and fail closed**. Nothing is overwritten, merged, or
silently reused under a different name.

1. **Reserved `.goal` stem.** An idea document whose stem already ends in `.goal`
   (e.g. `X.goal.md`) is **rejected**. Deriving `X.goal.goal/` would be ambiguous
   with an existing goal folder, so the suffix is reserved.
2. **Target exists and is not a directory.** If `X.goal` exists as a file, symlink,
   or anything other than a directory, the operation **fails**. The existing entry
   is left untouched; no alternative name is invented.
3. **Target exists as a directory.** Reused as-is — creation is idempotent. An
   existing `X.goal/` is the workstream's folder, not an error.
4. **Target directory not writable.** Fails. A folder that cannot receive artefacts
   is not a usable goal folder.
5. **Parent directory not writable.** Fails, and the failure is reported — never
   swallowed, never degraded into "resolved but empty".

Every one of these resolves an unknown to *not done*, per the fail-closed rule.

## 4. Relative internal references

**Every reference from one artefact inside `X.goal/` to another MUST be relative to
the referring file.** This is precisely what makes S2's "moves as a unit" true: an
absolute path, or a path reaching up out of the folder, breaks the moment the folder
is relocated, renamed, copied into another repo, or archived.

- `goal.md` links its acceptance contract as `./ACs.md`, never `/Users/…/ACs.md`
  and never `../X.goal/ACs.md`.
- Artefacts inside subfolders refer upward within the folder only (`../ACs.md`).
- References that must point OUTSIDE the folder (an upstream repo path, a pipeline
  output location) are recorded in `MANIFEST.md` as data, not embedded as links in
  the artefacts — so the folder stays movable and the external couplings stay
  visible in one place.

The resolver in §6 never depends on the caller's working directory: resolution of a
relative input path yields the same absolute sibling folder as the equivalent
absolute input.

## 5. The SPEC — in place by default, mirrored only as a fallback

**Default: the spec pipeline is pointed at `X.goal/spec/` and writes there.** There
is then no external directory, nothing is left in `_bmad-output/`, and `spec/` IS the
canonical source. `X.goal/MANIFEST.md` records exactly that, because `pursue-goal`
refuses a `spec/` whose origin nothing states — "it was authored here" is a
provenance claim like any other.

**Fallback: mirror.** Some pipeline may own an output path this feature must not
redirect. Then its artefacts are copied into `X.goal/spec/` and the manifest records
the canonical path of each copy; the pipeline path stays authoritative for the build
and the copy is what makes the folder self-contained. Reaching for this is a finding
to record in the journal, not the normal course — and never a way to run the pipeline
somewhere else and tidy up afterwards. A spec that was written into `_bmad-output/`
at any moment is a document in the wrong place, whatever happens to it next.

**Normative implementation:** `{skills-root}/eque2-code-goal-gate/mirror-spec.sh`.

```
mirror-spec.sh in-place <goal-folder>
mirror-spec.sh mirror   <goal-folder> <pipeline-dir>
mirror-spec.sh mirror   <goal-folder> <slug>=<dir> [<slug>=<dir> ...]
mirror-spec.sh verify   <goal-folder>
```

Run `in-place` (or, in the fallback case, `mirror`) as the completion step of a
preparation run, before the hand-off. Compose neither the copy nor the manifest by
hand. `verify` on an in-place manifest confirms `spec/` is non-empty and returns —
there is no copy→source comparison to make, and an in-place manifest over an empty
`spec/` is the same lie an empty mirror would be. A manifest claiming both in-place
and an external source is refused rather than silently resolved.

A **multi-epic** goal has more than one canonical source — one
`_bmad-output/features/<slug>/` per epic. Mirror each under its own
`spec/<slug>/` subtree with the labelled `<slug>=<dir>` form; the manifest then
records one `**Source \`slug\`:**` block per epic and `verify` drift-checks each
subtree against its own source. The single-source form above is unchanged for a
one-epic goal. Do not hand-author a multi-source manifest — a labelled block the
tool did not write is exactly the provenance-that-lies the mirror exists to
prevent.

| Exit | Meaning |
|---|---|
| `0` | mirrored, or verified with no drift |
| `2` | invalid input, or an absent/empty manifest — an empty manifest asserts a mirror with no provenance |
| `3` | the pipeline path is missing, unreadable, or produced no files |
| `4` | drift — a mirrored copy no longer matches its source |
| `5` | filesystem failure |

**Drift is reported, never repaired.** A copy that no longer matches its source is a
question about which one is current, and overwriting either destroys the evidence
needed to answer it. The source wins; the disagreement gets resolved deliberately.

**State-machine runtime is not mirror drift.** When the state CLI operates on
`X.goal/spec/`, it creates runtime-only paths there: `state/`,
`.state-events.jsonl`, `.signer-key` (and legacy `.evidence-key`), plus
`journal/task/` and `journal/transcripts/`. `verify` and `mirror` exclude only
those paths: they are not canonical create-spec artefacts and must not strand a
stalled goal on restart. Ordinary source-authored files — including other
`journal/` entries — remain mirrored and drift-checked.

**A mirror is never written empty.** A pipeline that produced nothing is reported as
exactly that, rather than leaving an empty `spec/` and a manifest claiming a source —
an empty directory and "the pipeline produced nothing" are different claims, and only
one of them is true.

## 6. Normative implementation

The rules above are executable, not prose. The single normative implementation is:

**`{skills-root}/eque2-code-goal-gate/goal-folder-path.sh`**

```
goal-folder-path.sh [--ensure] <idea-document-path>
```

- Without `--ensure`: pure resolution. Prints the absolute goal-folder path and
  creates nothing.
- With `--ensure`: resolves, then guarantees the folder exists as a writable
  directory, applying the §3 collision rules.

Failures print a `goal-folder:` diagnostic to stderr and exit non-zero:

| Exit | Meaning |
|---|---|
| `0` | resolved (and, with `--ensure`, exists and is writable) |
| `2` | invalid input — empty, no extension, not `.md`, reserved `.goal` stem, degenerate stem |
| `3` | input missing, a directory, or not a regular file |
| `4` | collision — `X.goal` exists but is not a directory |
| `5` | filesystem failure — unresolvable parent, mkdir refused, not writable |
| `64` | usage error |

The script may also be sourced; `goal_folder_path` and `goal_folder_ensure` are the
two entry points, and sourcing does not alter the caller's shell options.

**Path safety.** The document's parent directory is resolved physically before the
folder name is joined to it, so `..` segments collapse against the document's real
location. The result is always a sibling of the document and can never escape it.

## 7. Conformance

`{skills-root}/eque2-code-goal-gate/tests/test-goal-folder-contract.sh` is the conformance
suite for this contract. It runs the resolver across the happy path, invalid input,
boundary, empty/null, error-propagation, and security-boundary classes, prints a
PASS/FAIL line per test, and exits non-zero if any test fails. Changing this document
without changing that suite is a defect.
