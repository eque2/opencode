Language: {communication_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 10 — Definitions generation

**Progress: 10 of 10** — Final stage

**Produces:** `{feature_root}/definitions.json` conforming to `schemas/actor-definitions@1`. Sets `status: ready-for-build` on `{spec_file}`.

## Verdict First

Stage 10 emits ONE file — `definitions.json` — that describes every actor (parent tasks, subtasks, scenarios, build-checks) in the feature. The state CLI's `init` verb (`node {skills-root}/eque2-code-setup/scripts/state.mjs $SPEC_FOLDER init`) reads it at build time, constructs the canonical initial XState snapshots inside the signed plaintext state files (`state/events.jsonl`, HMAC-signed, committed to git), and from that moment is the sole writer of runtime state. The spec workflow never pre-renders XState snapshots and there is no longer a hard-gate validator — the CLI's `init` verb rejects malformed definitions when it hydrates them.

## Critical rules

- Emit exactly one artifact: `{feature_root}/definitions.json`.
- DO NOT write `{feature_root}/state/*.json` files. The seed-snapshot pipeline is retired; the state CLI's `init` verb constructs snapshots from `definitions.json` in-memory.
- DO NOT invoke `validate.mjs`. It has been deleted along with the pre-rendered snapshot pipeline. The state CLI's `init` verb decode is the gate.
- Definitions are emitted by the helper script — do NOT hand-type JSON.

## Prerequisites

- `{spec_file}` exists with `stepsCompleted` containing 9
- `{tasks_file}` and `{scenarios_file}` exist
- `{TEST_DIR}` resolved in `{context_file}` (Stage 3)

## Generate definitions — delegate to script

```
uv run scripts/cs-generate-definitions.py {feature_root} --test-dir-from-context
```

The script reads `{tasks_file}`, `{scenarios_file}`, and `{context_file}`, then emits a single file:

- `{feature_root}/definitions.json`

…conforming to `schemas/actor-definitions@1`. It enumerates `parentTasks`, `tasks` (subtasks), `scenarios`, and `buildChecks` with their definitional fields only — IDs, descriptions, phases, dependencies, supports relationships, and test file paths. Runtime fields (attempt counters, evidence, trust level) are filled by the state CLI's `init` verb, not here.

The script returns structured JSON on stdout: `{status, feature_id, counts: {parentTasks, tasks, scenarios, buildChecks}, errors: [...]}`. Exit code is non-zero on any structural error (e.g. a task supports a scenario that doesn't exist in `scenarios.gherkin`).

## Failure handling

If the script returns `status: failed`:

1. Read the `errors` array. Each entry has `{file, issue}` identifying the structural problem.
2. Fix the spec content (`tasks.md`, `scenarios.gherkin`) — repeat failures from the script are deterministic and indicate genuine spec-content gaps, not generator bugs.
3. Re-run the script. Cap at 3 iterations.
4. If still failing after 3 iterations: halt with structured JSON error and surface the unresolved errors. The spec stays `status: in-progress` — do NOT mark `ready-for-build` on a failing generation.

## Frontmatter update (only when status: ok)

Update `{spec_file}`:

- `stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]`
- `status: ready-for-build`

## Run on_complete hook

```
python3 {project-root}/_bmad/scripts/resolve_customization.py \
  --skill {project-root}/_bmad/eque2-code-agent-linus \
  --key agent.on_complete
```

If the resolved value is non-empty, follow it as the final terminal instruction.

## Emit completion output

### Catches Surfaced

Read `{feature_root}/.catches.json` (if present — populated by Stages 6, 7, 8 via `cs-append-catches.py`). Build a "Catches Surfaced" section enumerating findings from each auto-invocation:

```
**Catches Surfaced**

- Stage 6 Party Mode added 2 scenarios (S5, S6) — rationale: missing performance category.
- Stage 7 edge-case-hunter added 4 test cases (T2.3 Concurrency, T3.1 Resource Limits, ...) — rationale: SDK retry semantics not covered.
- Stage 8 adversarial-general flagged 1 critical, 2 enhancements — applied.
- Stage 8 checklist found 3 cross-reference misses — applied.
```

**Read with fallback** — do NOT let a corrupt `.catches.json` crash the workflow at the finish line. Wrap the read:

1. If `.catches.json` is absent → output "Catches Surfaced: none — clean run."
2. If present, attempt JSON parse:
   - **Success** → enumerate `entries[]` per the format above. Validate `schema_version` is `"1"` (see `references/catches-schema.md`); if mismatched, treat as "see file" below.
   - **Parse failure** → rename to `.catches.json.broken-{ISO-timestamp}` and emit "Catches Surfaced: parse error — see {feature_root}/.catches.json.broken-* for the raw record." Continue the workflow. Do NOT halt — the spec is still valid; only the audit trail is degraded.

### Interactive mode output

```
🎯 Buildable Spec Complete!
Feature: {FEATURE-ID}
Stages: 10/10
definitions.json: emitted (parentTasks={N}, tasks={M}, scenarios={K}, buildChecks={J})

**Catches Surfaced**
<as above>

[a] Advanced Elicitation - refine further
[r] Adversarial Review - critique of the final spec
[DS] Develop Spec - build, review, verify, and Figma-check the full feature
[d] Done - exit workflow
[p] Party Mode - get expert feedback
```

### Default / headless mode output

Structured JSON to stdout:

```
{
  "status": "ok",
  "task": "create-spec",
  "feature_id": "{FEATURE-ID}",
  "feature_artifacts": "{feature_root}",
  "stages_completed": 10,
  "definitions": {
    "path": "{feature_root}/definitions.json",
    "counts": {"parentTasks": N, "tasks": M, "scenarios": K, "buildChecks": J}
  },
  "subagents_invoked": ["bmad-party-mode", "bmad-review", "bmad-review"],
  "catches_surfaced": [<entries from .catches.json>],
  "test_dir": "{TEST_DIR}"
}
```

## Exit

Workflow complete. Append session log entry. Exit 0 (or interactive: return to dispatch).

## Failure modes

- **Blocker:** `cs-generate-definitions.py` reports `status: failed` after 3 fix iterations. Halt with structured JSON. The spec stays `status: in-progress`.
- **Surface:** the script reports a missing cross-reference (a task supports a scenario that doesn't exist). Fix the spec content, re-run.
