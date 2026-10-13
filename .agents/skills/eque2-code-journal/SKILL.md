---
name: eque2-code-journal
description: >
  Per-workstream run journal — captures the outcome of a process run
  (spike, investigation, training job, deploy, experiment) so that
  subsequent runs of the same workstream can be briefed on what was
  tried, what worked, what failed, and what to do differently. Triggers
  on: "journal this", "journal the outcome", "log this run", "record
  this spike", "what did we learn last time about X", "brief me from the
  journal", "/journal", "/journal-read". Always invoke this skill when
  the user wants to capture a process outcome for future runs or wants
  to be briefed from prior runs — do NOT use the memory system for
  per-run outcomes (memory is for stable facts; journals are for
  chronological run logs).
---

# Journal Skill — Per-Workstream Run Log

## When to use

Invoke this skill in two situations:

1. **Write** — a process run has just finished (a spike, investigation,
   training job, deploy, experiment, refactor attempt) and the user
   wants to capture the outcome so the next run benefits. Triggers:
   "journal this", "log this run", "record the outcome".

2. **Read / brief** — a process is about to run again and the user
   wants to be briefed from prior runs. Triggers: "what did we learn
   last time", "brief me on the X journal", "before I re-run X, what
   happened last time".

Do NOT use for:
- Stable facts about user/project/preferences — that's `memory/`.
- One-off thoughts not tied to a workstream — that's just a note.
- Code-level details derivable from `git log` or the diff itself.

## Distinction from `memory/`

| Aspect       | `memory/`                          | `journal/`                          |
|--------------|------------------------------------|-------------------------------------|
| Shape        | Topical facts                      | Chronological run outcomes          |
| Indexed by   | Topic (user, feedback, project)    | Workstream slug                     |
| Read when    | Any time, opportunistically        | Start of a re-run                   |
| Written when | A fact emerges                     | A process run finishes              |
| Lifespan     | Until contradicted                 | Forever (history matters)           |
| Location     | `~/.claude/projects/.../memory/`   | `_bmad-output/journals/<slug>/`     |

If something is both a fact AND a run outcome (e.g. "Spike Y proved
approach Z is too slow — never re-try it"), write the journal entry
first, then ALSO save a `feedback` memory pointing at the journal
entry. The memory is the rule; the journal is the evidence.

## Storage layout

```
_bmad-output/journals/
├── <workstream-slug>/
│   ├── STATE.md                      # current snapshot — mutable
│   ├── JOURNAL.md                    # chronological index — append-only
│   ├── 2026-05-29-baseline-run.md    # one file per run
│   ├── 2026-05-27-broken-vm.md
│   └── 2026-05-25-first-attempt.md
└── <other-workstream-slug>/
    └── ...
```

- **Workstream slug** = kebab-case identifier for the recurring process
  (e.g. `phase2-v2-model-build`, `training-vm-disposability`,
  `bars-ingestion-spike`). One slug per recurring activity.
- **Entry filename** = `YYYY-MM-DD-<short-slug>.md`. Date first so
  `ls` sorts chronologically. Short slug captures the run's character
  ("baseline-run", "post-fix-validation", "preempted-twice").
- **`JOURNAL.md`** = per-workstream index. One line per entry, newest
  first. Append-only. Mirrors the pattern of `MEMORY.md` for the
  memory system.
- **`STATE.md`** = current snapshot of the workstream. Mutable;
  overwritten as facts change. Answers quick-fire "what's the state
  of X right now?" questions in under 5 seconds. See next section.

## State of play (`STATE.md`)

Each workstream maintains a `STATE.md` alongside `JOURNAL.md`. They
are complementary:

| File          | Shape           | Lifespan        | Answers                              |
|---------------|-----------------|-----------------|--------------------------------------|
| `JOURNAL.md`  | History (list)  | Append-only     | "What did we try and when?"          |
| `<entry>.md`  | History (run)   | Append-only     | "What happened on date X?"           |
| `STATE.md`    | Snapshot (now)  | Mutable         | "What's true about this workstream right now?" |

`STATE.md` is for quick-fire lookups: "how many models are in use?",
"which grid variant is currently frozen?", "is the v2 gate passed?",
"what's the current best IC?". The user should be able to open it
and answer "what's the state of X?" without reading any entry.

### `STATE.md` shape

The file is workstream-specific. Use the relevant subset of:

```markdown
---
slug: <workstream-slug>
updated: YYYY-MM-DD
last-entry: YYYY-MM-DD-<short-slug>.md
last-verdict: success | partial | failed | inconclusive
---

# <Workstream Slug> — State of Play

## Current state
- <Key fact>: <value>
- <Key fact>: <value>
- <Key fact>: <value>

## Counts
- <Thing>: <N>
- <Thing>: <N>

## Open questions
- <One-line question>
- <One-line question>

## Frozen decisions
- <Decision> (locked YYYY-MM-DD via [[entry-slug]])
- <Decision> (locked YYYY-MM-DD via [[entry-slug]])

## Active artefacts
- `<path>` — <one-line description>
- `<path>` — <one-line description>

## Next action
<One sentence — what the next run should do.>
```

Rules:
- **No history in `STATE.md`.** If a fact changes, overwrite the
  line. The journal entry that drove the change holds the receipt.
- **Every claim points back to its source.** Use `[[entry-slug]]` to
  link facts to the journal entry that established them, so future-
  you can verify.
- **Counts must be exact.** If you can't count them precisely (e.g.
  "3 models trained, 1 promoted, 1 rejected, 1 inconclusive"), say
  so explicitly — don't round or hand-wave.
