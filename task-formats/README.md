# Task formats — six markdown representations of one task

The brief: [`../task-to-md.md`](../task-to-md.md). A TypeScript engine will execute tasks written as markdown.
The files are fixed; state lives elsewhere. This folder takes one real, meaty task, takes it apart, and writes it
six ways.

- [`model.md`](./model.md) — the engine's view: the TypeScript shape all six formats parse into, the state that
  stays outside the files, and where each field lives in each format.
- `1-` … `6-` — the formats, each with its own README (grammar, strengths, weaknesses).
- [`blend/`](./blend/README.md) — the recommended blend of formats 3, 4 and 5, specified for an engine: JSON
  Schemas for every file kind, numbered cross-file rules, and the parse into the engine's model.

## The example

vadz `provider-ordering-admin` (*Admin-configurable provider ordering per model*), parent task
**T2 — Implement services — source, routing semantics, dry run, attribution**:

| | |
| --- | --- |
| Subtasks | T2.1–T2.6 |
| Test cases | 37 |
| Scenarios it supports | 26 (shared with other phases) |
| Gates | BUILD-2 (type check), BUILD-4 (tests) |
| Depends on | T1.1, T1.2, T1.3, T1.4, T1.6 |

T2 is a good test of a format because every subtask changes existing behaviour rather than adding new code;
the verification needs differ by subtask (concurrency in T2.2, money in T2.4, atomicity in T2.6); its
dependencies cross into phase 1; and its scenarios are shared with phases 1, 3, 4 and 5.

Source: `~/Projects/vadz/_bmad-output/features/provider-ordering-admin/` — `tasks.md`, `context.md`,
`coverage.md`, `scenarios.gherkin`, `definitions.json` — produced by eque2-code's create-spec workflow and
executed by its develop-spec workflow (all 28 tasks and 60 scenarios ended trusted).

The text in every format is quoted from those files. The structure is the aspirational part. All six formats
were rendered from one shared model, so they hold the same content and compare like for like.

## Anatomy — what a task is made of

What create-spec writes, what develop-spec consumes, and where each part lives today.

| Component | What it is | Where eque2-code holds it today | In `definitions.json` |
| --- | --- | --- | --- |
| Identity | id + imperative title | `tasks.md` heading | `id`, `description` |
| Hierarchy | parent groups subtasks (a phase) | `### T2` heading | `parentTasks`: id, description, phase only |
| Goal | why — one outcome sentence | `**Goal:**` | — |
| Order | tasks that must finish first | `**Depends On:**` | `dependsOn` |
| Touch set | files, change kind, what changes | `**File:**` (one value) + `context.md` §4 | — |
| Approach | guidance for the builder | `**Notes:**` | — |
| Preserve | behaviour that must not change | `context.md` §4 *Preserve* column, notes | — |
| Must not | forbidden changes | notes prose ("Do not modify …") | — |
| Scope boundary | work a sibling owns | notes prose ("The short-circuit itself is T2.5") | — |
| References | decisions, review findings, assumptions, standards | notes, `context.md` §2 and §5, `coverage.md` §2 | — |
| Test cases | categorised, task-local proof obligations | `**Test Cases:**` | — |
| Test binding | which tests prove the cases | `**Tests:**` — one file + `(full suite)` | `tests` |
| Supported scenarios | shared acceptance outcomes | `**Supports:**` | `supportsScenarios` (mixed with build checks) |
| Gates | build and quality checks | `@build` scenarios + `context.md` §7 | `buildChecks` (prose "commands") |
| Verification policy | red-first, structural check, review, independent verdict, evidence, budgets | develop-spec prompts and the state CLI | — (implicit) |
| Rejection rubric | what does not count as proof | nowhere — each verifier improvises | — |

What is state, and therefore out of the files: status, attempt number, idempotency key, evidence (tests
passed, commit), trust level, review result, retry count, verdicts and their reasons, journals. eque2-code keeps
these in `state/snapshots/` and `state/events.jsonl`; see [`model.md`](./model.md) for the separate state
shape.

