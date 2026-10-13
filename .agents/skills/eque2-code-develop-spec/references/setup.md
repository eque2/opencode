Language: {communication_language}

# Stage 1: Setup

Validate the spec folder, initialise state if needed, optionally create a git worktree, and update metadata before execution begins.

## Rules

- **NEVER** edit state files directly — all state changes via the state CLI (`node {STATE_CLI} $SPEC_FOLDER <verb> ...`).
- Run autonomously. The only user prompts in this stage are the worktree question and the parallel question.
- Read this entire stage before acting.

## Sequence

### 1. Validate spec folder

Verify these files exist in `$SPEC_FOLDER`:

```
CHECK: spec.md
CHECK: definitions.json
```

If missing, output and EXIT:
```
SPEC_INVALID: Required files not found in {SPEC_FOLDER} (missing: spec.md|definitions.json)
```

### 2. Extract spec slug

Read `$SPEC_FOLDER/spec.md` frontmatter. Extract `feature-id`. If absent, derive from the folder basename. Store as `SPEC_SLUG`.

### 3. Initialise state

Run `node {STATE_CLI} $SPEC_FOLDER status`.

- **Exit 0** → state is already initialised. Log: `STATE: Already initialised — resuming.` Skip to step 4.
- **Non-zero exit (not initialised / no state files)** → run `node {STATE_CLI} $SPEC_FOLDER init`.

**HARD STOP:** If `init` exits non-zero (its stderr message is the failure reason — the CLI's failure signal is a non-zero exit code, not an `isError` field), EXIT immediately:
```
SETUP_FAILED: state init rejected — check definitions.json conforms to schemas/actor-definitions@1
```

Do NOT proceed with uninitialised state.

### 4. Stuck-running recovery

Run `node {STATE_CLI} $SPEC_FOLDER query --status=building "*"`.

For each actor returned:
```
Run: node {STATE_CLI} $SPEC_FOLDER update {actor.id} fail \
  --reason "Stuck in building state — session interrupted, resetting for retry"
```

Log: `RECOVERY: {n} stuck actor(s) reset.` (skip log if n=0).

**Also check for a verifier backlog** (parents stranded in `verifyingSubtasks` by an interrupted session): run `node {STATE_CLI} $SPEC_FOLDER query --status=completed --trust-level=verified,pending_review "task/*"`. If non-empty, do NOT reset or force anything — this backlog drains as the orchestrator loop dispatches `verify`/`verify-scenario-trust` subagents (execute.md step 2d); there is no background process to restart. Follow **"Verifier-Backlog Recovery (verifyingSubtasks)"** in `autonomous-rules.md` (confirm the loop is dispatching verify subagents, let the circuit breaker handle any real stall, wait for the drain). Log: `RECOVERY: verifier backlog of {n} actor(s) detected — see autonomous-rules.md.`

### 5. Worktree decision

```
Create an isolated git worktree at .claude/worktrees/{SPEC_SLUG}?
Worktrees let you work on this feature in a separate directory while keeping
the main working tree clean — useful when running multiple features simultaneously.

[Y] Yes — create worktree
[N] No — work in the main repo directory
```

**If `.claude/worktrees/{SPEC_SLUG}` already exists** (resume scenario):
- Check `git worktree list` — if the path appears, it is valid. Reuse it, set `use_worktree = true`, skip creation.
- If the directory exists but is not in `git worktree list`, offer to clean it up or skip.

**If Y — create worktree:**
```bash
git worktree add .claude/worktrees/{SPEC_SLUG} -b feature/{SPEC_SLUG}
```
If the branch already exists, omit `-b`. If creation fails, warn and set `use_worktree = false`.

**If use_worktree = true:**
- Log: `WORKTREE: Created at .claude/worktrees/{SPEC_SLUG} on branch feature/{SPEC_SLUG}`
- Run `node {STATE_CLI} $SPEC_FOLDER metadata --set worktree_path=.claude/worktrees/{SPEC_SLUG}`

**If use_worktree = false:**
- Log: `WORKTREE: Skipped — working in main repo directory`

### 6. Parallel execution opt-in

If `--parallel` flag was provided, set `parallel_enabled = true` and skip the prompt.

Otherwise: `"Run independent tasks in parallel when possible? (y/n)"` → store as `parallel_enabled`.

## Progression

→ `02-execute.md`
