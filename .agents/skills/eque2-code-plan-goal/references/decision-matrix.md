# The decision matrix — inline decides, disk verifies

Normative for stage 1. The matrix below is **authoritative**: it decides
which skill suits which kind of task. Runtime discovery only *adds* —
it surfaces installed skills the matrix does not mention (scan
`{skills-root}/` and, as a hint only, `_bmad/_config/bmad-help.csv`).
It never overrules a matrix row. The CSV catalogue is a hint and never
ground truth — it lags renames, and a plan built from it binds skills
that do not exist.

Claude Code and Codex resolve `{skills-root}` differently (see the token
note in `SKILL.md`); the check itself is identical under either agent.

## Existence check — disk is the truth

Before the plan names a skill, confirm it exists:

```sh
[ -d "{skills-root}/<skill-name>" ]
```

A named skill that is absent is recorded in its Stage sequence row as
**NOT INSTALLED**, with the closest installed alternative named beside
it. Stage 2 refuses to bind a NOT INSTALLED workflow — the plan says so
wherever it happens.

## The matrix

The `Pick when` column is the durable part: terse and testable. Read it
top to bottom; several rows can apply to one task (one per Decision).

| Kind of task | Skill | Pick when |
|---|---|---|
| One-file change | `bmad-build` | No schema change, no new dependency, no new file (see §Lane) |
| Reproducible defect | `eque2-code-bug-fix` | A failing case can be written before the fix |
| Build spec | `eque2-code-create-spec` | Work needs a task list and acceptance criteria |
| Execute a spec | `eque2-code-develop-spec` | A validated spec exists |
| Multi-epic feature | `bmad-prd` | More than one epic, or cross-cutting |
| System-shape change | `bmad-architecture` | New service, new store, or a new boundary |
| Epic breakdown | `bmad-create-epics-and-stories` | A PRD exists and needs slicing |
| Visual tweak | `bmad-ux` | A pattern already exists and needs adjusting |
| Unknown technology | `bmad-deep-recon` (technical) | A recommendation needs evidence |
| Unknown domain | `bmad-deep-recon` (domain) | The rules of the problem space are unclear |
| Solution space is open | `bmad-brainstorming` | More than one credible approach and no obvious winner |
| Acceptance tests first | `bmad-testarch-atdd` | Behaviour is agreed before implementation |
| Test strategy | `bmad-testarch-test-design` | Coverage shape is itself a decision |
| End-to-end proof | `eque2-code-e2e-test` | A user journey must be shown working |
| Undocumented codebase | `bmad-project-context` | Stage 1 cannot find the context it needs |
| Ship it | `eque2-code-create-pr` | Work is verified and ready to review |

**Maintaining it.** Every row is disk-verified at build time and
re-verified at stage 1. A row whose skill has vanished from disk is
reported in the plan's "Skill availability" section — never silently
dropped.

## §Lane — light or heavy

**Hannibal's planned-goal ceremony is invariant.** Every task started through
`[PL]`, however small, gets the goal folder, the worktree, the plan, the
approval gate, the acceptance criteria, the bound stop gate, and a status
entry. There is no bypass lane inside the planned route. The explicit
`pursue the goal of <task>` route belongs to `pursue-goal`; it creates and
validates its direct contract before it binds the same stop gate. "Lightweight"
is satisfied by choosing cheaper *workflows*, not by skipping planned stages.

A task takes the **heavy lane** if **any** of these hold:

- it touches more than a couple of existing files, or adds a new one;
- it adds a dependency, or changes a schema or migration;
- it changes a public interface or API contract;
- it changes something the user sees;
- it touches an auth, payment, or security path;
- the user asked for a spec, a PRD, or epics.

None hold → the **light lane**. **Cannot tell → ask the user.** Never
assume either way silently.

### What the light lane selects away

| Skipped when not earned | Instead |
|---|---|
| `bmad-prd` | `decisions.md` and `ACs.md` carry the requirement |
| `bmad-create-epics-and-stories` | A flat task list in the goal folder |
| `bmad-architecture` | A `D<n>` in `decisions.md`, with justification |
| `eque2-code-create-spec` `[CS]` | Stage 1's `ACs.md` is the whole contract |
| `eque2-code-develop-spec` `[DS]` | `bmad-build` builds against the ACs |

The plan states which of these it declined, and why, in its "Declined
workflows" section. A declined workflow is a recorded decision, not an
omission.

### The light lane and the gate

Declining `[CS]`/`[DS]` means no test-lifecycle state is initialised —
no `definitions.json`, no signed event log, no minted test verdicts, no
verifier dispatch. The stop gate does not care: its verdict is its own
acceptance-criteria verdict over `ACs.md`, and it binds and enforces
identically in both lanes. **The evidence bar does not drop**: a
light-lane criterion is still evidenced by real quoted command output —
the lint run, the type-check, the test that actually executed.
`bmad-build` runs those anyway, so this costs a paste, not a
pipeline.
