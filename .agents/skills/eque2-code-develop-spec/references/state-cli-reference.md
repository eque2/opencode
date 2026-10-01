# state.mjs CLI Reference

**Invocation:** `node {STATE_CLI} <spec-folder> <command> [options]` — every call operates on one `specFolder` (absolute path to the feature folder). `{STATE_CLI}` is the bundled `state.mjs` shipped at `{skills-root}/eque2-code-setup/scripts/state.mjs` (see Conventions in `SKILL.md`) — no `npx tsx`, no MCP server, no Docker.

Every call prints **one JSON object to stdout** on success and exits `0`. On failure it prints a diagnostic to stderr and exits non-zero — treat any non-zero exit as a HARD ERROR; do not retry blindly. This file mirrors `state.mjs --help` (`printHelp()`); if the two ever drift, the CLI's own `--help` output is authoritative.

---

## next

Compute the next recommended action.

```
node {STATE_CLI} $SPEC_FOLDER next [--context] [--count=N]
```

| Option | Notes |
|--------|-------|
| `--context` | Include full snapshot context (journal entries) in the result |
| `--count=N` | Max recommendations to return |

Returns: `{ recommendation: { id, action, context }, alternates, ... }` where `action` is one of `build`, `review`, `verify`, `check`, `verify-scenario-trust`. `recommendation` is `undefined` when nothing remains.

---

## update

Issue a machine verb (state transition).

```
node {STATE_CLI} $SPEC_FOLDER update <id> <verb> [--reason <text>] [--journal <text>] [--next] [--force]
```

| Option | Notes |
|--------|-------|
| `<id>` | Actor ID (e.g. `T1.2`, `S1`) |
| `<verb>` | One of the machine verbs — see below |
| `--reason <text>` | Explanation; written to the journal (required for `update` calls) |
| `--journal <text>` | Explicit journal message (overrides `--reason`) |
| `--next` | Append next recommendations to the response |
| `--force` | Bypass trust transition validation |
| `--commit-sha=<sha>`, `--exit-code=<code>`, `--duration-ms=<ms>`, `--screenshots=<paths>` | Attach evidence to the transition |

**Machine verbs:** `start`, `complete`, `fail`, `skip`, `reset`, `retry`, `suspect`, `verify`, `trust`, `reverify`

**Note on `complete`:** `complete` does not *declare* an actor finished — it is a claim that **triggers Layer-1 structural verification**. For a task or build check, call `update <id> complete` after the work is done; the runtime runs the structural check and only advances the actor (→ `verified`, then `trusted` via the trust-verdict path) if it passes. If structural verification does not pass, the actor is **not** completed and the response carries the reason as a side effect (`type: completion-verification-failed`) — read it, fix the gap, and call `complete` again. Do **not** fall back to `verb: fail`. Scenarios are normally verified automatically by the vitest scenario-state-reporter rather than an explicit `complete`.

---

## query

Filter actors by pattern, status, dependency, or type.

```
node {STATE_CLI} $SPEC_FOLDER query [--status=<s>] [--depends-on=<id>] [--type=<t>] <pattern>
```

**Common patterns:**

| Invocation | Returns |
|------|---------|
| `query "*"` | All actors |
| `query "task/*"` | All task actors |
| `query "scenario/*"` | All scenario actors |
| `query "task/T1.2"` | Specific actor |
| `query --status=building "*"` | Actors stuck in building state |
| `query --status=not_started "task/*"` | Pending tasks |

---

## done

Mark the spec done; returns gate analysis.

```
node {STATE_CLI} $SPEC_FOLDER done
```

Returns: `{ done: boolean, stalled: boolean, reason, summary }`

---

## status

Show actor counts and per-phase progress.

```
node {STATE_CLI} $SPEC_FOLDER status [--pretty]
```

---

## verify

Run Layer-1 evidence verification (structural/coverage — the route that moves trust from `untrusted`/`pending_review` towards `verified`).

```
node {STATE_CLI} $SPEC_FOLDER verify <id>|--all|--reset-trust [--coverage-json=<path>] [--commit=<sha>] [--evidence=<path>] [--exit-code=<code>]
```

For scenarios, the scenario-state-reporter only WRITES the evidence (`{specFolder}/evidence/<id>.json`); the verify subagent then runs `verify <id>` to consume it. For tasks/build checks `update <id> complete` triggers the same Layer-1 verification (see the note under `update`).

A scenario passes Layer 1 only when the evidence is signed, matches the test file's source hash, names the scenario, the test file names the scenario, AND the evidence records a passing run: `exitCode` is `0`, every `testResults[]` entry is `passed` or `skipped`, and at least one entry is `passed`. Signed evidence of a failing run fails `verify` (reason: "evidence records a failing run …"); an empty or all-skipped run fails too (reason: "evidence records no passing test") and takes the normal fail path — `testPassed` is read from the evidence, never assumed.

A failure where the ONLY failed check is traceability (the test passed, but the file never names the scenario) spends no retry: the machine state (`executing`, `completed`, …) and `retryCount` stay as they are. Trust IS demoted — a scenario at `pending_review`, `verified` or `trusted` drops to `untrusted`, and the reason says "no retry spent"; a scenario already at `untrusted` keeps its trust. Fix the name (`verify-{FEATURE}-{ID}.spec.ts`, or a `[{ID}]` title tag), then re-run `verify`.

