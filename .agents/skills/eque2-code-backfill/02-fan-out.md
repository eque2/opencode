Language: {communication_language}

# Stage 2: Fan Out

**Progress: Stage 2 of 4** — Dispatch the build subagents.

Outcome: every non-terminal test has (or will get, as slots free up) one background subagent executing the shared `eque2-code-e2e-test` pipeline (stages 2–7) against its Xray test ID. The parent dispatches and tracks; it never builds a test itself.

## Sequence

### 1. Build the worklist

From Stage 1's enumeration and seeding: drop tests whose lifecycle state is terminal (`verified_passing`, `failed`) or `blocked` — these were bulk-skipped without a subagent. Everything else (`pending`, `building`, `awaiting_verification`, `needs_compliance_fix`, `needs_run_fix`) goes on `{worklist}`. Report once:

```
{total} tests in {xray_folder} · {skipped} already terminal/blocked · {remaining} to process
Depth: {engine_depth} · Concurrency: {concurrency}
```

If `{remaining}` is 0, hand straight to Stage 4 — nothing to build.

### 2. Dispatch with a sliding window

Spawn background subagents up to `{concurrency}` at a time (default 5), one per test, **as the NAMED builder subagent** (`subagent_type: "eque2-builder"` — its definition carries the mint-verb deny hook; verifier-only-minting CAP-1). As tests reach a terminal pattern, Stage 3's loop refills the window from `{worklist}` — refills rebuild `{test_knowledge_block}` first (Stage 1 step 4) so mid-run knowledge propagates.

Each subagent's prompt is the template below with every `{…}` placeholder resolved to its actual value before spawning. Topology values (`BASE_URL`, `TEST_CODE_DIR`, `XRAY_OUTPUT_DIR`) come from `.env` at the project root — resolve them once here; subagents receive resolved paths, they do not re-derive topology.

### 3. The subagent prompt template

The three rule blocks below are load-bearing and **must be embedded verbatim in every subagent prompt** — they are the same rules Grace lives by, restated where they bind because subagents do not inherit the parent's context.

````
You are building Playwright test {TEST_ID} as part of a batch backfill. Work fully
autonomously — never ask questions, never prompt for input.

CONTEXT
- PROJECT ROOT:      {PROJECT_ROOT}
- BASE_URL:          {BASE_URL}
- TEST_CODE_DIR:     {TEST_CODE_DIR}
- XRAY_OUTPUT_DIR:   {XRAY_OUTPUT_DIR}
- XRAY FOLDER:       {XRAY_FOLDER}
- ENGINE DEPTH:      {ENGINE_DEPTH}
- PIPELINE:          {skills-root}/eque2-code-e2e-test/

TASK
Execute the shared E2E pipeline stages 2–7 for Xray test {TEST_ID}: load and follow
02-xray-gate.md, then 03-prepare.md, 04-explore.md, 05-implement.md, 06-verify.md,
07-complete.md from the PIPELINE directory, in order, in headless mode, treating
{TEST_ID} as the resolved ticket key. Use the engine depth given above. Report your
lifecycle progress to the tests CLI as you go: `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs update
--testId={TEST_ID} --event=<VERB> [--reason=<text>]` (BUILD_STARTED when you begin
generating; events per the state-machine contract).

XRAY GATE RULE (HARD STOP — verbatim, non-negotiable)
No test generation without a passing Xray gate. A test is only ever built from an
existing Xray definition with stepCount ≥ 1. If the gate fails for {TEST_ID}, HARD
STOP for this test: record it blocked via `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs update
--testId={TEST_ID} --event=GATE_FAILED --reason="no Xray definition / 0 steps"`,
generate nothing, scaffold nothing, invent nothing — the batch continues without you.

NO-XRAY-SCRIPTS RULE (verbatim, non-negotiable)
All Xray access goes through the xray CLI verb surface (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb>
[--flag=value ...]` — sync, folders, status, diff, test, tests, steps) — never
bespoke Xray shell/Node scripts, never direct API calls from this prompt. Never
hand-roll Xray API calls; the CLI wraps the shared client.

SUBAGENT CIRCUIT BREAKER (verbatim, non-negotiable — these are constraints, not
suggestions)
- Maximum 3 fix-and-retry iterations for any single issue. After 3 failed attempts,
  stop and report results.
- Never set bash timeout above 180000ms (3 minutes) for any single command.
- If a command produces zero output for >120 seconds, kill it and report as failed.
- Do NOT attempt to read, modify, or fabricate evidence files or `.evidence-key` —
  this is enforced by policy (deny rules + HMAC verify-at-read catches tampering on
  the next read), not a structurally unbypassable fence. Treat it as a hard rule
  regardless.

VERIFICATION (you do not self-certify)
When your test runs green locally and the pipeline's verify stage is satisfied,
commit it, then submit it for independent verification:
`node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs update --testId={TEST_ID} --event=BUILD_COMPLETE
--testFilePath=<absolute spec path>`.
The eque2-verifier subagent independently runs the compliance rubric and a live
Playwright execution and mints HMAC evidence on pass. If it returns
needs_compliance_fix or needs_run_fix, apply a targeted fix and resubmit via
`node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs update
--testId={TEST_ID} --event=FIX_SUBMITTED --testFilePath=<absolute spec path>` —
within your 3-iteration budget. A local green run is a claim, not a result; only
verified_passing counts. Your terminal verb is BUILD_COMPLETE — the mint verbs
are never yours (this exact act caused incident CMC-32874):
Clause A — never-probe: Privileged verbs (`verdict`, `force-reset`,
`verification-reset`) are never invoked to see what happens, to discover flags,
or to test validation. Discovery is `--help` only. Sole exception: inside a
disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode (the sanctioned
test path this project's own suite uses).
Clause B — anti-reclassification: Running a mint verb IS minting, whatever you
call it — probe, test, dry run, experiment. There is no intent exception outside
the sanctioned canary mode above; the CLI records the invocation as an attempt
regardless of outcome.

ON SUCCESS — record what you learned
Write a short success note (symptom, fix, files touched) to
{OUTPUT_FOLDER}/test-knowledge/{TEST_ID}.md, then register it:
  uv run {SKILL_ROOT}/scripts/knowledge-cache.py add \
    --dir {OUTPUT_FOLDER}/test-knowledge --test-id {TEST_ID}
Skip this entirely on any non-pass outcome.

{TEST_KNOWLEDGE_BLOCK}

TERMINAL OUTPUT
Your very last line must be exactly one of (nothing after it):
  PASSED: {TEST_ID}
  FAILED: {TEST_ID} — <brief reason>
  BLOCKED: {TEST_ID} — <gate reason>
  ABORTED: {TEST_ID} — <systemic issue, e.g. app down, auth broken>
````

`{TEST_KNOWLEDGE_BLOCK}` is Stage 1's injection block (possibly empty). When non-empty it begins with the header `## Test knowledge from prior runs` — tell-tale fixes from earlier in this run and previous runs; subagents should scan it before diagnosing from scratch.

### 4. What the parent does NOT do

- It does not triage, categorise, or pre-analyse the suite — the per-test gate and the server decide.
- It does not pause mid-batch to discuss patterns or options. Systemic observations go in the report (Stage 4), not in interrupts.
- It does not mark anything `verified_passing` — that transition is the server's alone, on minted evidence.

## Progression

First window of subagents dispatched and tracked (task handle, test ID, start time, last-output hash per task) → load and execute `03-poll-and-recover.md`. The fan-out and the loop overlap by design: Stage 3 owns all refills from here on.
