Language: {communication_language}

# Stage 1: Initialise

**Progress: Stage 1 of 4** — Sync the folder, seed the lifecycle server, load knowledge, set the dials.

No subagents yet, no test code yet. This stage's outcome: a synced set of Xray definitions, a lifecycle record per definition, a knowledge-injection block, a chosen engine depth, and clean loop state — everything Stage 2 needs to start dispatching.

## Sequence

### 1. Resolve the folder

From the input (see SKILL.md Inputs): the argument is the Xray folder; no argument → `XRAY_TEST_FOLDER` from `.env`; neither → interactive lists folders via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` and asks, headless fails fast with reason "no Xray folder specified". Store as `{xray_folder}`.

### 2. Sync the definitions (xray CLI only — never bespoke scripts)

```
node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs sync --folderId={xray_folder} --conflictPolicy=merge
```

Definitions land under `{XRAY_OUTPUT_DIR}` (default `./test-plans`). Then enumerate what the folder holds:

```
node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs tests --folder={xray_folder}
```

Capture per test: ID, name, `stepCount`. This is the batch's worklist universe. An empty folder is a clean exit: say so in one line, write a minimal report (Stage 4's empty-run path), and stop.

### 3. Seed the lifecycle server

Ensure the tests CLI's state holds **one record per synced definition**. For each test ID not yet known to it, register it in state **`pending`** via `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs update --testId=<id> --event=SEED --folderPath=<path> [--xrayKey=<key>] [--testFilePath=<path>]` (the registration/seed event). Records that already exist keep their current state — seeding is idempotent and never resets progress:

- Terminal records (`verified_passing`, `failed`) and `blocked` records are **not** re-seeded and **not** dispatched — note them now for the report (with the `failed`/`blocked` reasons the state carries) so Stage 2 can bulk-skip them without spending a subagent.
- In-flight records (`building`, `awaiting_verification`, `needs_compliance_fix`, `needs_run_fix`) stay as they are; Stage 2 dispatches them so their subagents can resume from the recorded state.

Success criterion: `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` accounts for every ID returned by `xray-cli.ts tests` — no definition is invisible to the lifecycle state.

### 4. Load the test-knowledge cache

```bash
mkdir -p {output_folder}/test-knowledge
uv run {skill-root}/scripts/knowledge-cache.py inject \
  --dir {output_folder}/test-knowledge \
  --max-entries {test_knowledge_max_entries} \
  --max-kb {test_knowledge_max_kb}
```

Store stdout verbatim as `{test_knowledge_block}` (empty on a cold start — that is fine). Stage 2 injects it into every subagent prompt, and rebuilds it between refills so knowledge written mid-run benefits later subagents.

### 5. Choose engine depth

Default `{engine_depth_default}` (ships as `core`); a `--depth` flag wins. Interactive: confirm in one line ("Engine depth: core — say 'full' for the complete Strategy-6 sweep"). Headless: take the resolved value silently. Store as `{engine_depth}`. Likewise resolve `{concurrency}` = `--concurrency` flag or `{batch_concurrency}`.

### 6. Initialise and reconcile loop state

```bash
uv run {skill-root}/scripts/backfill-state.py init \
  --dir {project-root}/_bmad-output/test-artifacts/backfill
```

`init` creates the state directory and default files, and reports any `parked-tasks.json` entries left by a prior session. Reconcile them **before** anything is dispatched:

1. If the prior-parked list is non-empty, surface one non-blocking line: `[parked-recovery] Found N parked tasks from a prior session — reaping orphan handles.`
2. Stop each orphan task handle (idempotent on dead handles), record `lost_on_session_restart = N` plus the test IDs for the report, then `backfill-state.py clear-parked`.
3. Their tests are *not* lost — their lifecycle records still hold whatever state they reached, so step 3's seeding already put them back on the worklist where appropriate.

Finally, mark the loop alive: `backfill-state.py heartbeat`.

### 7. Read the last run's report (don't repeat exploratory work)

If a prior `backfill-report-*.md` exists under `{project-root}/_bmad-output/test-artifacts/backfill/`, read the newest one's **Verifier health & stalls** and **Where the logs are** sections. There is no container anymore, so verification runs as a fresh subagent per `BUILD_COMPLETE` submission, and its Playwright artifacts land on the host directly — no bind-mount needed. If the last run recorded verifier stalls or recurring failures, you already know where the artifacts are (`{EQUE2_TESTS_LOG_DIR}`, default `{project-root}/.eque2-tests/runs/{testId}/{runId}/`) and what stuck — surface one line (`[prior-run] last batch saw N verifier stall(s) at stage=X; artifacts under .eque2-tests/runs/`) so this run starts informed rather than re-investigating. Skip silently if there is no prior report.

## Progression

Worklist universe known, server seeded, knowledge block in hand, dials set, loop state clean → load and execute `02-fan-out.md`.
