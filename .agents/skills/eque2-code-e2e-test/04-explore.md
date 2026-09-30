Language: {communication_language}

# Stage 4: Explore (blocks M + X)

**The rule that makes tests non-flaky: explore the live UI before writing any selector. Never guess a locator.**

## Sequence

### 1. POM-first (M)

For each distinct page/screen the steps touch, generate a page-object **stub** under `{TEST_CODE_DIR}/pages/` — a class with named, intention-revealing methods and locator placeholders. Stubs encode *what* the page exposes; the locators are filled in next against the real DOM.

### 2. Explore-first (X)

Drive the **Playwright MCP** against `BASE_URL` (authenticated via `storageState` if configured):

- Walk each Xray step live, in order.
- For every element a step interacts with or asserts on, read the real DOM and choose a locator by the priority in `references/engine.md`: `getByRole` > `getByLabel` > `getByPlaceholder`/`getByText` > `getByTestId`. **Never** settle for brittle CSS, `nth`, or a `waitForTimeout`.
- Back-fill the POM stubs with the confirmed locators.
- Build an element inventory: step → POM method → confirmed locator → the assertion its expected result implies.
- **Record freeze hazards.** If the live UI hangs or spins indefinitely on a step (e.g. during server-side processing), note it explicitly against that step as a freeze hazard. Stage 5 must then guard that interaction with a **bounded recovery** (a bounded-visibility race, not an unbounded `isVisible()`), so a freeze fails fast as INDETERMINATE in Stage 6 rather than consuming the whole test budget.

If a step's element cannot be found in the live UI, that is a signal, not a nuisance — the change may be incomplete, or the step may not match the implementation. Interactive: ask whether to continue, adjust, or skip. Headless: skip this test via the Stage 7 skip path (reason "step element not found in live UI"). Either way the skip becomes a **loud MISSING COVERAGE entry** in the handoff (Stage 7) — never a silent pass. A half-built feature must not quietly end up with no test and no warning.

## Constraints

- Exploration is read-only reconnaissance — it does not write the spec file. That's Stage 5.
- Every locator that lands in the test must have been confirmed against the live DOM here.

## Progression

POM back-filled and every locator confirmed → load and execute `05-implement.md`.
