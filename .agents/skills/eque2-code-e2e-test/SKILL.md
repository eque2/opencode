---
name: eque2-code-e2e-test
description: Generate one Playwright E2E test for a completed change, gated on an existing Xray definition. Use when the user selects [ET], says 'generate e2e test', 'ET <ticket>', or asks for a Playwright test for the change just built.
---

# E2E Test

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Generate exactly **one** Playwright end-to-end test for a completed change, between `[DS]` (develop-spec) and `[PR]` (create-pr). The test is driven by the change's **Xray definition** — each Xray step maps 1:1 to a `test.step()` — and is authored against the **live UI** explored through the Playwright MCP, never against guessed selectors.

The workflow is **traceability-gated**: it builds a test only when an Xray definition with at least one step exists for the change. No definition → no test (HARD STOP). This makes the requirement (Xray) the source of truth and keeps unbacked, hallucinated tests out of the suite.

**Design rationale** — three things an LLM tends to skip, stated explicitly so they happen every run:
- **Gate before generating.** A test with no Xray definition behind it is a liability, not coverage. The gate runs *before* any code is written.
- **Explore before writing selectors.** Locators are confirmed against the live DOM via the Playwright MCP; semantic locators (`getByRole` first) are non-negotiable. Guessed CSS selectors are the dominant source of flake.
- **Gate on spec *fidelity* and *test quality*, not just a green run.** A green run is necessary but not sufficient — the verify stage blocks any pass until every Xray step is faithfully implemented with a real assertion (no omitted steps, no `console.log`-only "verification", no swallowed assertions), the green spec passes the `[TV]` best-practice validation gate against the anti-flakiness rubric (no hard waits, positional/CSS selectors, floating promises, or isolation debt), runs a cheap static gate, and is bounded to 3 fix iterations so a stuck test can't spin forever. A test that can't honestly verify (missing data / unresponsive app) is recorded **indeterminate**, never forced green.

**Scope boundary — this workflow does NOT open a PR.** It ends when the test is verified green and committed under `{TEST_CODE_DIR}`. Review, suite-green confirmation, and push are `[PR]`'s job — keeping them separate mirrors the existing `[DS]`/`[PR]` split and means a generated test is never auto-shipped.

## Conventions

