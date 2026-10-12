Language: {communication_language}

# Stage 4: Completion

Handle exit from the orchestrator loop. Log final status and surface next steps.

## Rules

- Never ask the user questions — run autonomously.

## Sequence

### 1. Log final status

Run `node {STATE_CLI} $SPEC_FOLDER status` and capture the parsed JSON result.

### 2. Handle exit reason

**exit_reason = "done":**
```
DONE: All tasks and verifications complete.
Tasks:       {completed}/{total} completed
Build Checks:{passed}/{total} passed
Scenarios:   {verified}/{total} verified

Feature ready for its E2E test and PR.
Next: run [ET] to generate the Playwright E2E test (Jira-sourced specs — gated on an
existing Xray definition), then [PR] to review, confirm green, and open the PR.
```

**exit_reason = "stalled":**
```
STALLED: {blocker_id} failed, and no other useful work can proceed.

Obstacle: {plain English — what failed, what it prevents, what was tried}
Waiting on it: {downstream_ids}
To unblock: {the decision or fix that would let work continue}
Details: journal/defects.md D{n}, journal/{blocker_id}.md
```

**exit_reason = "blocked":**
```
BLOCKED: No recommendation available, and no other useful work can proceed.

Obstacle: {plain English — why every remaining actor is waiting}
To unblock: {the decision or fix that would let work continue}
Inspect current state:
  node {STATE_CLI} {SPEC_FOLDER} status
```

**exit_reason = "max_iterations":**
```
MAX_ITERATIONS: Reached iteration cap ({max_iterations}). Pausing for review.

To resume, run DS again with the same spec slug.
```

### 2b. Unresolved defects and unrun checks — every exit reason

Read `journal/defects.md` and the `status` result. Append to the report, whatever the exit reason:

```
UNRESOLVED DEFECTS: {count}
  D{n} {actor}: {summary} — {open | accepted-for-review}. Impact: {impact}
UNRUN OR NOT PASSING CHECKS: {count}
  {actor or check}: {failed | skipped | not run} — {reason}
```

Write `none` when a list is empty. An accepted or skipped item is reported as failed or skipped — never as passed. "DONE" with open defects means the state machine finished, not that every check passed; say so.

### 3. Worktree status

Run `node {STATE_CLI} $SPEC_FOLDER metadata` and read `worktree_path` from the parsed JSON.

**If `worktree_path` is set:**
```
WORKTREE: .claude/worktrees/{SPEC_SLUG} on branch feature/{SPEC_SLUG}

Changes are committed on the feature branch.
To generate the E2E test: [ET] command (then [PR]).
To create a PR: [PR] command.
To clean up:  git worktree remove .claude/worktrees/{SPEC_SLUG}
```

**If not set:**
```
WORKTREE: Not used — changes committed directly on the current branch.
To generate the E2E test: [ET] command (then [PR]).
To create a PR: [PR] command.
```

## Progression

Terminal stage. Append outcome to session log. Return to Linus dispatch.