## What the real files taught us

These findings shaped every format. Each one is visible in the vadz files.

**Drift between copies**

1. `definitions.json` and `tasks.md` disagree. `tasks.md` lists S57 and S59 under T2.2 and S58 under T2.6;
   `definitions.json`, which the state CLI reads, does not. → One source: the engine parses the markdown.
2. One scenario, three test paths. `definitions.json` says `infra/cloud-run/verify-provider-ordering-admin-S25.spec.ts`,
   `tasks.md` says `libs/media/src/…`, and the repo has `libs/media/src/tests/…`. S57 has no file of its own:
   blocks titled with S57 inside the S39 and S14 files prove it. → Bind proof by id tag in the test title; a
   path is only a hint.
3. The task list and the task detail disagree. T2.3 depends on T1.3 and T1.6 in the table but only T1.3 in its
   detail block and in `definitions.json`, so T2.3 could start before the serve-nothing set (T1.6) exists. →
   The formats use T1.3, T1.6, and each fact is written once.

**Missing structure**

4. Most of a task is prose the engine cannot see. `definitions.json` keeps id, description, phase,
   `dependsOn`, `supportsScenarios` and `tests`; goal, files, test cases and notes exist only in `tasks.md`.
5. The touch set is under-declared. `File` holds one value. T1.6's notes change `routing-policy.ts`, but its
   File lists only the schema file. T2.2's notes need the swap in `routing-policy.ts` to refuse older
   revisions, but T2.2's File omits it, while T2.1 says "Do not modify `routing-policy.ts`" without saying the
   rule is T2.1's alone. → `touches` is a list; T2.2 lists `routing-policy.ts`; every rule is scoped to its task.
6. Two kinds of verification share one list. `supportsScenarios` mixes scenarios (S21) with build checks
   (BUILD-2), and the build checks' "commands" are prose ("Type check passes"); the real gate,
   `pnpm nx run-many -t lint typecheck test-ci …`, is only in `context.md` §7. → `supports` and `gates` are
   separate; gates carry real commands.
7. Nothing links a test case to the test that proves it. Test titles say "(boundary)" or "an empty table", so
   the verifier maps cases to tests by reading. → Case ids (`T2.1.c4`) in test titles make the mapping
   mechanical.
8. The verification procedure is invisible to the task. Red-first, review, independent verdicts and budgets
   live in workflow prompts, so a task cannot ask for more (S51 needs a deployed service) or say what a weak
   proof looks like. → A declared policy with per-task overrides, and a rejection rubric per task.

**State in the wrong place**

9. The `Status` column in the task list says `pending` for every task; the state CLI says all 28 are trusted.
   → No status, no ticks, no counters in any format.

**Smaller defects**

10. The test-case categories are an open vocabulary: the 10-category reference, plus "failure mode",
    "backwards compatibility", "regression", "money", "data safety" and "idempotency" in the output. → One
    closed list, declared once.
11. create-spec's template (Goal, Implementation Notes, Files, Acceptance), its stage 7 prompt (Action, File,
    Depends On, Tests, Test Cases, Supports, Notes) and its output (a third mix) disagree on the fields.
12. In `definitions.json`, S57's Gherkin ends with `@integrity`, the tag of the next scenario. Tags in YAML
    also need quoting: `@` is reserved.

## The six formats