- Bare paths (e.g. `01-first-breath.md`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory (where `customize.toml` lives).
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.

## Inputs

The workflow argument (`ET <arg>`) identifies the completed change to test:

- **Spec folder path** (optionally `@`-prefixed) → the `[CS]`/`[DS]` feature folder. Use directly.
- **Feature slug** → resolve to its feature folder under `{feature_artifacts}`.
- **Jira key** (matches `^[A-Z][A-Z0-9_]*-\d+$`, e.g. `CMC-12345`) → resolve the feature folder whose `{ticket_key}` is this key.
- **No arg** → use the most recently `[DS]`-completed spec folder; if ambiguous, ask which one.

From the resolved feature folder, two facts drive everything downstream:
- **`{ticket_key}`** — the Jira/Xray key (the gate's lookup key), resolved the way `[CS]` resolves it.
- **Jira mode** — whether `{feature_root}/jira/` is present with a `{ticket_key}` matching the key regex.

Also resolved from config: `{communication_language}`, `{feature_artifacts}`, and the test config established at First Breath (`TEST_CODE_DIR`, `BASE_URL`, engine depth, the tests-necessary flag).

## On Activation

This skill runs standalone (`/eque2-code-e2e-test CMC-12345`) or dispatched by Linus between `[DS]` and `[PR]`. Unless the activation context already carries resolved config and a passing pre-flight (Linus just ran them this turn):

1. **Resolve customisation:** `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. **Load config:** `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}` and `{feature_artifacts}`.
3. **Run shared pre-flight:** `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root} --project-docs-glob '{workflow.project_docs_glob}'` (see `eque2-code-setup/references/pre-flight-checks.md`). If `project_docs` is failing, apply the **Project Documentation Gate** — strongly recommend running `bmad-project-context` first and offer to launch it before generating the test. This workflow additionally requires, and the gate stages re-check:
   - a **Playwright MCP** registered (live-UI exploration in Stage 4 depends on it);
   - the **xray CLI** (`xray-cli.ts`) resolvable, providing the `sync` + `test` verbs — these back the gate and the fetch (see `references/xray-fetch.md`).
   Missing Playwright MCP or an unresolvable xray CLI is a blocker surfaced here, not mid-generation.

### Sanctum awareness — the test-infrastructure gate

E2E generation leans on Linus's recorded project knowledge: BOND.md's **"Their Test Infrastructure"** section (framework, where tests live, naming convention) seeds Stages 1, 3 and 5. As in `[BF]`, the gate keys on the **knowledge**, not on sanctum presence, and runs on **every** dispatch path:

1. **Make sure the sanctum's knowledge is in context.**
   - Standalone with a complete sanctum (`{project-root}/_bmad/_memory/linus-sidecar/INDEX.md` has `birth_status: complete`): batch-load `PERSONA.md`, `CREED.md`, `BOND.md`, `MEMORY.md`, `CAPABILITIES.md`, become Linus.
   - Dispatched by Linus: already loaded this turn.
   - No sanctum / `birth_status: incomplete`: nothing to read — proceed; First Breath (Stage 1) will establish what's needed.
2. **First Breath (Stage 1) is the authority for test config.** Sanctum knowledge enriches it but does not replace it — Stage 1 still confirms `TEST_CODE_DIR`, the tests-necessary flag, and `test-standards.md` exist before any generation.

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | first-breath | Run-once setup gate: ensure test config (`TEST_CODE_DIR`, tests-necessary flag, engine depth) + `test-standards.md` exist; if any missing, establish them inline and persist; reuse anything already present | `01-first-breath.md` |
| 2 | xray-gate | Jira-sourced precondition; resolve `{ticket_key}`; **fetch** the Xray definition via the state-server fetch verb; HARD STOP / skip if `stepCount == 0` | `02-xray-gate.md` |
| 3 | prepare | Blocks **P + C**: load the fetched definition, `.env`, `test-standards.md`, `playwright.config`; assemble context; handle preconditions | `03-prepare.md` |
| 4 | explore | Blocks **M + X**: generate POM stubs, then walk each step live via the Playwright MCP, confirming every locator against the DOM and back-filling the POM | `04-explore.md` |
| 5 | implement | Block **L**: write the spec, mapping each Xray step to a `test.step()`; commit in 3 layers (navigation → interactions → assertions), each passing before the next | `05-implement.md` |
| 6 | verify | Run the suite; **always-on gates** (fidelity: step-coverage + per-step assertion + swallow/bypass lint + read-back; **`[TV]` best-practice validation** — the `eque2-code-test-validation` skill scores the green spec against the anti-flakiness rubric, a hidden internal gate as `[XC]` is in Stage 2; cheap static gate; indeterminate contract); fix up to **3 iterations**; **full engine only**: resilience audit (**A**) + parallel healer (**H**); commit the test | `06-verify.md` |
| 7 | complete | Block **R**: record the result, surface the next step (`[PR]`); on skip/abort, log it and exit cleanly with no test written | `07-complete.md` |

**Engine depth** (set at First Breath, persisted to config, default **core**) selects which blocks Stage 6 runs:
- **core (default):** `P → C → M → X → L → R` + Verify/fix-≤3×. Drops the resilience audit (A) and parallel healer (H).
- **full:** all eight Strategy-6 blocks, including the parallel healer (H).

See `references/engine.md` for the block catalog, conventions (locator priority, layout, `playwright.config` at project root), and the produced test shape.

## Output

Every run writes a **handoff artifact** at `{feature_artifacts}/e2e-test-{slug}/e2e-test.md` (the durable record — modelled on `[BF]`'s `bug-fix.md`; `[ET]` does **not** record against the state machine, since an E2E test is not a tracked actor). It captures `{ticket_key}`, stepCount, the spec path, engine depth, and the outcome (pass / fail / indeterminate / skip / abort + reason).

- **On success:** exactly one `*.spec.ts` under `{TEST_CODE_DIR}/tests/` (plus any POM files under `pages/`), verified green **and fidelity-gated**, committed; the handoff records PASS. Stage 7 tells the developer to run `[PR]` next.
- **On indeterminate:** the test could not honestly verify (prerequisite data/state absent, or the app went unresponsive). No green is forced and no fallback data substituted — the spec is left uncommitted in the working tree; the handoff records INDETERMINATE + cause, surfaced distinctly from a failure.
- **On no Xray definition:** no spec file. Headless logs the skip and exits; interactive offers `[r] re-fetch · [s] skip · [c] cancel`. A confirmed HARD STOP records an `ABORT` (reason "no Xray definition") in the handoff.
- **On non-Jira spec:** `[ET]` does not apply — it exits cleanly with a one-line explanation and writes only the handoff (reason "non-Jira spec").

## Dispatch

After the On Activation bootstrap and sanctum gate:

- **Dispatched by Linus:** config + pre-flight ran this turn and the sanctum is loaded — load and execute `01-first-breath.md` directly.
- **Standalone** (`/eque2-code-e2e-test` or `ET <arg>`): the bootstrap resolved config + pre-flight and the sanctum gate ran. Greet the user briefly in `{communication_language}` (as Linus if the sanctum loaded), then load and execute `01-first-breath.md`.

The seven stage prompts and `references/engine.md` carry the substantive work. Run stages in order; each ends by handing to the next, except the gate stages (1, 2) which may exit early per their rules.
