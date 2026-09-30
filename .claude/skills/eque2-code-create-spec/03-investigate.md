Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 3 — Investigate codebase

**Progress: 3 of 10** — Next: Web research

**Produces:** `context.md` (tech stack, code patterns, files-to-modify table with UPDATE-file analysis, existing tests, resolved test directory, coding-standards constraints).

## Verdict First

The single largest source of implementation failures is "spec author didn't read the files being modified". This stage fixes that. Outputs:

- Architecture deep-dive (9 dimensions)
- UPDATE-file analysis: **current state / what changes / what must be preserved** for every file the feature touches
- Resolved coding-standards constraints, surfaced for Stage 7 to inline into tasks
- Resolved test directory

## Critical discipline

📂 READ THE FILES BEING MODIFIED. Skipping this is the primary cause of implementation failures and review cycles.

A feature implementation must leave the system working end-to-end — not just satisfy stated ACs. If a behavior is required for the feature to work correctly in the existing system, it is a requirement whether or not it is explicitly written in the spec.

## Inputs from Stage 2

The context envelope: requirement, planning docs, previous features, git recent.

## Load coding standards

```
{workflow.coding_standards_glob}
```

Default `{project-root}/docs/CLAUDE/code-standards/*.md`. Read every match completely. Note tech-agnostic, tech-general, and company-bespoke rules that apply to this feature's expected file touches.

## Load review rules (awareness only)

```
{workflow.review_rules_glob}
```

Default `{project-root}/.github/review-rules/*.md`. Awareness of how this spec's output will be reviewed — informs scenario design.

## Architecture deep-dive — 9 dimensions

For each dimension, extract from loaded planning docs + repository scan:

| Dimension | What to extract |
|---|---|
| **Tech stack** | Languages, frameworks, libraries with versions (read package.json / lockfiles) |
| **Code structure** | Folder organisation, naming conventions, file patterns |
| **API patterns** | Service structure, endpoint patterns, data contracts |
| **DB schemas** | Tables, relationships, constraints relevant to this feature |
| **Security** | Auth patterns, authorisation rules |
| **Performance** | Caching, optimisation patterns relevant here |
| **Testing** | Frameworks, coverage expectations, test patterns; resolve test directory (see "Resolve test directory" below) |
| **Deployment** | Environment configs, build processes |
| **Integration** | External services, data flows |

## Identify UPDATE / NEW files

From the architecture analysis and the requirement, list every file the feature will touch. Tag each UPDATE (modifying existing) or NEW.

## UPDATE-file analysis — DELEGATE TO SUBAGENT

For each UPDATE file, the parent agent should NOT read the file contents into its own context — that's ~5-10k tokens per file, and a feature can touch 5-10 files. Instead delegate to a subagent that returns structured JSON.

**Subagent prompt template:**

```
You are analysing source files for inclusion in a feature spec. Read each file
completely and return structured analysis. Do NOT include the file's raw
contents in your response — return ONLY the structured analysis.

Files to analyse:
- {file_path_1}
- {file_path_2}
- ...

Feature context (one paragraph): {brief description of what this feature changes}

For each file, return JSON:

{
  "file": "<path>",
  "current": "<what it does today: state machine, API calls, data shapes, existing behaviors>",
  "changes": "<the specific sections or behaviors this feature modifies>",
  "preserved": "<existing interactions and behaviors that must NOT break>"
}

Return a JSON array of one object per file. No prose around the JSON.
```

Spawn the subagent in the background. Poll per the global Subagent Circuit Breaker (every 10 min; kill after two stalls). On completion, parse the JSON array.

If a file's `preserved` section reveals a constraint that adds scenario coverage requirements, note it for Stage 5 (Coverage Model) to pick up.

## Surface coding-standards constraints

Capture relevant coding-standards constraints as a list keyed by which task phase they apply to. Stage 7 will inline them into task Notes.

## Write `context.md`

From `assets/templates/context-template.md`. Include:

- Tech stack with versions
- Code patterns
- Files-to-modify table (UPDATE/NEW per file with the subagent's structured analysis: current / changes / preserved)
- Existing test patterns, including a "Test Patterns" section with a `TEST_DIR: <dir>` line — the directory where this feature's tests live, taken from your files-to-modify investigation (the actual component/feature location, not just wherever some spec file happens to sit)
- Coding-standards constraints keyed by phase

## Resolve test directory

Run this AFTER `context.md` is written — the resolver's highest-confidence strategy reads the
`TEST_DIR:` line from `context.md`'s Test Patterns section. Compute `{TEST_DIR}` once here so
Stage 10's snapshot generator doesn't need to re-discover:

```
uv run scripts/cs-resolve-test-dir.py {project-root} --hint '{workflow.test_file_prefix_hint}' --context-file {feature_root}/context.md -o {feature_root}/.test-dir.json
```

Read `{feature_root}/.test-dir.json` and extract `test_dir` and `method`.

- `method == "context_file"` — high confidence; done.
- Any other `method` (`common_pattern`, `find_match`, `fallback`) is LOW confidence — in a
  multi-project monorepo `find_match` returns the parent of the first arbitrary spec file it finds,
  which can be an unrelated library. Cross-check the resolved dir against the files-to-modify
  table: if it doesn't sit alongside the feature's actual code, correct the `TEST_DIR:` line in
  `context.md` and re-run the resolver so `.test-dir.json` records the verified directory. If it
  ends up as the `fallback` default `test/`, log a warning to the session log.

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3]`.

## Exit

Stage complete when `{context_file}` exists and contains the UPDATE-file analysis. Advance to `04-web-research.md`.

## Interactive checkpoint

```
Stage 3 complete — context.md written.
[a] Advanced Elicitation / [c] Continue / [p] Party Mode
```

Default mode auto-continues.

## Failure modes

- **Retry candidate:** subagent times out / stalls on UPDATE-file analysis. Kill, retry with a smaller batch (split files across two subagent calls).
- **Escalate:** UPDATE files referenced by the requirement that don't exist in the repo — surface as a spec gap before continuing.