| # | Format | The idea | Files for T2 | Lines |
| --- | --- | --- | --- | --- |
| 1 | [One file per parent](./1-one-file-per-parent/README.md) | Today's `tasks.md`, cleaned up: fixed headings, labelled fields, verification inline | 1 | 565 |
| 2 | [Task and verify pairs](./2-task-and-verify-pairs/README.md) | Two files per unit: what to do, how it is judged | 18 | 872 |
| 3 | [`.task` folders](./3-task-folders/README.md) | The folder suffix is the schema; `TASK.md` and `VERIFY.md` required; nesting is the hierarchy | 41 | 942 |
| 4 | [Acceptance first](./4-acceptance-first/README.md) | Scenarios own the edges (`needs:`); work packages are thin | 36 | 1115 |
| 5 | [Contracts](./5-contracts/README.md) | Every statement is an obligation with an id, a proof and a judge | 11 | 987 |
| 6 | [Literate blocks](./6-literate-blocks/README.md) | A design note with typed fenced blocks; one parse rule | 1 | 723 |

## Comparison

| | 1 one file | 2 pairs | 3 folders | 4 acceptance first | 5 contracts | 6 literate |
| --- | --- | --- | --- | --- | --- | --- |
| Machine data in | bold labels + headings | YAML front matter | YAML front matter | YAML front matter | front matter + numbered lists | typed fenced YAML |
| Verification lives | inline, per subtask | sibling file | `VERIFY.md` in the folder | outcomes + unit cases | the contract itself | `verify` block after `task` |
| Many-to-many scenarios | copied into each phase file | one shared file | one file each, linked | one file each, owning the edge | one shared file | blocks, collected |
| Builder / verifier separation | none | by file | by file | by level | by section | by block |
| Parse rule | headings and labels (fragile) | front matter + headings | folder schema + front matter | front matter + headings | front matter + list grammar | one rule + schema per block |
| Drift risk | low inside, high across phases | pair can drift | low | lowest (edges once) | low | low |
| An agent gets one unit by | slicing a section | two files | one folder | one work file + linked outcomes | one file | the blocks for one id |
| Best for | migration from today | verification owned by someone else | an engine that wants a strict contract | outcome-driven planning | precise, auditable verification | design-heavy work |

## Rules all six share

- **No state in the files.** No status, no ticks, no counters. The engine keys state by id and by the content
  hash of the file version it was produced against, so an edited task invalidates its old verdicts.
- **Proof binds by tag.** A test proves an id when its title starts with `[<id>]` — `[T2.1.c4]`, `[S25]`.
  Paths are hints.
- **Stable ids for everything that is judged.** Tasks `T2.1`; cases `T2.1.c4`; rules `T2.1.p1` / `T2.1.f1`
  (numbered in format 5); scenarios `S25`; gates `BUILD-2`; references namespaced (`POA-D3`), as the source's
  own warning about clashing `D<n>` series asks.
- **Scenarios and gates are separate**, and gates carry runnable commands.
- **Rules are scoped to their task** (`Must not`), and work a sibling owns is said out loud (`Not in this
  task`).
- **The verification policy is declared once** and inherited; a task may tighten it.
- **Each task carries its own rejection rubric** — the weak proofs a verifier must refuse. These were written
  for this example from each case; in practice they are where the lessons of earlier rejections go.

## Recommendation

If the engine had to pick today: format 3's folder contract for packaging, format 5's numbered obligations
inside `VERIFY.md`, and format 4's rule that a scenario declares the tasks it needs. That gives a strict,
parseable layout, verification that can be addressed one obligation at a time, and many-to-many edges written
once. Format 6's typed blocks are the fallback if authors want to keep writing one flowing document.

[`blend/`](./blend/README.md) is that recommendation, written out: the same T2 example, with every machine field
in front matter that a JSON Schema checks, and thirteen numbered rules for what a schema cannot check.

## How these files were made

Rendered from one model of T2 by a throwaway generator, then hand-written: this README and `model.md`. Every
front matter and typed block parses as YAML; every relative link and anchor resolves; no checkbox appears; every
format holds all 37 cases and all 26 scenarios. The generator is not included; ask if you want it.

Corrections to the source, present in every format: T2.2 lists `routing-policy.ts`; T2.3 depends on T1.3 and
T1.6; T2.2 supports S57 and S59, and T2.6 supports S58; test paths are the repo's real ones (as hints).
