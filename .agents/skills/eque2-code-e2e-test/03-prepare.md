Language: {communication_language}

# Stage 3: Prepare (blocks P + C)

Assemble everything the engine needs before exploring or writing. No browser yet, no test code yet.

## Sequence

### 1. Preflight (P)

- Confirm `.env` provides `BASE_URL`, `TEST_CODE_DIR`, and test credentials. If `BASE_URL` or creds are missing, surface it and ask (headless: fail with a clear reason rather than guessing a URL).
- Confirm the Playwright MCP is reachable (Stage 4 needs it). If not, blocker — stop and report.
- Note any remediation patterns recorded from prior runs (recurring selector fixes, known-flaky areas).

### 2. Load the Xray definition

Read the JSON written by Stage 2 (`test-plans/{folderPath}/{ticket_key}.json`). Extract:
- `steps[]` — each `{ action, data?, result? }`. These map 1:1 to `test.step()` blocks.
- `preconditions[]` — setup the test must satisfy first.
- `url`, `name`, `priority` — for the `describe` title and navigation.

### 3. Handle preconditions

If `preconditions[]` is non-empty:
- **Interactive** → surface them and HALT for confirmation that they're satisfiable in the target environment (model on build-test's preconditions HALT). Proceed once confirmed.
- **Headless** → encode each precondition as setup (fixtures / `storageState` / a `beforeEach`) where mechanical; if a precondition cannot be satisfied automatically, log it and skip this test (Stage 7 skip path, reason "unsatisfiable precondition").

### 4. Context assembly (C)

- Load `docs/CLAUDE/test-standards/test-standards.md` as guidance (the locator/POM/anti-pattern rules the generated test must obey).
- Load the bundled anti-flakiness build-time guidance (see `eque2-code-test-validation/references/build-time-guidance.md`) — the canonical locator-ladder / auto-wait-over-hard-wait / isolation / no-floating-promises / container-scoping rules. This is the *same* standard Stage 6's `[TV]` gate scores the finished test against, so authoring to it here means the generated test starts compliant and clears that gate at write-time.
- Read `playwright.config.ts` at **project root** — confirm `baseURL`, projects, `storageState` auth setup. If absent, note it; Stage 5 will create a minimal one at project root.
- Scan `{TEST_CODE_DIR}/pages/` and existing `tests/` for patterns to match (existing POM, fixtures, naming).
- Confirm the engine depth (`core`/`full`) from config — it selects Stage 6's blocks.

## Progression

Context assembled, preconditions handled → load and execute `04-explore.md`.
