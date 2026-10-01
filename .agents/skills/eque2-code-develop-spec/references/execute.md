Language: {communication_language}

# Stage 2: Orchestrator Loop

Run the main execution loop: query state for the next action, spawn Task subagents, check outcomes, and repeat until done, stalled, or the iteration cap is reached.

## Rules

- **NEVER** edit state files directly — all state changes via the state CLI (`node {STATE_CLI} $SPEC_FOLDER <verb> [args]`, JSON on stdout).
- **ALWAYS** respect the max iterations cap (default 100).
- **NEVER** ask the user questions — run autonomously.
- Every CLI call prints ONE JSON object to stdout on success and exits 0; on failure it prints an error to stderr and exits non-zero. Treat a non-zero exit as a HARD ERROR and stop.
- All `update` calls require a `--reason "..."` string for the journal audit trail.
- **CIRCUIT BREAKER** — every background Task MUST be polled every 10 minutes. See `references/circuit-breaker.md`.
- **VERIFY IS SPECIAL** — a `verify`/`verify-scenario-trust` recommendation is NEVER dispatched via the generic subagent template. The orchestrator spawns a fresh SIBLING verify subagent using `references/verify-subagent-prompt.md` (never nested inside the builder that produced the work). See step 2d.

## Sequence

### 1. Initialise loop state

```
iteration = 0
max_iterations = $MAX_ITERATIONS or 100
```

### 2. Orchestrator loop