**Correcting a scenario that was completed on bad evidence.** `fail` is not legal from `completed`. The sanctioned correction is:

1. `update <id> suspect --reason "<why the completion is wrong>"` — marks the trust as suspect.
2. Re-run the scenario's test with the reporter attached, so fresh evidence is written.
3. `verify <id>` — a failing run now demotes the scenario and resets it for re-execution; a passing run lands it at `verified` again.

---

## verdict

Layer-3 trust write (semantic promotion/rejection) — the only route that mints or rejects final trust.

```
node {STATE_CLI} $SPEC_FOLDER verdict <id> <trusted|rejected> --reason "<text>"
```

`--reason` is required — a verdict without a reason is inauditable. This verb is intended for the verification path only; it is not gated at the CLI/argument level (anyone who can invoke the state CLI can call it), so enforcement is policy-based — never call it from a build role. See `references/verify-subagent-prompt.md` for the trusted calling convention.

---

## set-testfile

Repoint a scenario's `testFile` at a consolidated spec file.

```
node {STATE_CLI} $SPEC_FOLDER set-testfile <id> <test-file> --reason "<text>"
```

When a TDD build consolidates several scenarios into one spec file (e.g. S2's file also asserts
S3/S4), the absorbed scenarios' per-scenario files from `definitions.json` don't exist and their
verification would dead-end. Instead of duplicating coverage into per-scenario files:

1. Tag each absorbed scenario's tests in the consolidated file with `[S{N}]` in the describe/it
   title (e.g. `it('[S3] closes over the queued item', ...)`) — the vitest scenario-state-reporter
   emits separate, HMAC-signed evidence per tagged scenario from the single run. A tag on a nested
   `it` inside a `describe` counts, and any id in the scenario grammar tags (`[DELIVERY-2]`,
   `[AU3]`).
2. Repoint each absorbed scenario: `set-testfile S3 <path-to-consolidated-file> --reason "..."`.
3. Run the consolidated file through vitest with the reporter as normal — each scenario's
   evidence then verifies against the consolidated file.

After a repoint, the reporter writes a scenario's evidence ONLY from its registered file. A stale
file that still carries the old `[S{N}]` tag (or the old `verify-…-S{N}.spec.ts` name) writes no
evidence for that id and prints a stderr WARNING, so it cannot overwrite the good evidence.

The target file must already exist (repointing at a missing file is rejected). `--reason` is
required and journaled. The consolidated file must still name the repointed scenario — the `[S{N}]`
tag from step 1 satisfies the `scenarioTraceable` structural check. Structural verification does
**not** look for the Gherkin step text; paraphrasing the clauses in your assertions is fine, and
quoting them earns nothing. Whether the test actually proves the scenario is Layer 3's call.

---

## cascade

Propagate trust changes upstream/downstream from a trigger actor.

```
node {STATE_CLI} $SPEC_FOLDER cascade <trigger-id> [--direction=upstream|downstream|both] [--max-depth=<n>]
```

---

## metadata

Read or update the spec metadata block.

```
node {STATE_CLI} $SPEC_FOLDER metadata [--set key=value ...]
```

**Examples:**

| Invocation | Effect |
|------|--------|
| `metadata` | Read current metadata |
| `metadata --set phase=execute` | Set phase |
| `metadata --set worktree_path=.claude/worktrees/slug` | Set worktree path |

---

## init

Initialise state from `definitions.json`.

```
node {STATE_CLI} $SPEC_FOLDER init
```

Reads `{specFolder}/definitions.json` and constructs the initial XState snapshots in the spec folder's signed plaintext state files. The state CLI is the sole writer of runtime state from this point. Rejects malformed definitions — treat rejection as a HARD ERROR.

`init` also refuses a scenario the reporter could never route: an id outside the scenario id grammar (`[A-Z]+-?\d+(?:-[A-Z]+)*(?:\.\d+)?[a-z]?` — e.g. `S1`, `S14b`, `AU3`, `DELIVERY-2`, `BUILD-1`, `C4-RESET.1`), a `testFile` not named `verify-{FEATURE}-{ID}.spec.ts`, or a `testFile` whose name routes to a different id. The error names each id and testFile; fix the spec and regenerate `definitions.json`. Also runs a deep health self-test on success and writes the first `.state-health.json` heartbeat.

---

## health

Deep self-test of the state + verification pipeline. Use it as a pre-flight before trusting verification results, or any time the pipeline seems off.

```
node {STATE_CLI} $SPEC_FOLDER health
```

Returns `{ command: "health", ok, timestamp, version, checks }` where `checks` covers `db`, `evidenceKey`, `integrity`, `trustGraph`, `claudeWorker`, `evidencePathRoundtrip`, and `scenarioFilenameRouting` — each `{ ok, detail? }`. Writes the result to `{specFolder}/.state-health.json` (the heartbeat is also refreshed on every state mutation). Disable all health writes with `EQUE2_HEALTHCHECK=0`. A `false` on any subsystem means verification cannot be fully trusted until resolved.
