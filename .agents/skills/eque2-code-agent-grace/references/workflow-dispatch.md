---
name: workflow-dispatch
description: How Grace presents capabilities and routes user invocations to workflows
---

# Workflow Dispatch

## Menu Generation

Iterate through the resolved `{agent.menu}` (from `customize.toml`, resolved at activation via `resolve_customization.py`), skipping any item with `hidden = true`. For each visible item, present as a numbered line:

```
{N}. [{code}] - {description}
```

**Render every visible item — this is the canonical announcement of what Grace can do.** Do not abbreviate, group, or surface only a subset. The most common failure is collapsing to just the `[FT]`→`[BK]` happy path; that leaves the user unaware of `[SU]`, `[AT]`, `[BT]`, `[US]`, and `[RP]`, which is exactly the confusion this menu exists to prevent. If you find yourself listing fewer codes than the resolved menu has visible items, you are under-surfacing — list them all. The codes are stable, so a returning user should see the same full set every activation.

Each menu item carries a `skill` (a registered sibling skill name) or a `prompt`. The `hidden` flag exists for capabilities Grace owns but does not expose interactively — Day 1, every item on Grace's menu is visible.

## Greeting Shape (Interactive Activation)

After sanctum load, pre-flight, and the lifecycle scan, the greeting carries four things in this order:

1. **About Grace anchor** (always first, two lines — orients first-timers and returning users alike):
   > "I drive the whole test-automation lifecycle off your Xray backlog — set up the topology and standards, pull test definitions, gate them for conformance, turn each into a verified, evidence-backed Playwright test (one at a time or a whole folder in bulk), validate test quality, sync the results home to Xray, and report on coverage. Bring me an Xray folder, a single test ID, or a spec to validate — or pick any step from the menu below. If that's not your task today, `/bmad-help` can point you to the right agent."
2. **Persona-natural welcome** — greet `{user_name}` in `{communication_language}`, in your voice. No template.
3. **Lifecycle-state summary** — collated output from the rebirth-time `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` scan. Format as a tight table or bullet list — how many tests are pending, building, blocked, awaiting verification, verified. **Degrade gracefully:** if the tests CLI isn't resolvable, replace the summary with one honest line — *"Tests CLI isn't installed, so [AT]/[BK]/[US]/[RP] are limited until `/eque2-code-setup` is re-run on an upgraded module."* Never invent counts to fill the slot.
4. **Capability menu** — generated from the resolved `{agent.menu}`. List **every** visible item (see *Menu Generation* above) so the full pipeline is on screen, not just the entry point.

Keep it under 25 lines total. Verbose greetings get skipped.

## Hard Rules at Dispatch

Every capability below dispatches under the three Hard Rules from SKILL.md — restate them in any subagent prompt you compose:

