# The stage-1 documents — `plan.md`, `decisions.md`, `ACs.md`

Normative for stage 1. The fixed shapes are what let stage 2 bind the
plan, the gate enforce the criteria, and the status scan count them — a
free-form plan is prose, and prose cannot be re-hashed, bound, or
refused precisely.

Three documents, one job each:

| File | Answers | Read by |
|---|---|---|
| `decisions.md` | **What** gets built, and why this way | stage 2 (SPEC input), stage 3 (the build honours it) |
| `ACs.md` | **When** it is done | the stop gate, every stage |
| `plan.md` | **How** the work runs — lane, worktree, which workflow in which stage | stage 2 (binds it), `[ST]` |

The user approves all three at once, and the `.approved` marker hashes
all three. Nothing is restated across them: a fact lives in one file and
the others link to it.

## `plan.md` — the index and the execution plan

`plan.md` opens with the links, then carries these sections, once each,
in this order:

```markdown
# Plan — <task name>

- Input: [`./<prompt-file>`](./<prompt-file>)
- Technical decisions: [`./decisions.md`](./decisions.md) (<N> decisions)
- Acceptance criteria: [`./ACs.md`](./ACs.md) (<N> criteria)

## Stage sequence
## Lane
## Worktree
## Declined workflows
## Skill availability
```

- **Stage sequence** — a table, one row per workflow run, in run order:

  ```markdown
  | Stage | Workflow | Serves |
  |---|---|---|
  | 2 | `bmad-ux` | D1 |
  | 2 | `eque2-code-create-spec` `[CS]` | D3 |
  | 3 | `eque2-code-develop-spec` `[DS]` | D3 |
  | 3 | `bmad-build` | D1, D2 |
  ```

  This table is the binding stage 2 executes. Every decision appears in
  at least one row. A workflow the disk check did not find is marked
  **NOT INSTALLED** in its row.
- **Lane** — light or heavy, and which lane conditions triggered it.
- **Worktree** — the decided path and branch (`goal/<slug>`), or an
  explicit "none, and why". Stage 1 decides here; stage 2 creates it.
- **Declined workflows** — every heavyweight workflow not selected, with
  the reason. A declined workflow is a recorded decision, not an
  omission. "None declined" is valid on a heavy-lane plan that uses them
  all.
- **Skill availability** — the result of the disk check, naming anything
  NOT INSTALLED and its alternative. "All named skills installed" is the
  happy entry.

## `decisions.md` — the technical decisions

Areas are `##` headings. Decisions are `###` headings inside their area,
numbered `D1`, `D2`, … across the whole file — the number is how the
plan and the ACs refer to a decision. **All four fields appear in every
Decision, in this order, with no omissions.**

```markdown
## <Area>

### D<n>: <the thing being decided>

**Choice** — what will be done, in one sentence.

**Justification** — why this over the alternatives.

**Alternatives** — what else was considered and why not. "None
credible" is a valid entry; an empty field is not.

**Verified by** — the AC(s) that prove the choice was honoured, e.g.
`AC 3`. Or "none — <reason>" when the choice has no observable result
(a naming convention nobody can test is a legitimate "none").
```

The heading word is **D<n>** — a decision, not a recommendation, because
the stages bind it. An approved decision is a contract, and later stages
execute it without re-litigating.

The file ends with one **Research** section: findings from any research
run in stage 1, inline, or "No research needed" with one line of why.

### Worked example

```markdown
## UI Changes

### D1: the vector-search results panel

**Choice** — Build the panel as a new screen, following the existing
results layout rather than inventing one.

**Justification** — A precedent layout exists, so it needs adapting,
not designing.

**Alternatives** — A tab inside the existing search page. Rejected: the
results need the full width.

**Verified by** — AC 2.

### D2: the empty-state treatment

**Choice** — Reuse the existing empty-state component unchanged.

**Justification** — One file, no new dependency, no new pattern.

**Alternatives** — None credible.

**Verified by** — AC 3.

## Database

### D3: the vector index

**Choice** — Add `pgvector` to the existing PostgreSQL instance.

**Justification** — Research confirmed `pgvector` covers the recall
target without a second data store.

**Alternatives** — A dedicated vector store. Rejected: a second store to
operate, for a corpus this size.

**Verified by** — AC 4.

## Research

`bmad-deep-recon` (technical), 2026-09-29: `pgvector` HNSW recall at
this corpus size is 0.97 against the 0.95 target. …
```

## `ACs.md` — the acceptance contract

Written from `{skills-root}/eque2-code-prepare-goal/assets/ACs-template.md`,
in the format `{skills-root}/eque2-code-prepare-goal/references/acs-format.md`
defines — the same file the stop gate enforces in stage 3. Stage 1 writes
it; later stages never remove or reword an approved criterion.

Three kinds of criterion, together:

1. **User outcomes** — one per concrete outcome the input asks for.
2. **Decision criteria** — one per decision whose **Verified by** is not
   "none". The criterion text starts with its tag, `[D<n>]`, and states
   the observable consequence of the choice — never "D3 was followed":

   ```markdown
   - [ ] [D3] Similarity search runs on the pgvector index — `db/migrations/0042_vector_index.sql`
         - explanation: not built yet.
   ```

   The checker reads only the **first** backtick span as the specified
   system, and that span must hold a `/` or a `.`. Keep other names in
   the text unquoted.

3. **The quality gate** — the codebase's real lint, type-check, and
   tests. Mandatory.

Number the criteria in reading order (AC 1 is the first checkbox) — that
is the number `decisions.md` cites. Do **not** add the auto-start banner:
the folder is not startable until stage 2 writes `goal.md`, and stage 2
adds the banner then. Validate before presenting:

```bash
bash {skills-root}/eque2-code-goal-gate/acs-format-check.sh --authoring <goal-folder>/ACs.md
```

Non-zero exit → fix the file, not the checker.

## Ready to present

A set missing a `plan.md` section, a decision missing a field, a
decision whose **Verified by** names an AC that does not carry its
`[D<n>]` tag, or an `ACs.md` the checker refuses, is not ready — fix the
documents, not the reader's expectations.
