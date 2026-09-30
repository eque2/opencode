# Baked-in test-standards defaults (TEA-absent fallback)

Used by Stage 1 (`01-first-breath.md`) to seed `docs/CLAUDE/test-standards/test-standards.md` **only when** TEA knowledge (`{project-root}/_bmad/tea/testarch/knowledge/*`) is not installed. When TEA is present, prefer its content. These defaults encode current (mid-2026) Playwright best practice; adapt the generated file to the detected stack.

## File Organization
- `[CRITICAL]` Specs live in `{TEST_CODE_DIR}/tests/*.spec.ts`; page objects in `{TEST_CODE_DIR}/pages/*.ts`; shared setup in `fixtures/`.
- `[CRITICAL]` `playwright.config.ts` lives at the **project root**, never inside the test dir.
- `[IMPORTANT]` One spec per feature/ticket; name it for the feature and carry the Jira/Xray key in the `describe` title.

## Page Object Model
- `[CRITICAL]` All element access goes through a page object — no raw selectors inline in specs.
- `[IMPORTANT]` POM methods are intention-revealing (`login(user)`, not `clickButton()`); locators are private to the class.

## Selectors
- `[CRITICAL]` Locator priority: `getByRole` > `getByLabel` > `getByPlaceholder` > `getByText` > `getByTestId`.
- `[CRITICAL]` Forbidden: brittle CSS/XPath, `nth(...)`, index-based selection, and any selector not confirmed against the live DOM.
- `[CRITICAL]` Locator uniqueness: every locator that is acted on (`.click()`/`.fill()`/…) must resolve to **exactly one** element under Playwright strict mode (`count() === 1`). When an accessible name matches more than one element (e.g. a form field that shadows a same-named list cell, or a duplicate "OK"), disambiguate by **scoping** — `getByRole('dialog').getByRole('button', { name: 'OK', exact: true })`, a region/container, or `{ exact: true }`. Never paper over ambiguity with a blanket `.first()`/`.last()`, and never disable strict mode. A *deliberate* `.first()`/`.last()` is allowed only when it follows an explicit sort and removing it would reintroduce ambiguity — comment it.
- `[IMPORTANT]` Prefer accessible-name/role locators — they improve both stability and a11y signal.

## Fixtures / Data
- `[IMPORTANT]` Authenticate via `storageState`, not by scripting login in every test.
- `[IMPORTANT]` Use fixtures/factories for test data; avoid hard-coded shared records that create cross-test coupling.
- `[RECOMMENDED]` Each test sets up and tears down its own state; tests must pass in isolation and in parallel.

## Assertions
- `[CRITICAL]` Use web-first assertions (`await expect(locator).toBeVisible()`), which auto-retry. Never assert on a detached snapshot.
- `[CRITICAL]` Per-step assertion: every numbered spec step maps to a `test.step()`, and every VERIFY/Confirm step carries **at least one real `expect()`**. A green run that omits a step or "verifies" by `console.log` is a shallow test, not coverage.
- `[CRITICAL]` Read-back after data entry: a value typed into a field/grid cell must be matched by a read-back assertion of that same field/cell (`toHaveValue` / equivalent). A value can land in the wrong cell and still leave the run green — the read-back is what catches it.
- `[IMPORTANT]` Assert identity, not mere presence, when selecting a "latest/most recent" record: sort explicitly, then assert the opened record's id equals the just-created id (`expect(no).toBe(createdNo)`) — never `toBeTruthy()`, which lets the wrong record pass.
- `[IMPORTANT]` A filter/search is a hard action, not best-effort: after filtering, assert the post-condition (the result reflects only the filtered value) before proceeding.
- `[IMPORTANT]` Each assertion traces to an Xray step's expected result.

## Anti-Patterns
- `[CRITICAL]` Prefer auto-waiting / web-first assertions over fixed sleeps. `waitForTimeout` is **not** outright banned — a *bounded* settle/recovery wait is a legitimate escape-hatch against a known-unresponsive UI, but **only** when paired with a bounded-visibility race (so a freeze fails fast, not hangs the whole test) and an inline comment naming the limitation. A blind `waitForTimeout` with no following assertion is forbidden.
- `[CRITICAL]` Verification theatre — none of these count as verification, and a test that relies on them is failing even if green: a step whose body is only `console.log`; a `try/catch` wrapping an `expect`; `.catch(() => false)` on an assertion; an `if (await x.isVisible())` guard used in place of `expect(x).toBeVisible()`.
- `[CRITICAL]` No interaction bypass without justification: `force: true`, `dispatchEvent('click')`, and `evaluate(el => el.click())` are permitted only for a genuinely virtualised/off-screen control, each with a prior `scrollIntoViewIfNeeded()` and an inline comment naming the specific limitation. Default path is a real click after the blocking overlay clears and `await expect(target).toBeEnabled()`.
- `[IMPORTANT]` Do not weaken an assertion to make a red test pass; a correctly-failing test may be surfacing a real bug.
- `[IMPORTANT]` No unused fixtures or dead references: a test's declared fixtures, imports, and POM calls must reflect what it actually exercises (a static pass — `tsc --noUnusedLocals` / unused-imports / `knip` — enforces this where available).
- `[RECOMMENDED]` No conditional control flow that hides flake (`if (await locator.isVisible())` to dodge failures).
