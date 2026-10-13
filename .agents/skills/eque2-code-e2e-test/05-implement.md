Language: {communication_language}

# Stage 5: Implement (block L — layered commitment)

Write the one `*.spec.ts`, using only the POM and the locators confirmed in Stage 4. Commit in three layers, running after each so failures are caught at the cheapest possible point.

## The test shape

One spec file at `{TEST_CODE_DIR}/tests/`, named for the feature/key. Structure per `references/engine.md`:

- `test.describe('{name} ({ticket_key})', …)` — the key in the title gives traceability back to the Xray definition.
- One `test(...)` with one `test.step('Step N: …')` per Xray step, **1:1**, in order.
- Assertions derive from each step's expected `result`.
- All element access goes through the POM; no inline raw selectors.

### Per-step assertion (HARD REQUIREMENT — write it right the first time)

Write to pass Stage 6's fidelity gate at write-time, so it rarely fires:

- **Every** numbered Xray step maps to a `test.step()` — none omitted, none merged away.
- **Every** VERIFY/Confirm step carries **at least one real `expect()`**. The following never count as verification and will be rejected by the gate: a step whose body is only `console.log`; a `try/catch` wrapping an `expect`; `.catch(() => false)` on an assertion; an `if (await x.isVisible())` guard used in place of `expect(x).toBeVisible()`; a blind `waitForTimeout` with no following assertion.
- Data entry into a field/grid cell is followed by a **read-back assertion** of that same cell; selecting a "latest" record asserts its **identity** (`toBe(createdId)`), not mere presence.
- A step that genuinely cannot be implemented/verified (required data or environment state absent) is **not** stubbed green — leave it to Stage 6's indeterminate contract rather than fake a pass.

If `playwright.config.ts` does not exist at project root, create a minimal one there (`baseURL`, a project, `storageState` auth) — never inside `{TEST_CODE_DIR}`.

## The three layers

Write and run incrementally; each layer must pass before the next is added:

1. **Navigation** — `page.goto` / routing to each screen the steps reach. Run; confirm the app lands where expected.
2. **Interactions** — fill/click/select for each step's actions, via POM methods. Run; confirm the flow executes without error.
3. **Assertions** — the `expect(...)` for each step's expected result. Run; confirm they pass against the real app.

A layer that fails is fixed here before proceeding — but do not enter an unbounded fix loop; the bounded verify/heal loop is Stage 6. If a layer cannot be made to pass within a couple of focused attempts, hand to Stage 6 with the failing layer noted.

## Constraints

- Obey `test-standards.md` (loaded in Stage 3) — File Organization, POM, Selectors, Assertions, Anti-Patterns.
- Follow the bundled anti-flakiness build-time guidance loaded in Stage 3 (see `eque2-code-test-validation/references/build-time-guidance.md`): climb the locator ladder (`getByRole` first, CSS/XPath last), disambiguate by `filter`/chaining not position, assert single matches with `toHaveCount(1)`, isolate every test, and never float a promise. Stage 6's `[TV]` gate scores the finished spec against this same standard — write it right here so that gate rarely fires.
- Every acted-on locator must resolve to exactly one element under strict mode (`count() === 1`); disambiguate by scoping, never a blanket `.first()`/`.last()`.
- Prefer Playwright's auto-waiting and web-first assertions over fixed sleeps. A bounded `waitForTimeout` is allowed only as a documented recovery escape-hatch paired with a bounded-visibility race (see `test-standards.md` Anti-Patterns) — never a blind sleep with no following assertion.

## Progression

All three layers written and locally passing (or handed over with a noted failing layer) → load and execute `06-verify.md`.
