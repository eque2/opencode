Language: {communication_language}

# Stage 1: First Breath — run-once setup gate

A **mandatory, run-once precondition gate**, not optional onboarding. It runs on **every** dispatch. Its job is to guarantee the test config + tooling exist before any generation; if anything is missing it establishes it inline, persists it, and continues. It reuses anything already present (including config left by a prior `eque2-test` install) rather than re-asking.

**Reconfigure:** if invoked as `ET --reconfigure` (or the user asks to change the setup), clear the stored answers below and re-run the Q&A from scratch. This is the documented escape hatch — see the tests-necessary note.

## Where config is stored

`[ET]` owns its settings in **`.env`** and **`{project-root}/_bmad/_memory/e2e-test/`** — *not* the `eque2-code` section of `config.yaml`, which `eque2-code-setup` regenerates on update (writing there risks silent loss). Keys in `.env`:

| Key | Meaning |
|---|---|
| `TEST_CODE_DIR` | where specs are written (colocated vs separate repo) |
| `E2E_TESTS_NECESSARY` | `true` / `false` — the opt-out gate |
| `E2E_ENGINE_DEPTH` | `core` (default) / `full` |
| `XRAY_TEST_FOLDER` | the Xray folder (path or id) this project's tests live under — the gate syncs it |
| `BASE_URL`, `TEST_USERNAME`/`TEST_PASSWORD` | app under test + auth (may already exist) |

Human rationale (why these choices) goes in `{project-root}/_bmad/_memory/e2e-test/`.

## Sequence

### 1. Check what's present

Read `.env` and `docs/CLAUDE/test-standards/test-standards.md`. Determine which of these are missing:
`TEST_CODE_DIR`, `E2E_TESTS_NECESSARY`, `E2E_ENGINE_DEPTH`, `XRAY_TEST_FOLDER`, `test-standards.md`, the Playwright toolchain (step 4), the Playwright MCP (step 5).

- **`E2E_TESTS_NECESSARY=false` and not `--reconfigure`** → this project has opted out. Say so in one line and exit cleanly (Stage 7 skip path, reason "tests not necessary for this project"). **To re-enable: `ET --reconfigure`.**
- **All present** → skip to Stage 2 (`02-xray-gate.md`). Do not re-ask.
- **Some missing** → run only the missing steps below, persist, continue.

### 2. Setup Q&A — only for missing items, in order

Headless: do **not** prompt — apply documented defaults and record the auto-decision (`E2E_TESTS_NECESSARY=true`; `TEST_CODE_DIR=./e2e` unless an existing Playwright test dir is detected; `E2E_ENGINE_DEPTH=core`; `XRAY_TEST_FOLDER` = the configured `XRAY_OUTPUT_DIR` scope or, if unknown, fail fast — see step 6).

1. **"Are Playwright tests necessary for this project?"** — `no` records `E2E_TESTS_NECESSARY=false` and exits cleanly (re-enable via `--reconfigure`).
2. **"Where should I write the Playwright test files — colocated here, or an existing separate testing repo?"** → `TEST_CODE_DIR`.
3. **"Engine depth — `core` (default) or `full`?"** → `E2E_ENGINE_DEPTH`.
4. **"Which Xray folder do this project's tests live under?"** → `XRAY_TEST_FOLDER` (use `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` to list and let the user pick; reuse `XRAY_OUTPUT_DIR` if already configured).

### 3. Install Guidance → `test-standards.md`

If `docs/CLAUDE/test-standards/test-standards.md` is absent, generate it: **detect** stack (Playwright/Cypress/Jest; framework from `package.json`; existing POM/fixtures) → **discover** preferences (skip in headless) → **generate** the file with severity-tagged rules `[CRITICAL]/[IMPORTANT]/[RECOMMENDED]` across File Organization, POM, Selectors, Fixtures/Data, Assertions, Anti-Patterns.

**Defaults source — TEA-first, inline-fallback:** if `{project-root}/_bmad/tea/testarch/knowledge/{fixture-architecture,selector-resilience,data-factories}.md` exist, pull defaults from them; else fall back to `references/test-standards-defaults.md`. Never hard-depend on TEA. If `test-standards.md` already exists, reuse it.

### 4. Verify / install the Playwright toolchain

`[ET]` runs `npx playwright test`, so Playwright must actually be installed — do not assume it. Check `package.json` for `@playwright/test` and that browsers are installed:

- Missing package → install it in `TEST_CODE_DIR`'s repo: `npm i -D @playwright/test` (or the repo's package manager), then `npx playwright install` for browsers.
- Missing `playwright.config.ts` at **project root** → note it; Stage 5 creates a minimal one there.
- Headless: perform the install non-interactively; if it fails, fail fast with the install error (do not proceed to generate a test that can't run).

### 5. Verify / register the Playwright MCP

Stage 4 explores the live UI through a Playwright MCP. Check it is registered (e.g. via `/mcp` roster). If absent, register it (`claude mcp add --scope user playwright -- npx @playwright/mcp@latest`, or the project's chosen Playwright MCP) and note that a Claude Code restart may be needed before it is visible. If it cannot be registered, this is a blocker — stop with a clear message (Stage 4 cannot run without it).

### 6. Note Xray credentials (checked for real in Stage 2)

`XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET` back the fetch in Stage 2. They are not required to *configure* `[ET]`, but the gate needs them. If absent now, record a note; Stage 2 surfaces the gap before fetching (interactive asks; headless skips with reason "Xray credentials missing") rather than failing mid-fetch.

### 7. Persist

Write the resolved keys to `.env`; write rationale (why each choice; the tests-necessary decision and how to reverse it) to `{project-root}/_bmad/_memory/e2e-test/`.

## Progression

Config present and tests are necessary → load and execute `02-xray-gate.md`. Tests opted out → exit cleanly (Stage 7 skip path).
