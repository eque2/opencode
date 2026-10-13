# XState Schema Requirements

## MANDATORY Root-Level Fields (ALL snapshot types)

Every generated JSON snapshot MUST include these root-level fields:

| Field | Value | Purpose |
|-------|-------|---------|
| `$schema` | Relative path to the schema file | Enables validation tooling to find the correct schema |
| `_schemaVersion` | `"1"` | Schema version for compatibility checks |
| `_machineVersion` | `"1"` | XState machine version for compatibility checks |
| `value` | Initial state (see per-type examples) | XState current state |
| `context` | Object with required fields (see per-type) | XState context data |
| `status` | `"active"` | XState actor status |
| `tags` | `{}` | XState tags (empty initially) |

## FORBIDDEN — These WILL break the state CLI and block the entire EV workflow

### Forbidden field values
- **NEVER use `"idle"` as a state value.** The string `"idle"` does not exist in ANY snapshot schema. Use `"not_started"` for tasks, scenarios, and build checks. Use `{"buildingSubtasks": "checkingProgress"}` for parent tasks.
- **NEVER use `null` for optional fields.** Effect Schema treats `null` and `undefined` as different types. If a field is optional and has no value, **omit the field entirely** — do not set it to `null`. The only field that accepts `null` is `reviewResult` (which uses `NullOr`, not `optional`).

### Forbidden context fields
- `title` — NOT a valid schema field
- `category` — NOT a valid schema field
- `tags` at context level — tags belong at root level only
- `expectedExitCode` — NOT a valid schema field
- `failureStrategy` — NOT a valid schema field
- `dependencies` in parent task context — parent tasks do NOT have dependencies (scenarios do)

---

## Task Snapshot (subtasks like T1.1, T2.1)

**Schema URI:** `schemas/task-snapshot@1`
**File path:** `state/task/{parentId}/{taskId}.json` (e.g., `state/task/T1/T1.1.json`)

```json
{
  "$schema": "schemas/task-snapshot@1",
  "_schemaVersion": "1",
  "_machineVersion": "1",
  "value": "not_started",
  "status": "active",
  "tags": {},
  "context": {
    "taskId": "T1.1",
    "description": "...",
    "phase": "1",
    "workingDirectory": "",
    "dependsOn": [],
    "supportsScenarios": [],
    "tests": [],
    "idempotencyKey": "task-T1.1-attempt-1",
    "attemptNumber": 1,
    "maxAttempts": 10,
    "evidence": { "testsPassed": null, "commitSha": null, "completedAt": null }
  }
}
```

**Notes:**
- `phase` MUST be a STRING (`"1"`, not `1`)
- `$schema` path is relative from the snapshot file location to the schema file

## Parent Task Snapshot (T1, T2)

**Schema URI:** `schemas/parent-task-snapshot@1`
**File path:** `state/task/{taskId}.json` (e.g., `state/task/T1.json`)

```json
{
  "$schema": "schemas/parent-task-snapshot@1",
  "_schemaVersion": "1",
  "_machineVersion": "1",
  "value": { "buildingSubtasks": "checkingProgress" },
  "status": "active",
  "tags": {},
  "context": {
    "taskId": "T1",
    "description": "Phase 1: ...",
    "worktreePath": "",
    "reviewResult": null,
    "attemptNumber": 1,
    "maxAttempts": 3
  }
}
```

**Notes:**
- Value MUST be object `{"buildingSubtasks": "checkingProgress"}`, NOT a string
- DO NOT include `subtaskDependencies` or `subtaskDescriptions`
- `$schema` path is relative from `state/task/T1.json` to the schemas directory

## Scenario Snapshot

**Schema URI:** `schemas/scenario-snapshot@1`
**File path:** `state/scenario/{scenarioId}.json` (e.g., `state/scenario/S1.json`)

```json
{
  "$schema": "schemas/scenario-snapshot@1",
  "_schemaVersion": "1",
  "_machineVersion": "1",
  "value": "not_started",
  "status": "active",
  "tags": {},
  "context": {
    "scenarioId": "S1",
    "description": "...",
    "testFile": "{TEST_DIR}/verify-{FEATURE-ID}-S1.spec.ts",
    "workingDirectory": "",
    "specFolder": "{feature_artifacts}/{FEATURE-ID}",
    "dependencies": [],
    "retryCount": 0,
    "maxRetries": 3
  }
}
```

**Notes:**
- `scenarioId` MUST match the shared scenario id grammar `[A-Z]+-?\d+(?:-[A-Z]+)*(?:\.\d+)?[a-z]?` (e.g. `S1`, `AU3`, `DELIVERY-2`, `C4-RESET.1`) — the `pattern` of a scenario id in `eque2-code-setup/schemas/actor-definitions.v1.schema.json`. The testFile basename MUST be `verify-{FEATURE-ID}-{scenarioId}.spec.ts` and route to that same id; `state.mjs init` refuses either mismatch.
- `testFile` MUST be a path resolvable from the project root (e.g., `src/myapp/test/scenarios/verify-my-feature-S1.spec.ts`). The structural verifier calls `fs.existsSync(testFile)` with no path resolution — bare filenames will fail verification.
- `{TEST_DIR}` should be determined during Stage 7 by examining the project's test directory structure (e.g., `src/eque2-test/test/scenarios`, `tests/`, `e2e/`). See `07-state.md` § "Determine Test Directory".

## Build Check Snapshot

**Schema URI:** `schemas/build-check-snapshot@1`
**File path:** `state/buildCheck/{checkId}.json` (e.g., `state/buildCheck/BUILD-1.json`)

```json
{
  "$schema": "schemas/build-check-snapshot@1",
  "_schemaVersion": "1",
  "_machineVersion": "1",
  "value": "not_started",
  "status": "active",
  "tags": {},
  "context": {
    "checkId": "BUILD-1",
    "command": "{detected_command}",
    "workingDirectory": "",
    "retryCount": 0,
    "maxRetries": 3
  }
}
```

## State Metadata

**Schema URI:** `schemas/state-metadata@1`
**File path:** `metadata.json` (at feature root, NOT inside `state/`)

```json
{
  "$schema": "schemas/state-metadata@1",
  "spec_slug": "{FEATURE-ID}",
  "created_at": "{ISO 8601 timestamp}",
  "updated_at": "{ISO 8601 timestamp}"
}
```

## $schema URI Rules

**CRITICAL: The `$schema` field uses LOGICAL URI format, NOT relative file paths.**

The validator expects: `schemas/<type>@<version>`

| Snapshot Type | $schema Value |
|---------------|---------------|
| Parent task (T1.json) | `schemas/parent-task-snapshot@1` |
| Subtask (T1.1.json) | `schemas/task-snapshot@1` |
| Scenario (S1.json) | `schemas/scenario-snapshot@1` |
| Build check (BUILD-1.json) | `schemas/build-check-snapshot@1` |
| Metadata (metadata.json) | `schemas/state-metadata@1` |

**DO NOT use relative file paths** (e.g. paths beginning with two dots and a slash pointing at `schemas/task-snapshot.v1.schema.json`) — the validator will reject them with "Invalid $schema URI format". Use the URI form (`schemas/task-snapshot@1`) instead.

The URI is the SAME regardless of file location — `state/task/T1/T1.1.json` uses the same `schemas/task-snapshot@1` as `state/task/T2/T2.1.json`.
