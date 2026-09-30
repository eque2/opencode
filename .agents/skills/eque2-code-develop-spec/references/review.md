Language: {communication_language}

# Stage 3: Failure Review

Spawn a review subagent to assess whether a failed actor is recoverable. If recoverable, reset for retry. If not, document the blocker and leave as failed.

## Rules

- **NEVER** edit state files directly — all state changes via the state CLI (`node {STATE_CLI} $SPEC_FOLDER <verb> ...`).
- Run autonomously. No user questions.

## Sequence

### 1. Spawn review subagent

The failed actor ID is `$FAILED_ID`.

```
SPAWN general-purpose Task subagent:

  Review failed actor {FAILED_ID} in {SPEC_FOLDER}.

  1. Read journal/{FAILED_ID}.md for failure details.
  2. Read {SPEC_FOLDER}/spec.md for requirements context.
  3. Consult {project-root}/docs/CLAUDE/ before declaring a hard blocker —
     many infrastructure problems are solvable.
  4. Assess: recoverable (transient error, fixable config, retry worth trying)
     or hard blocker (ambiguous requirements, architectural contradiction,
     repeated failure with no new approach available)?

  If recoverable:
    Run: node {STATE_CLI} $SPEC_FOLDER update {FAILED_ID} reset --reason "<recovery plan>"

  If hard blocker:
    Leave as failed. Append findings to journal/{FAILED_ID}.md explaining why.

  NEVER ask the user questions — run autonomously.
```

### 2. Check review outcome

After the subagent completes:

```
outcome = RUN `node {STATE_CLI} $SPEC_FOLDER query {actor_type}/{FAILED_ID}` → parse JSON stdout

IF outcome.status == "not_started":
    LOG: "RESET: {FAILED_ID} reset for retry"
    → Return to 02-execute.md

IF outcome.status == "failed":
    LOG: "BLOCKED: {FAILED_ID} confirmed as hard blocker"
    → Return to 02-execute.md
    (`node {STATE_CLI} $SPEC_FOLDER done` will detect stall if downstream actors are blocked)
```

## Progression

Always returns to `02-execute.md`. The orchestrator loop continues.
