# Build-Time Guidance — Author Playwright Tests That Don't Flake

> **Audience: the LLM authoring a Playwright test.** Follow these rules *while
> writing* the spec so it is compliant the moment it is committed. The companion
> `validation-rubric.md` scores a finished test against the same rules — write to
> pass it the first time. For unavoidable iframe / vendor-SPA constraints, see
> `constrained-spa-playbook.md`. Repo-agnostic.

A *flaky* test passes on one run and fails on another with no change to the code or
the system under test. Flakiness is a defect in the **test**, not the framework —
Playwright gives you deterministic tools; these rules are how you use them.

---

## The 10 build-time rules (imperative)

1. **Never write `waitForTimeout` into a committed test.** A fixed sleep is blind to
   app state — too short fails, too long is slow *and* still fails when the app is
   slower than usual. It is a debug-only tool.
2. **Assert, don't sleep.** Synchronise with app state via web-first auto-retrying
   assertions: `await expect(locator).toBeVisible()`. Wait for the **final
   user-visible result**, not an intermediate signal (spinner gone, URL changed).
3. **Locate like a user — climb the locator ladder (below).** `getByRole` first;
   CSS/XPath only as a last resort.
4. **Disambiguate by content, not position.** Use `.filter({ hasText })` and
   chaining. Do not use `.first()` / `.last()` / `.nth()` to pick among matches —
   they gamble on render order.
5. **Assert single matches loudly.** When you expect exactly one element, add
   `await expect(locator).toHaveCount(1)` so ambiguity fails fast instead of
   silently selecting the wrong node.
6. **Make every test an island.** No dependency on test order or another test's
   output (files, DB rows). Set up your own state in `beforeEach`.
7. **Generate unique data; one identity per worker.** Unique test data
   (timestamp/UUID). One auth identity per worker — **never** a single shared user
   or one shared `storageState` across workers.
8. **Mock what you don't control.** Use `page.route()` for third-party /
   non-deterministic calls. For an API you *do* exercise, set up
   `page.waitForResponse()` **before** the triggering action.
9. **Never float a promise — `await` every Playwright call.** A missing `await` makes
   action order non-deterministic. The `@typescript-eslint/no-floating-promises`
   rule catches it.
10. **Don't paper over races with timeouts or retries.** Raising timeouts masks
    races; retries are a *diagnostic* (`trace: 'on-first-retry'`), not a cure. A
    test that needs retries to pass has a real bug — fix the cause.

---

## Locator priority ladder

| Priority | Locator | Use for |
|---|---|---|
| 1 | `getByRole(role, { name })` | Most interactive elements — mirrors assistive tech |
| 2 | `getByLabel` / `getByPlaceholder` | Form inputs |
| 3 | `getByText` | Non-interactive text (div/span/p) |
| 4 | `getByTestId` | Fallback when role/name unavailable (icon buttons, custom widgets). Treat the test-id as a **stable public contract** |
| 5 | CSS / XPath | Last resort only — brittle to DOM/styling changes, slower to evaluate |

**Disambiguate by scoping + filtering, never by position:**

```js
// DON'T — positional gamble
await page.getByRole('button', { name: 'Edit' }).first().click();

// DO — scope to the row by content, then descend
await page.getByRole('row').filter({ hasText: 'monserrat44@example.com' })
  .getByRole('button', { name: 'Edit' }).click();
```

For repeating containers (grids / tables / virtualised lists), anchor to the
specific row by content, or intersect the role locator with a structural constraint
that excludes repeating rows:

```js
locator.and(page.locator('xpath=//*[not(ancestor::*[@role="row"])]'))
```

---

## Choose the *most specific* signal you actually need

- UI result expected → web-first **assertion** (`toBeVisible`, `toHaveText`,
  `toHaveValue`).
- Route change → `await expect(page).toHaveURL(...)`.
- A specific API call must finish → set up `page.waitForResponse(...)` **before** the
  action that triggers it, then await it.

Don't replace one blind wait with another; match the wait to the real event.

---

## Isolation checklist (write it in from the start)

- Fresh state per test, set up in `beforeEach`; no dependence on another test having run.
- Unique data per test/worker (timestamp/UUID); or worker-indexed resources via
  `testInfo.workerIndex`.
- Per-worker auth state — not a single shared `storageState` file.
- Create-and-teardown via API in `beforeEach`/`afterEach`.
- No ordering dependencies, no shared files between tests.

---

## Pre-merge self-check (run against your own draft before finishing)

- [ ] No `waitForTimeout` in the committed test (debug-only).
- [ ] Every interaction uses a role/label/test-id locator; no positional
      `.first/.last/.nth` for disambiguation.
- [ ] Disambiguation via `filter`/chaining; single-match expectations assert
      `toHaveCount(1)`.
- [ ] Assertions are web-first (`await expect(locator)...`), never
      `expect(await locator.isVisible())`.
- [ ] Each test sets up its own state; no dependency on order or another test's artifacts.
- [ ] Test data is unique per test/worker; auth state is per-worker.
- [ ] Non-deterministic third-party calls are mocked where possible.
- [ ] `await` on every Playwright call (no floating promises).
- [ ] Timeouts are default/justified — not inflated to mask a race.
- [ ] Any `force: true` / `dispatchEvent('click')` / `evaluate(...click())` carries an
      inline justification comment.
