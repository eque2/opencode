Language: {communication_language}

# Stage 3: Failure Review

Spawn a review subagent to classify a failed actor and measure what its failure actually prevents. If a new approach is supported by evidence, reset for retry. If not, record the defect and leave the actor failed — the loop then continues with every piece of work the failure does not block.

## Rules

- **NEVER** edit state files directly — all state changes via the state CLI (`node {STATE_CLI} $SPEC_FOLDER <verb> ...`).
- Run autonomously. No user questions.
- Follow "Failure handling" in `references/guardrails.md`.

## Sequence

### 1. Spawn review subagent

The failed actor ID is `$FAILED_ID`.

```
SPAWN general-purpose Task subagent:

  Review failed actor {FAILED_ID} in {SPEC_FOLDER}.
  Read references/guardrails.md in full first — "Failure handling" governs this review.

  1. Read journal/{FAILED_ID}.md and journal/defects.md for failure details
     and the attempts already made.
  2. Read {SPEC_FOLDER}/spec.md for requirements context.
  3. Consult {project-root}/docs/CLAUDE/ before declaring a failure
     unrecoverable — many infrastructure problems are solvable.
  4. Classify: contained, blocking, or integrity (guardrails.md).
  5. Measure the impact: find the actors that depend on {FAILED_ID} (the
     dependency lists in spec.md, cross-checked against
     `node {STATE_CLI} $SPEC_FOLDER query "*"`). For each dependant, state
     whether it needs the failed part or only waits on the declared
     dependency.
  6. Decide:
     - Recoverable — the evidence supports an approach not yet tried
       (transient error, fixable config, a different implementation):
         Run: node {STATE_CLI} $SPEC_FOLDER update {FAILED_ID} reset --reason "<new approach>"
       Never reset for a blind retry of an approach already tried 3 times.
     - Owner-accepted — an owner instruction accepts this class of failure,
       and the CLI allows `skip` for this actor (build check or scenario):
         Run: node {STATE_CLI} $SPEC_FOLDER update {FAILED_ID} skip --reason "Accepted for final review — see defects.md D{n}"
     - Otherwise leave it failed.
  7. In every case, make sure journal/defects.md has an entry for this
     failure with the actual failure, impact (step 5), attempts, remaining
     validation, and status.

  NEVER ask the user questions — run autonomously.
```

### 2. Check review outcome

After the subagent completes:

```
outcome = RUN `node {STATE_CLI} $SPEC_FOLDER query {actor_type}/{FAILED_ID}` → parse JSON stdout

IF outcome.status == "not_started":
    LOG: "RESET: {FAILED_ID} reset with a new approach"
    → Return to 02-execute.md

IF outcome.status == "skipped":
    LOG: "ACCEPTED: {FAILED_ID} skipped for final review — see journal/defects.md"
    → Return to 02-execute.md

IF outcome.status == "failed":
    LOG: "FAILED: {FAILED_ID} recorded in journal/defects.md. Waiting on it: {dependants that need it}. Continuing with other work."
    → Return to 02-execute.md
    (`next` recommends the work this failure does not block; `node {STATE_CLI} $SPEC_FOLDER done` reports a stall only when nothing else can run)
```

## Progression

Always returns to `02-execute.md`. The orchestrator loop continues.
