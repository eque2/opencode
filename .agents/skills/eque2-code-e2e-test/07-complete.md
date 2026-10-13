Language: {communication_language}

# Stage 7: Complete (block R — result record)

Terminal stage. Write the handoff artifact and surface the next step. Reached by four paths: success, bounded-loop failure, indeterminate, or skip/abort.

## The handoff artifact (always written)

Write `{feature_artifacts}/e2e-test-{slug}/e2e-test.md` — the durable record (modelled on `[BF]`'s `bug-fix.md`). `[ET]` does **not** record against the state machine; an E2E test is not a tracked actor. The file captures: `{ticket_key}`, stepCount, the spec path (if any), engine depth, outcome (`PASS` / `FAILED` / `INDETERMINATE` / `SKIPPED` / `ABORT`), and the reason for any non-PASS. This is the single source of truth for what happened.

## Success

```
E2E TEST: {spec-path}
Xray:     {ticket_key} — {stepCount} steps → {stepCount} test.step() blocks
Result:   PASS ({npx playwright test} green)
Engine:   {core|full}
Committed on {branch/worktree}.

Next: run [PR] to review the diff, confirm the full suite is green, and open the PR.
```

Write the handoff with outcome `PASS`. Hand back to Linus dispatch.

## Failure (verification not green after the bounded loop)

```
E2E TEST: {spec-path} — NOT COMMITTED
Xray:     {ticket_key}
Result:   FAILED after 3 fix iterations
Last error: {summary}

The test is left in the working tree for inspection. Either it surfaced a real app bug
(fix the app, then re-run [ET]) or it needs manual attention. Not handed to [PR].
```

Write the handoff with outcome `FAILED` + the last error. Do not commit, do not push.

## Indeterminate (could not verify — not a pass, not a fail)

Reached from Stage 6's indeterminate contract: the test cannot verify its spec because a required prerequisite data/state is absent, or the app went unresponsive/froze. No green was forced and no fallback data was substituted.

```
E2E TEST: {spec-path} — NOT COMMITTED
Xray:     {ticket_key}
Result:   INDETERMINATE — {reason, e.g. "required data <id> absent" | "app unresponsive"}

The test could not be honestly verified — this is neither a test failure nor a confirmed app
bug. Resolve the prerequisite (seed the data / restore the environment) and re-run [ET], or
investigate the unresponsiveness. The spec is left in the working tree for inspection.
```

Write the handoff with outcome `INDETERMINATE` + the specific cause. This is surfaced **distinctly** from FAILED and from SKIPPED so a reviewer sees "honestly could not verify" as its own signal — an environment/data gap, not a broken test and not a silent skip. Do not commit, do not push.

## Skip / abort

Reached from Stage 1 (tests opted out), Stage 2 (non-Jira spec, Xray creds missing, or no Xray definition), or Stage 3/4 (unsatisfiable precondition, element not found).

```
E2E TEST: skipped — {reason}
{ticket_key (if any)}

No test written. {For "no Xray definition": recorded as ABORT.}
⚠️ MISSING E2E COVERAGE for {ticket_key}: this change is proceeding without an automated
   end-to-end test. {If part of a [DS]→[PR] flow: [PR] can still run, but note the gap.}
```

Write the handoff with outcome `SKIPPED` (or `ABORT` for the no-Xray-definition case). **The missing-coverage warning is surfaced loudly, not buried in a log** — a skip is a coverage gap, and a reviewer must see it. In headless runs, the warning still lands in the handoff so the gap is visible to whoever reads it.

## Progression

Terminal. Append the outcome (`PASS` / `FAILED` / `INDETERMINATE` / `SKIPPED` / `ABORT`) to the session log and return to Linus dispatch.
