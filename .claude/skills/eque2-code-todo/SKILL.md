---
name: eque2-code-todo
description: >
  Capture a TODO as a grounded, prepare-goal-ready brief — interview the
  requester, probe the codebase for real file paths and current
  behaviour, and write `_bmad-output/todos/<slug>.md` so a fresh context
  can pick it up cold. Also lists the open backlog and marks TODOs done.
  Triggers on: "add a TODO", "capture a TODO", "note this for later",
  "make a TODO for X", "park this", "add to the backlog", "what's on the
  TODO list", "show the backlog", "mark that TODO done",
  "/eque2-code-todo". Use whenever something worth doing surfaces
  mid-session and should be captured for a later prepare-goal run rather
  than done now. Do NOT use for work being done right now (just do it),
  for stable facts (that's memory), or for run outcomes (that's the
  journal skill).
---

# TODO Skill — capture work as a prepare-goal input

A TODO here is **not a one-liner**. It is a brief written so that an agent
opening it months later, with zero session context, knows what to build,
why, where the code is, and what "done" means. That is the whole point:
`eque2-code-prepare-goal` consumes the file as its idea document and emits
`<slug>.goal/` beside it.

**This skill writes the brief. It never implements it and never runs
prepare-goal.** If you find yourself editing product code, back out.

## Storage

```
_bmad-output/todos/
├── TODOS.md                  # index — one line per TODO, newest first
├── <slug>.md                 # the brief (prepare-goal input)
├── <slug>.goal/              # created LATER by prepare-goal — never by this skill
└── done/<slug>.md            # archived after the goal is pursued
```

`<slug>` is kebab-case, verb-led, and specific: `fix-verifier-stall`, not
`verifier`. It must end `.md` and must not end `.goal.md` — the goal-folder
resolver (`{skills-root}/eque2-code-goal-gate/goal-folder-path.sh`) rejects
those, and it is the thing that will consume this file.

## Verbs

| Verb | Trigger | Outcome |
|---|---|---|
| **create** (default) | "add a TODO for X" | interview → probe → write `<slug>.md`, index it |
| **list** | "show the backlog", "what TODOs are open" | print open TODOs from `TODOS.md` |
| **done** | "mark X done", "archive that TODO" | move to `done/`, flip `status:`, update index |

Ambiguous invocation with a description attached → **create**. Bare
invocation with no description → ask which verb.

---

## create

### 1 — Interview

Ask only what you cannot derive. Usually three questions, in one message:

1. **What should be true when this is done?** (one sentence — becomes the
   success criterion)
2. **Why now / what breaks without it?** (the motivation a fresh reader
   lacks)
3. **Where does this live?** (the area, feature, or file — enough to aim
   the probe)

Do **not** ask "what's out of scope?". Everything the request implies is in
scope — this mirrors prepare-goal's exhaustive-by-default rule, and asking
invites the requester to shrink the work before it is understood.

If the session already answered any of these, skip the question and say
what you inferred.

### 2 — Probe the codebase

This is what separates a usable brief from a sticky note. Before writing,
spend a few tool calls establishing ground truth in the area named:

- **Locate it.** Grep/glob for the feature, symbol, or behaviour. Read the
  files you find — enough to describe what happens today, not to fix it.
- **Cite it.** Every claim about current behaviour carries a
  `path/to/file.ts:123` reference. A brief that says "the verifier stalls"
  without naming the file has not done its job.
- **Find the quality gate.** Discover the repo's real lint / type-check /
  test commands (`package.json` scripts, `Makefile`, CI workflow) and name
  them — do not assume `npm test`. prepare-goal requires a quality-gate
  criterion and will otherwise have to rediscover this.
- **Check for duplicates.** Scan `_bmad-output/todos/*.md` and open
  `.goal/` folders. If this overlaps an existing TODO, say so and offer to
  extend that file instead of creating a rival.

Probe timebox: if ~10 tool calls have not located the area, write what you
have, and put the unresolved question in **Grounding** as an explicit
"start here" note. An honest gap beats a confident guess.

### 3 — Write

Copy `assets/todo-template.md` and fill every placeholder. Section rules:

- **Success criterion** — one sentence, testable, no "and".
- **Current behaviour** — what happens today, with file citations. If it
  does not exist yet, say "does not exist" and cite where it would go.
- **Desired behaviour** — the end state, in the present tense.
- **Done when** — 3–7 checkboxes, each demonstrable in a conversation
  ("running `X` prints Y"), not aspirational ("code is clean"). These
  become prepare-goal's Done-when checklist, so a vague one here poisons
  the whole downstream run. Always include the discovered quality-gate
  line.
- **Observability** — what the change should log or expose. prepare-goal
  designs this in before feature work; seed it here. "None beyond existing
  logging" is a valid answer, written explicitly.
- **Scope** — leave the carve-out list empty unless the requester named a
  hard external blocker (missing creds, embargoed dep, unavailable env).
  Convenience is not a blocker.
- **Grounding** — the map for a cold reader: the files that matter and
  why, related TODOs/specs, prior journal entries, anything already ruled
  out. Link with repo-relative paths.

Then append one line to `TODOS.md`, newest first:

```markdown
- [ ] [<title>](<slug>.md) — <success criterion, trimmed> · <YYYY-MM-DD>
```

Create `TODOS.md` with an `# eque2-code TODO backlog` heading if absent.

### 4 — Report

Print the path written and the exact hand-off command:

```
/eque2-code-prepare-goal @_bmad-output/todos/<slug>.md
```

Say plainly that it should be run from a **fresh context** — the brief was
written so the session that produced it is not needed. Do not run it.

---

## list

Read `TODOS.md`. Print open entries (unchecked) with title, one-line
criterion, and age. Note any that already have a sibling `<slug>.goal/` —
those are prepared and awaiting `pursue-goal`, not awaiting preparation.
If `TODOS.md` is missing or empty, say the backlog is empty.

## done

1. Confirm which TODO (match on slug or title; ask if ambiguous).
2. `git mv` the file to `_bmad-output/todos/done/<slug>.md`, creating
   `done/` if needed.
3. Set `status: done` in its frontmatter and add `completed: <YYYY-MM-DD>`.
4. Tick the `TODOS.md` line and move it under a `## Done` heading.

Leave any `<slug>.goal/` folder where it is — it belongs to prepare-goal
and moving it breaks the relative links inside it. Note in the report that
the goal folder stayed put.

## Anti-patterns

- Writing a one-line TODO because the requester gave one line — the brief
  is the deliverable; elaborate it.
- Implementing the TODO "while you're in there".
- Creating `<slug>.goal/` — that is prepare-goal's output, not yours.
- Inventing Done-when criteria that cannot be demonstrated.
- Volunteering out-of-scope carve-outs to make the TODO look tidy.