```
WHILE iteration < max_iterations:
    iteration += 1
    LOG: "--- Iteration {iteration}/{max_iterations} ---"

    # 2a. Query state for next action
    result = RUN `node {STATE_CLI} $SPEC_FOLDER next --context` → parse JSON stdout

    # 2b. Check if done
    IF result has no action:
        done_check = RUN `node {STATE_CLI} $SPEC_FOLDER done` → parse JSON stdout
        IF done_check.done == true:
            LOG: "DONE: All tasks and verifications complete."
            # FINAL QUALITY GATE — the single orchestrator-level lint/typecheck pass.
            # Runs ONCE here over the whole worktree, not per parent task.
            RUN quality checks per references/quality-checks.md
            IF checks fail:
                LOG: "QUALITY_GATE: lint/typecheck failed at completion"
                Fix issues. Treat warnings as errors. Re-run until clean.
            → Route to 04-complete.md with exit_reason="done"
        IF done_check.stalled == true:
            LOG: "STALLED: {blocker detail from done_check}"
            → Route to 04-complete.md with exit_reason="stalled"
        LOG: "NO_RECOMMENDATION: All remaining work is blocked."
        → Route to 04-complete.md with exit_reason="blocked"

    # 2c. Extract recommendation details
    task_id = result.id
    action   = result.action
    context_info = result.context

    # 2d. VERIFY — orchestrator-spawned SIBLING subagent (D3), batched when parallel-safe
    IF action IN ["verify", "verify-scenario-trust"]:
        all_scenarios = RUN `node {STATE_CLI} $SPEC_FOLDER query scenario/*` → parse JSON stdout
        ready_scenarios = filter WHERE status == "not_started"

        IF ready_scenarios.length > 1:
            LOG: "PARALLEL VERIFY: {ready_scenarios.length} scenarios ready — spawning batch"
            FOR EACH scenario IN ready_scenarios (IN PARALLEL):
                scenario_context = RUN `node {STATE_CLI} $SPEC_FOLDER next --context` → parse JSON, filter to {scenario.id}
                SPAWN a fresh SIBLING Task subagent — spawned directly by THIS orchestrator turn, never
                    nested inside a build subagent — as the NAMED verifier subagent
                    (subagent_type: "eque2-verifier"; its SubagentStart hook mints the role marker)
                    with prompt from references/verify-subagent-prompt.md
                    (substituting task_id={scenario.id}, action={action}, context_info={scenario_context})
            WAIT for all parallel subagents to complete
            FOR EACH scenario IN ready_scenarios:
                outcome = RUN `node {STATE_CLI} $SPEC_FOLDER query scenario/{scenario.id}` → parse JSON
                IF outcome.status == "failed":
                    → Route to 03-review.md with failed_id={scenario.id}
                    → After review completes, return to loop
            CONTINUE (back to 2a)

        LOG: "Spawning {action} for {task_id}. Expected ~{estimate} minutes."
        SPAWN a fresh SIBLING Task subagent as the NAMED verifier subagent
            (subagent_type: "eque2-verifier") with prompt from references/verify-subagent-prompt.md
            (substituting task_id, action, context_info)
        → Apply circuit breaker (2g) and outcome check (2h) to this spawn, then CONTINUE

    # 2e. PARALLEL TASKS — batch independent tasks (opt-in)
    IF parallel_enabled AND action IN ["build", "check"]:
        all_tasks = RUN `node {STATE_CLI} $SPEC_FOLDER query task/*` → parse JSON stdout
        pending_tasks = filter WHERE status == "not_started"

        independent_tasks = filter pending_tasks WHERE no dependency overlap with any other pending task

        parallel_batch = select from independent_tasks WHERE
            agent confirms tasks operate on different file areas (use judgment)

        IF parallel_batch.length > 1:
            LOG: "PARALLEL TASKS: {parallel_batch.length} independent tasks — spawning batch"
            LOG: "Independence reasoning: {explain why tasks don't conflict}"
            FOR EACH task IN parallel_batch (IN PARALLEL):
                task_context = RUN `node {STATE_CLI} $SPEC_FOLDER next --context` → parse JSON, filter to {task.id}
                SPAWN general-purpose Task subagent with prompt from references/subagent-prompt.md
                    (substituting task_id={task.id}, action={action}, context_info={task_context})
            WAIT for all parallel subagents to complete
            FOR EACH task IN parallel_batch:
                outcome = RUN `node {STATE_CLI} $SPEC_FOLDER query task/{task.id}` → parse JSON
                IF outcome.status == "failed":
                    → Route to 03-review.md with failed_id={task.id}
                    → After review completes, return to loop
            CONTINUE (back to 2a)

    # 2f. SEQUENTIAL — single subagent (build / review / check)

    # LARGE-TASK GATE — build tasks over the size threshold run IN-SESSION, not delegated.
    # Field-observed harness failure: build subagents wedge silently for 8-64 minutes
    # chunk-reading large source/spec files and produce nothing; tighter prompts, design
    # docs, and line-range pointers did NOT prevent it. Detection via circuit breaker
    # costs ~20 min per attempt. Building in the orchestrator session is reliable.
    IF action == "build":
        total_lines = RUN `wc -l` over the files named in context_info (files to modify + their spec/test files)
        IF total_lines > 1500 OR any single file > 800 lines:
            LOG: "LARGE TASK: {task_id} touches ~{total_lines} lines — building IN-SESSION (subagents stall on large-file reads)"
            Execute build-task/SKILL.md yourself, in this session, for {task_id} —
                same TDD flow, same state CLI calls, same journal writes as a subagent would make.
            NOTE: review and verify for this task still go to fresh subagents as normal —
                the fresh-context anti-bias guarantee lives there, not in the builder.
            → Apply outcome check (2h), then CONTINUE

    LOG: "Spawning {action} for {task_id}. Expected ~{estimate} minutes."
    SPAWN general-purpose Task subagent with prompt from references/subagent-prompt.md
        (substituting task_id, action, context_info)

    # 2g. CIRCUIT BREAKER — poll every 10 minutes (references/circuit-breaker.md)
    IF subagent is background:
        EVERY 10 minutes: check TaskOutput for progress
        IF two consecutive polls show no progress:
            TaskStop the subagent
            LOG: "CIRCUIT BREAKER: {task_id} killed — no progress for ~20 minutes"
            Write journal/{task_id}-circuit-breaker.md with timestamp and last state
            → Route to 03-review.md with failed_id={task_id}

    # 2h. Check outcome
    actor_type = "task" if action IN ["build","review","check"] else "scenario"
    outcome = RUN `node {STATE_CLI} $SPEC_FOLDER query {actor_type}/{task_id}` → parse JSON stdout

    IF outcome.status == "failed":
        → Route to 03-review.md with failed_id={task_id}
        → After review completes, return to loop

    CONTINUE

END WHILE
```

### 3. Max iterations reached

If the loop exits because `iteration >= max_iterations`:
→ Route to `04-complete.md` with exit_reason="max_iterations"

## Supervised mode

Before spawning each subagent, show the `next` recommendation and ask:
- Approve, choose an alternate, skip, or abort.

## Progression

Exits via routing to `03-review.md` (failure) or `04-complete.md` (termination).