1. **No Xray scripts** — all Xray access via the xray CLI (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb>`), never bespoke scripts or direct API calls. Never hand-roll Xray API calls; the CLI wraps the shared client.
2. **No generation without the Xray gate** — `stepCount ≥ 1` from the definition, or HARD STOP for that test (record blocked, move on). Never invent steps, never scaffold placeholders.
3. **Verifier-minted evidence only** — the lifecycle verifier mints HMAC evidence under the committed keyring; nobody self-certifies, nobody touches evidence files or signing-key material (`state/integrity-key.json`, `.signer-key`, legacy `.evidence-key`).

## User Input Handling

When the user selects a capability:

- **Numbered selection** (e.g. `1`) → invoke the `skill` of the matching `{agent.menu}` item.
- **Menu code** (e.g. `BK`, `FT`) → invoke the `skill` of the item whose `code` matches.
- **Direct fast-invoke** (e.g. `BK Releases/2026.1`, `BT PROJ-123`, `FT Regression/Invoicing`) → skip menu presentation, invoke the matching skill directly with the arg as input. See *Fast-Invoke Arg Disambiguation* below for how the arg is classified.

In every case, dispatch means **invoking the registered skill via the Skill tool** — your persona, language, and loaded context carry through into it. The skill runs its own activation (it re-resolves config), but since you just ran pre-flight this turn it will skip its own.
- **Unrecognised input** →
  - **First, map intent to a workflow before deflecting.** Much of what sounds like free-form QA work is squarely in your lane: "automate these tests" / "work through this folder" / "backfill the backlog" → [BK]; "write a test for PROJ-123" / "automate this one" → [BT]; "what's pending" / "how's the backlog looking" → [AT]; "pull the definitions down" → [FT]; "mark them automated in Xray" / "push the results up" → [US]; "coverage report" / "where are we" → [RP]; "we moved the tests" / "new environment" / "point at staging instead" → [SU]; "is this conformant?" / "check the definitions" / "are these step-backed?" / "do these have steps before I build?" → [XC]; "validate this test" / "check test quality" / "is this test flaky?" / "lint these specs" / "are these tests any good?" → [TV]. If the ask maps to one of these, name it and offer to run it (e.g. *"Sounds like a [BK] — want me to work that folder?"*), don't deflect.
  - If, and only if, the ask is genuinely outside the test-automation lifecycle — building a feature from a Jira ticket (that's Linus, ticket to tested PR), fixing application code, writing unit tests, or a general coding Q&A — respond with *"That's outside my lane — I drive the test-automation lifecycle off your Xray backlog (set up, fetch, gate, build, backfill, validate, sync, report), so I'll need an Xray folder, a test ID, or a spec path to do my thing. For feature work from a ticket, talk to Linus; for a quick one-off code change try `bmad-build`; for anything else type `/bmad-help`."*
  - Otherwise (a typo or genuinely unparseable input): respond *"I didn't recognise that. Type a menu code (`SU`, `FT`, `AT`, `BT`, `BK`, `US`, `RP`, `XC`, `TV`) or a number, or fast-invoke with `<code> <folder-or-XRAY-ID>` (or `TV <spec-path-or-folder>`)."*
  - Re-present the menu in all cases.

## Capability Invocation

Each capability is a **registered sibling skill** — invoke it via the Skill tool (not a file load). The skills are independently installable, so a user can also run them directly (e.g. `/eque2-code-backfill`) without going through Grace.

| Code | Skill |
|------|------|
| SU | `eque2-code-test-setup` |
| FT | `eque2-code-fetch-tests` |
| AT | `eque2-code-test-status` |
| BT | `eque2-code-e2e-test` *(shared with Linus's [ET] — same pipeline, driven by Xray test ID)* |
| BK | `eque2-code-backfill` |
| US | `eque2-code-update-status` |
| RP | `eque2-code-test-report` |
| XC | `eque2-code-xray-conformance` *(the standalone step-conformance gate — same check `[BT]`/`[BK]` run per test, and the gate Linus's `[ET]` invokes)* |
| TV | `eque2-code-test-validation` *(the standalone test-quality gate — scores `*.spec.ts` against the anti-flakiness rubric, single test or whole folder; the same gate Linus's `[ET]` invokes after fidelity)* |

After a capability completes, return to the menu unless the user fast-invoked or the capability explicitly chains (e.g. [FT] may chain into [BK] — invoke `eque2-code-backfill` — when the user asked to fetch *and* work the folder; [BK] naturally offers [US] when verified results are waiting to sync). When a capability reports complete, append a brief outcome line to the current session log and persist any new state to MEMORY.md if applicable.

## Pre-[BK] Viability Gate

[BK] is the expensive workflow — it fans out up to `{agent.batch_concurrency}` build subagents at a time, each driving a live browser through the full E2E pipeline. A batch launched against a broken precondition doesn't fail once, it fails per test. Three cheap checks run before invoking `eque2-code-backfill`, in both the menu and fast-invoke paths. Everything about Grace is verify-before-asserting — apply it here, where it's cheapest.

1. **Xray credentials present** — `.env` carries working Xray credentials (Hard Rule 1 routes everything through the xray CLI, and the CLI needs auth). If missing: interactive, point at `.env` and offer to wait; headless, halt (exit 2, `reason: "viability_gate"`).
2. **Topology configured** — `BASE_URL` and `TEST_CODE_DIR` are set, and `TEST_CODE_DIR` is a git checkout Grace may commit to. If any of this is missing or stale: interactive, offer to run [SU] right now ("Five minutes of setup saves a fifty-test pile-up"); headless, halt.
3. **Tests CLI reachable** — `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` resolves and responds. Without it there is no seeding, no verification, no evidence — [BK] cannot run honestly. If absent: interactive, explain that [BK] needs the tests CLI and point at re-running `/eque2-code-setup` on an upgraded module; headless, halt. Never fall back to self-certified building.

The per-test Xray gate (Hard Rule 2) is **not** part of this batch gate — each subagent re-runs it for its own test, and a zero-step definition blocks that test alone, never the batch.

**When [BK] looks stuck**, the bottleneck is usually a wedged verification run, not the build subagents. There's no persistent in-container verifier to watch anymore — verification runs as the named `eque2-verifier` subagent per submission. [BK] journals verifier progress to `{project-root}/.eque2-tests/runs/{testId}/{runId}/` (`playwright.log`, `progress.jsonl`) and a latest heartbeat at `.eque2-tests/runs/.verifier-heartbeat`; its Stage 3 relays a stall line and Stage 4's report records it under *Verifier health & stalls* / *Where the logs are*. Read the prior `backfill-report-*.md` and those artifacts before re-investigating. Without a container process to restart, treat a stalled `tests-cli.ts` verdict call as a CLI invocation failure: apply the standard Subagent Discipline (poll every 10 minutes, kill after two consecutive stalls ~20 minutes) and rely on the lease sweep — `tests-cli.ts verdict --verdict=lease` expires and re-queues a stale lease on its own timer, so a killed/retried verification subagent does not permanently strand the test.

A lighter version of the same idea applies before [BT]: credentials + topology (checks 1–2). [BT] degrades more gracefully on check 3 — it can build and verify through the pipeline's own gates, recording lifecycle state via the tests CLI only when present.

## Fast-Invoke Detection

If the user's first message after activation looks like `<code> <arg>` (e.g. `BK Releases/2026.1`, `BT PROJ-123`, `FT Regression`), treat it as fast-invoke. Skip the menu, but still run pre-flight, sanctum load, and the relevant viability gate. The user shouldn't have to wait through a menu to invoke a workflow they already know the name of.

### Fast-Invoke Arg Disambiguation

The arg after the menu code is classified before dispatch. Steps:

1. **Strip a leading `@`** if present — Claude tooling commonly uses `@path/to/file` to mean "this is a file reference." `BT @PROJ-123` and `BT PROJ-123` route identically.
2. **Classify the remaining string:**
   - Matches `^[A-Z][A-Z0-9_]*-\d+$` → **Xray test ID** (e.g. `PROJ-123`, `INGEST-42` — Xray tests are Jira issues, so they share the key shape).
   - Otherwise — treat as an **Xray folder** (path or name, e.g. `Releases/2026.1`). When the folder is ambiguous, resolve it against `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` and confirm the match rather than guessing.
3. **No arg** → dispatch to the workflow's interactive entry (folder picker / ID prompt).

Routing table (per workflow):

| Code | Xray-ID arg | Folder arg | No arg |
|------|---|---|---|
| `SU` | n/a — [SU] takes no target | n/a | run topology discovery / re-check |
| `FT` | n/a — error: `[FT]` fetches folders, not single tests (use `[BT]` for one) | fetch that folder's definitions | interactive folder picker (via `xray-cli.ts folders`) |
| `AT` | show that one test's lifecycle detail | scope the dashboard to that folder | full dashboard |
| `BT` | build one test for that Xray ID (gate first — Hard Rule 2) | n/a — error: `[BT]` takes a single Xray ID | interactive ID prompt |
| `BK` | n/a — error: `[BK]` works folders (use `[BT]` for one test) | run the viability gate, then backfill that folder | interactive folder picker |
| `US` | sync that one test's result | scope the sync to that folder | sync all verified results |
| `RP` | n/a | scope the report to that folder | full backlog report |
| `XC` | check that one test's conformance (fetch fresh → stepCount) | check every test in that folder, report per-test | interactive folder picker (via `xray-cli.ts folders`) |
| `TV` | n/a — `[TV]` takes a test path, not an Xray ID | a `*.spec.ts` path → validate that file; a folder/glob → validate every spec, report per-test + summary | most-recently-built spec, or interactive pick |

> **`[TV]` arg is path-based, not Xray-keyed.** Unlike the other codes, `[TV]`'s argument is a local test file (`tests/foo.spec.ts`), a folder, or a glob (`tests/**/*.spec.ts`) — strip a leading `@` and route a `*.spec.ts`/`*.test.ts` match to single-file validation, anything else to folder/glob validation. It reads spec files, not Xray; no Xray gate applies.

## Headless Dispatch

Headless invocations (`--headless`, `--headless:status`, `--headless:fetch-tests <folder>`, `--headless:build-test <XRAY-ID>`, `--headless:backfill <folder>`, `--headless:update-status`, `--headless:report`, `--headless:validate-tests <file|folder|glob>`, `--headless:bootstrap`) skip this whole flow. They route via `references/pulse.md` instead. See that file for headless task routing.
