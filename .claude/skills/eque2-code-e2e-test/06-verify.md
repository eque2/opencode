Language: {communication_language}

# Stage 6: Verify (+ blocks A, H on the full engine)

Prove the test passes against the real app **and faithfully implements its Xray definition**, then commit it. A green run is **necessary but not sufficient** — the fidelity gate (3), the best-practice validation gate (4), and the static gate (5) must also pass before any PASS is recorded. The fix loop is **bounded to 3 iterations** — a stuck test must not spin forever.

## Sequence

### 1. Run

```
npx playwright test {spec-path} --reporter=list
```

Capture the full result (pass/fail per step, error output).

### 2. Verify/fix loop (≤3 iterations — both depths)

If the run fails:
- Diagnose the failure (selector drift, timing, an assertion that doesn't match the real expected result, an app bug surfaced by the test).
- Apply a targeted fix — re-confirm any changed locator against the live UI via the Playwright MCP (do not guess).
- Re-run.
- **Stop after 3 fix iterations.** If still failing, do not commit — hand to Stage 7 with the failure recorded (reason "verification failed after 3 iterations"); the developer decides next steps.

Distinguish a **test defect** (fix the test) from a **surfaced app bug** (the test is correctly red — report it; do not weaken the assertion to make it pass).

### 3. Fidelity gate (always-on — runs on the green test, before any PASS)

A green run only proves the code *ran*; it does not prove the test *implements the spec*. Before recording a pass, check the green spec against its Xray definition. A gate failure is a **compliance failure** — classify it `Specification Fidelity → incomplete/unfaithful implementation`, apply the fix, and re-run from step 1 **within the same 3-iteration budget**. A green-but-shallow test (omitted step, swallowed assertion, `console.log`-only "verification") is rejected here, not recorded green.

- **3a — Step coverage.** Count `test.step(` blocks in the spec and compare to the numbered step count in the Xray definition. Fewer blocks than steps ⇒ shallow ⇒ gate fails.
- **3b — Per-step assertion.** Every VERIFY/Confirm step carries at least one real `expect()`. A step whose body is only `console.log` does not verify anything.
- **3c — Swallow / bypass lint.** None of the verification-theatre patterns are present (`try/catch` around an `expect`, `.catch(() => false)` on an assertion, `if (await x.isVisible())` in place of `expect`, a blind `waitForTimeout` with no following assertion); and any `force: true` / `dispatchEvent('click')` / `evaluate(...click())` carries an inline justification comment (see `test-standards.md` Anti-Patterns). An undocumented bypass fails the gate.
- **3d — Read-back balance.** Each grid/field data-entry action is matched by a read-back assertion of that same cell (`toHaveValue` / equivalent). More entry actions than read-backs ⇒ a value could land in the wrong cell undetected ⇒ gate fails.

### 4. Best-practice validation gate — `[TV]` (always-on — both depths)

The fidelity gate (3) proves the test covers its *spec*; this gate proves the test is *not flaky* — it scores the green spec against the anti-flakiness rubric (hard waits, positional/CSS selectors, floating promises, captured `ElementHandle`s, networkidle waits, isolation debt). It is the same standard Stage 3/5 authored against, enforced after the fact.

Invoke the **`eque2-code-test-validation`** skill on the just-written `{spec-path}` (the Skill tool — your persona and loaded config carry through; config + pre-flight already ran this turn, so the skill skips its own bootstrap). This is a hidden internal gate on Linus — exactly how Stage 2 invokes `[XC]` — not a standalone menu option here. It loads `references/validation-rubric.md`, scores the spec, and returns a per-spec verdict.

- **compliant** (zero un-waived **blocker** findings) → the gate passes; proceed.
- **non-compliant** (one or more un-waived **blocker** findings) → a **compliance failure**. Classify it `Test Quality → flakiness anti-pattern`, apply the fix, and re-run from step 1 **within the same 3-iteration budget**. Mechanically-fixable findings (the rubric's **auto-fix: yes** rows) are remediated inline; **auto-fix: manual** findings (real expected values, isolation redesign, per-worker auth, locator-ladder rewrites) are fixed by hand against the live UI — re-confirm any changed locator via the Playwright MCP, never guess.
- A bounded+documented settle / documented `force` fallback on a legitimately constrained iframe/vendor SPA is reported `waived`, not a failure (see the skill's `constrained-spa-playbook.md`).

A test that **cannot** be made compliant within the budget (only manual blockers remain) is **surfaced, not forced green** — hand to Stage 7 with the failure recorded (reason prefixed `TEST-QUALITY:` — e.g. `TEST-QUALITY: unresolved flakiness anti-pattern`). Do not weaken or delete the rubric finding to make the gate pass.

### 5. Static gate (always-on, when the project exposes it)

A green run can still leave dead code or type errors. If the project exposes static-analysis scripts (detected at First Breath / from `package.json` — e.g. `typecheck`, `lint`, optionally `knip`), run them scoped to the suite before commit:

```
npm run typecheck && npm run lint   # add: && npm run knip — when present
```

A **new** type error, unused symbol, or dead export/file (beyond any recorded baseline) fails verification — fix it and re-run, within the 3-iteration budget. If the project has no such tooling, note it in the handoff and skip (optionally offer to scaffold a minimal `tsconfig`/eslint — never force it).

### 6. Indeterminate contract (honest non-pass, no forced green)

If the test cannot verify its spec because **prerequisite data/state the spec requires is absent**, or the **app is unresponsive/frozen** (a freeze hazard recorded in Stage 4 that did not clear within its bounded wait) — do **not** force a green pass and do **not** substitute fallback data to make it green. This is not a test defect and not an app bug; it is unverifiable. Stop the loop and hand to Stage 7 with an **INDETERMINATE** outcome (reason prefixed `INDETERMINATE:` — e.g. `INDETERMINATE: required data <id> absent` or `INDETERMINATE: app unresponsive`). An honest indeterminate is a true signal; a forced green is a false one.

### 7. Full engine only — resilience audit (A) + parallel healer (H)

Skip this section entirely when engine depth is `core`. The always-on gates (3, 4, 5) run regardless of depth; this section is the deeper sweep `full` adds on top.

**Boundary with Stage 5.** Stage 5 writes the test to obey `test-standards.md` and the bundled build-time guidance as it goes (write-time adherence). The resilience audit here is a distinct, after-the-fact **compliance sweep of the now-passing test** — it catches violations that survived write-time (a locator that drifted to CSS during fixing, a stray `nth`, a missing web-first assertion). On `core`, write-time adherence + the always-on gates are the compliance pass; `full` adds this sweep.

- **Resilience audit (A):** re-review the green test against `test-standards.md` — semantic locators, POM usage, web-first assertions, the reconciled `waitForTimeout` rule. Plus a deeper **locator-uniqueness sweep**: any acted-on locator whose `count() > 1` is a hard failure — scope it (region/role/`exact`) until it resolves to one element, never a blanket `.first()`; *preserve* a deliberate post-sort `.first()`/`.last()` whose replacement would reintroduce ambiguity. And a **bounded-recovery check**: any unbounded visibility query against a UI that can go unresponsive (a recorded freeze hazard) is replaced with a bounded race so a freeze fails fast (→ INDETERMINATE), not hangs the whole test. Apply compliance fixes and re-run.
- **Parallel healer (H):** for any step that remained flaky/failing within the 3-iteration budget, race **3 alternative implementations** of that step and keep the one that passes deterministically. For a wrong-interaction failure, rank the alternatives — (1) dismiss blocking overlays + `await expect(target).toBeEnabled()` + a normal click; (2) `scrollIntoViewIfNeeded()` / an alternate normal interaction (`fill` vs `type`, `selectOption` vs `click`); (3) **last resort** a bypass (`force`/`dispatchEvent`/`evaluate`) with the inline justification 3c requires. A genuinely unclickable control should fail honestly, not be bypassed by default.

### 8. Commit

Once green **and** the gates (3, 4, 5) pass, commit the spec file (and any POM/`playwright.config` additions) on the current branch / worktree. Do **not** push and do **not** open a PR — that is `[PR]`'s job.

### 9. Record the outcome

Write the outcome (pass / fail / indeterminate) + the spec path + stepCount + engine depth to the handoff artifact `{feature_artifacts}/e2e-test-{slug}/e2e-test.md` (Stage 7 owns the final write; this stage supplies the verification result). `[ET]` does **not** record against the state machine — an E2E test is not a tracked actor; the committed spec + the handoff file are the durable evidence.

## Progression

Green, gates passed, and committed → `07-complete.md` (success path). Still failing (or a gate unmet) after the bounded loop → `07-complete.md` (failure path). Unverifiable — missing prerequisite data / unresponsive app (step 6) → `07-complete.md` (indeterminate path); not committed.