- **`updated:` is the file mtime contract.** If someone reads
  `STATE.md` and `updated:` is older than the most recent
  `JOURNAL.md` entry, the state is stale and must be rebuilt.
- **Keep it under ~50 lines.** If `STATE.md` grows past that, you
  are mixing history into it. Move detail back into entries.

## `/journal write` — capture a run outcome

### Step 1 — Identify the workstream

If the user named it ("journal this for the phase2-v2-model-build
workstream"), use that slug. Otherwise infer from current context:

- Current branch name (e.g. `feat/ephemeral-training-vm` →
  `training-vm-disposability`)
- Active BMAD spec/PRD
- The user's recent activity

Confirm the slug with the user before writing if uncertain. Do not
silently invent.

### Step 2 — Locate or create the workstream directory

```bash
SLUG="<workstream-slug>"
WS_DIR="_bmad-output/journals/$SLUG"
mkdir -p "$WS_DIR"
```

If `JOURNAL.md` doesn't exist, create it with a one-line header.

### Step 3 — Draft the entry

Template:

```markdown
---
date: YYYY-MM-DD
workstream: <workstream-slug>
verdict: success | partial | failed | inconclusive
duration: <wall-clock if known>
---

# <Short title — what the run was attempting>

## Goal
<One sentence — what the run was trying to achieve.>

## Approach
<What was tried — bullet list of the key steps / parameters / decisions.>

## Outcome
<What actually happened. Numbers if applicable (rows processed, model
metrics, latencies). Verdict in one sentence at the end.>

## Surprises
<Things that didn't match expectations. Empty if none.>

## Next time
<Concrete changes for the next run. Prefixed with verbs: "Try X",
"Avoid Y", "Verify Z before starting".>

## Artefacts
- `<path>` — <one-line description>
- `<path>` — <one-line description>

## Links
- Related journal entries: [[YYYY-MM-DD-other-slug]]
- Related memory: [[memory-name]]
- Spec: `<path to spec>`
- Commit/PR: <SHA or URL>
```

Rules:
- **Verdict is mandatory.** A run with no clear verdict is
  `inconclusive` — say so, do not omit.
- **"Next time" must be actionable.** "Be careful" is not actionable.
  "Set `--batch-size 32` not 64 because OOM at minute 14" is.
- **Artefacts must be verifiable paths.** Per
  `feedback_verify_artefacts_before_claiming`, confirm each path
  exists before writing the entry — `ls` it.
- **Surprises are the most valuable section.** A run with no surprises
  is rare. Push the user to name at least one if they say "no
  surprises" — it usually means they haven't reflected.

### Step 4 — Write the entry file

`<WS_DIR>/<YYYY-MM-DD>-<short-slug>.md`

If a file already exists for today with the same slug, append `-2`,
`-3` etc. Never overwrite a prior entry — the history is the value.

### Step 5 — Update `JOURNAL.md`

Prepend a new line at the top of the entries list (newest first):

```markdown
- [YYYY-MM-DD <verdict>](YYYY-MM-DD-short-slug.md) — <one-line hook>
```

Keep the hook under ~100 characters. It is the only thing future-you
sees before deciding whether to open the entry.

### Step 6 — Update `STATE.md`

Reconcile the workstream's current state with what this entry just
changed. For each section of `STATE.md`:

- **Current state / Counts**: overwrite any line whose value
  changed. Add new lines for new facts. Remove lines for facts that
  are no longer true.
- **Open questions**: remove any question this entry answered. Add
  new questions it raised.
- **Frozen decisions**: append any decision this run locked in.
  Never edit or remove a prior frozen decision — if it's reversed,
  that's a new line ("X reversed — see [[entry-slug]]").
- **Active artefacts**: refresh the list. Remove paths that are
  superseded; add new ones this entry produced.
- **Next action**: overwrite with the top "Next time" item from this
  entry.
- **Frontmatter**: bump `updated:`, set `last-entry:` and
  `last-verdict:` to this entry.

If `STATE.md` does not exist yet, create it from the template above,
populating only what this entry establishes. Subsequent entries fill
in the rest.

**Verify after writing**: re-read `STATE.md` end-to-end and confirm
every claim still has a `[[entry-slug]]` link or a `(see entry)`
note. An unlinked claim is a future bug.

### Step 7 — Report

Tell the user: workstream slug, entry filename, verdict, the
one-line hook that landed in the index, and a one-line diff of what
changed in `STATE.md` (e.g. "models-trained 2 → 3, frozen-decision
added: grid variant C").

## `/journal read` — brief from prior runs

### Step 1 — Identify the workstream

Same as write step 1. If the user says "the spike journal" but there
are multiple workstreams, list them and ask which.

### Step 2 — Load the index

Read `<WS_DIR>/JOURNAL.md`. If it doesn't exist, tell the user there's
no prior journal for this workstream and offer to start one.

### Step 3 — Decide depth

- **Default**: load the 3 most recent entries in full.
- If the user asks for "everything", load all entries.
- If the user names a specific past run ("the one where the VM got
  preempted twice"), grep the index for the hook and load that entry.

### Step 4 — Brief

Summarise to the user in this shape:

1. **Last verdict**: <success/partial/failed/inconclusive> on <date>
2. **What worked** (drawn from the most recent successful entry):
   <bullets>
3. **What failed and why** (drawn from failed entries):
   <bullets>
4. **Open "Next time" items not yet addressed**: <bullets>
5. **Recurring surprises across runs**: <bullets>

The brief should be readable in under 30 seconds. If the user wants
the raw entries, point at the file paths.

## `/journal state` — show current state of play

Quick-fire lookup. Use when the user asks "how many X?", "what's
current?", "what's the state of <workstream>?", or "/journal state".

1. Identify workstream slug (same as write step 1).
2. Read `<WS_DIR>/STATE.md`. If absent, tell the user — and offer to
   rebuild it from the journal entries.
3. **Staleness check**: compare `updated:` in frontmatter with the
   date of the top line of `JOURNAL.md`. If `STATE.md` is older,
   warn the user and offer to rebuild before answering.
4. Print the relevant section verbatim. For "how many X?" questions
   that's the Counts section; for "what's frozen?" it's Frozen
   decisions; etc.
5. If the user asks a question `STATE.md` doesn't cover, fall back
   to reading the most recent journal entries and offer to add a
   line to `STATE.md` so the next lookup is a one-step read.

## `/journal rebuild-state` — rebuild `STATE.md` from entries

When `STATE.md` is stale, missing, or drifted from reality:

1. Identify the workstream slug.
2. Walk every journal entry in date order (oldest first).
3. For each entry, apply its effect to a running mental model of
   state (counts, decisions, artefacts).
4. Write the resulting `STATE.md` from scratch, with `updated:` set
   to today and `last-entry:` / `last-verdict:` set from the newest
   entry.
5. Diff the rebuilt file against the previous `STATE.md` (if any)
   and show the user what changed — a large diff means state had
   drifted and is now corrected.

This is also the way to bootstrap `STATE.md` retroactively if a
workstream existed before this skill did.

## `/journal list` — show what journals exist

```bash
ls -d _bmad-output/journals/*/ 2>/dev/null
```

For each workstream, show: slug, entry count, most recent verdict,
most recent date, and the `STATE.md` "Next action" line if present.

## Pre-flight checks

Before writing or reading:

- Working directory is the project root (so `_bmad-output/` resolves).
- `_bmad-output/` exists.
- Today's date is known — if the user gives a relative date ("from
  yesterday's run"), convert to absolute YYYY-MM-DD before writing.

If `_bmad-output/` doesn't exist, this isn't a BMAD-using project and
the user should set one up first. Tell them, don't improvise an
alternative location.

## Integration with other skills

- **`productionise`** — at the end of each productionise phase, write
  a journal entry for the workstream. The "Next time" section feeds
  the next productionise run.
- **`bmad-investigate`** — investigation reports land in
  `_bmad-output/`; mirror the key findings into a journal entry so
  future investigations of the same area get briefed.
- **`bmad-retrospective`** — retrospectives are the natural multi-run
  journal read. Use `/journal read` to load the source material before
  invoking `bmad-retrospective`.
- **`vm-observability`** — when a VM run fails and the observability
  skill diagnoses it, journal the diagnosis + the fix attempt.

## Anti-patterns (refuse these)

- Using the journal as a general note-taking surface — it is
  per-workstream, outcome-shaped. Random thoughts go elsewhere.
- Writing a journal entry without a verdict.
- Writing "no surprises, everything went fine" without pushing back —
  if the user reflects, there is almost always at least one
  un-noticed assumption that held or didn't.
- Overwriting a prior entry to "correct" it. Append a new entry that
  references the old one; do not rewrite history.
- Duplicating journal content into `memory/`. Memory points AT the
  journal entry (via `[[link]]`); it does not copy the content.
- Skipping `JOURNAL.md` updates. An orphan entry file with no index
  line is invisible to future briefs.
- Writing a journal entry without updating `STATE.md`. The state
  snapshot is the cheap-lookup surface; if it's not refreshed every
  write, it rots and becomes worse than useless.
- Putting history into `STATE.md` ("models trained: 3 (was 2, was
  1)"). The journal entries hold the history; `STATE.md` holds only
  current truth. Overwrite, don't accumulate.
- Letting `STATE.md` grow past ~50 lines. If it does, you are mixing
  history into it — move detail back into entries.

## Output shape

Success looks like:

- `_bmad-output/journals/<slug>/JOURNAL.md` exists and has the new
  entry as its top line.
- `_bmad-output/journals/<slug>/<YYYY-MM-DD>-<short-slug>.md` exists
  with all six sections filled (no empty headings — "n/a" is OK).
- `_bmad-output/journals/<slug>/STATE.md` exists, has `updated:`
  matching today, and reflects the post-entry truth. Every claim
  in it points back to a journal entry via `[[entry-slug]]`.
- All artefact paths in the entry AND in `STATE.md` verifiably
  exist.
- The user is told: slug, filename, verdict, one-line hook, AND a
  one-line state-diff summary.

For read mode: a five-bullet brief that fits on one screen, plus
pointers to the underlying entry files for deeper reads.

For state mode: the relevant `STATE.md` section verbatim, plus the
`updated:` timestamp so staleness is visible.
