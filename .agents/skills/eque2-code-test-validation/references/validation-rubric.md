# Validation Rubric — Scoring an Existing Playwright Spec

> **Audience: the LLM validating a finished `*.spec.ts`.** For each test, walk every
> row below, look for the detection cue, and record findings with their severity and
> line reference. The companion `build-time-guidance.md` is the same standard stated
> as authoring rules. Repo-agnostic.

## Severities

- **blocker** — a hard ban. A test carrying an un-justified blocker is **non-compliant**;
  it must be fixed (or the line explicitly justified) before the test is recorded green.
- **warning** — advisory. Surfaced in the report; does not by itself fail a test, but
  several warnings on one test is a quality signal worth fixing.

A finding is **waived** when the offending line carries an inline justification comment
(`// flaky-ok: <reason>`, or an equivalent documented reason for a bounded settle /
`force` / structural XPath). Waived findings are reported as `waived`, not as failures.

## Mechanically-fixable

Findings marked **auto-fix: yes** have a deterministic rewrite (see *Auto-fix transforms*
below) the validator may apply under the author's explicit confirmation (report + offer;
never silent). Findings marked **auto-fix: manual** need human/agent judgement (real
expected value, isolation redesign, per-worker auth, locator-ladder rewrites) and are
reported with guidance only — never auto-applied. The hard-ban blocker #1 is a third class:
its rewrite is **proposed for confirmation** (the replacement depends on the real
post-condition), not blindly applied.

**Precedence when a line matches more than one rule:** the **most-conservative** auto-fix
verdict wins. A line that any `manual` (or propose-on-confirm) rule would hold is **never**
auto-fixed under a `yes` rule — e.g. a missing `await` that is also part of a swallowed
assertion (#14) is handled as #14 (manual), not auto-`await`ed under #4. Severity follows
the same rule: report the highest severity that matches.

---

## Anti-pattern rubric

> The **What to look for** column gives a starting cue (often a regex) — it is a guide, not
> an exhaustive matcher. Read the surrounding code; flag the anti-pattern even when it takes
> a form the cue misses, and skip a cue hit that is genuinely benign.

| # | Anti-pattern | Severity | What to look for (cue) | Replace with | Auto-fix |
|---|---|---|---|---|---|
| 1 | Hard wait in committed test | **blocker** | `\.waitForTimeout\s*\(` (un-waived) | Web-first assertion / `waitForResponse` / `toHaveURL` on the real post-condition | propose* |
| 2 | Non-retrying visibility/enabled assertion | **blocker** | `expect\s*\(\s*await[^)]*\.(isVisible\|isEnabled\|isChecked\|isHidden)\s*\(\s*\)\s*\)` | web-first equivalent (auto-retries) — see transform T2 | yes |
| 3 | `networkidle` wait on long-poll/websocket app | **blocker** | `waitForLoadState\(\s*['"]networkidle['"]` | Assert the concrete post-load element instead | manual |
| 4 | Floating promise — missing `await` on a Playwright call | **blocker** | Playwright action/`expect` call statement with no leading `await`/`return`/`void` (and not matched by #14) | Add `await`; enable `@typescript-eslint/no-floating-promises` — see transform T4 | yes |
| 5 | Reused captured `ElementHandle` | **blocker** | `\$\(`/`\$\$\(` or `ElementHandle`, value reused across actions | Re-query via `Locator` each use (locators are lazy, never stale) | manual |
| 6 | Positional locator to dodge ambiguity | **warning** | `\.(first\|last\|nth)\s*\(` (outside a legitimate `or()` case) | `filter({ hasText })` + chaining; assert `toHaveCount(1)` to fail loud | manual |
| 7 | Deep CSS / XPath / `nth-child` locator | **warning** | `page\.locator\(\s*['"](//\|xpath=\|css=\|[.#][^'"]*>)` | Climb the ladder: `getByRole` → `getByLabel` → `getByTestId` | manual |
| 8 | `force: true` as a default click | **warning** | `force\s*:\s*true` (un-justified) | Clear/await the overlay, assert enabled, then a normal click | manual |
| 9 | Single-match without a count assertion | **warning** | _(judgement)_ a `.click()`/`.fill()` on a `getBy*` locator the test treats as unique, with no `toHaveCount(1)`/loop nearby | Add `await expect(loc).toHaveCount(1)` — only where uniqueness is genuinely intended | manual |
| 10 | Shared test user / single `storageState` | **warning** | one `storageState` path shared across projects/workers; one hard-coded login | Per-worker identity & auth state | manual |
| 11 | Inter-test ordering / shared-artifact dependency | **warning** | Test reads a file/record another test wrote; no own `beforeEach` setup | Independent setup per test; no ordering | manual |
| 12 | Bumped timeouts to mask flakiness | **warning** | `test.setTimeout(`/`timeout:` inflated well above default with no slow-op reason | Fix the race; reserve timeouts for genuinely slow ops | manual |
| 13 | Retries used to force green | **warning** | per-test `test.describe.configure({ retries })` raising retries to pass | Retries + trace for *diagnosis* only; fix the cause | manual |
| 14 | Verification theatre (swallowed assertion) | **blocker** | `try { ... expect ... } catch`, `.catch(() => ...)` on an assertion, `if (await x.isVisible())` used in place of `expect`, blind `waitForTimeout` with no following assertion | A real, un-wrapped `await expect(...)` | manual |
| 15 | Data entry with no read-back assertion | **warning** | _(judgement)_ a `fill()`/grid-cell write with no matching `toHaveValue`/identity assertion of that cell | Read-back assertion of the same cell (`toHaveValue` / `toBe(createdId)`) | manual |

\* #1 is `propose`: a blocker by ban, but the *correct* replacement depends on the real
post-condition, so the rewrite is **proposed for explicit confirmation**, not blindly
applied. Rows tagged _(judgement)_ (#9, #15) are not mechanical greps — they require reading
intent — so they are `manual`, never auto-applied.

### Auto-fix transforms (exact rewrites for `auto-fix: yes`)

Apply only these deterministic rewrites automatically (under confirmation); anything else is
`manual` or `propose`.

- **T2 — non-retrying assertion → web-first.** Map by the boolean method and its expected
  value, preserving negation:
  - `expect(await loc.isVisible()).toBe(true)` → `await expect(loc).toBeVisible()`
  - `expect(await loc.isVisible()).toBe(false)` → `await expect(loc).toBeHidden()`
  - `isHidden()` ↔ inverse of `isVisible()` (i.e. `…toBe(true)` → `toBeHidden()`)
  - `isEnabled()` → `toBeEnabled()` / `…toBe(false)` → `toBeDisabled()`
  - `isChecked()` → `toBeChecked()` / `…toBe(false)` → `toBeChecked({ checked: false })`
  - `isEditable()` → `toBeEditable()`
  Carry over any existing assertion timeout; do not invent one.
- **T4 — floating promise → awaited.** Prepend `await` to the un-awaited Playwright
  statement, **only** when the line is not also matched by #14 (verification theatre) and the
  call's result is not already consumed by `return`/`void`/assignment. If adding `await`
  would change intended concurrency (e.g. a deliberately parallel `Promise.all([...])`), it
  is not this anti-pattern — skip.

---

## Scoring & report shape

For each `*.spec.ts`:

1. **Per-finding:** `[severity] rule #N — <one-line> — file:line` (+ `waived` if justified).
2. **Per-test verdict:**
   - **compliant** — zero un-waived blockers (warnings may remain, listed).
   - **non-compliant** — one or more un-waived blockers; list each with the fix.
3. **Folder/batch:** one block per spec, then a summary — `N compliant · M non-compliant`,
   and the top recurring anti-patterns across the set.

## Auto-fix offer (report + offer; never silent)

After the report, if any finding is **auto-fix: yes**, offer to apply those rewrites
under explicit confirmation. **auto-fix: manual** findings are listed with guidance only.
Re-score after applying fixes. When run headless or when the author declines, stop at
report-only.

## What a clean test looks like (Section 8 portable checklist)

- [ ] No `waitForTimeout` in committed test code (debug-only).
- [ ] Every interaction uses a role/label/test-id locator; no positional
      `.first/.last/.nth` for disambiguation.
- [ ] Disambiguation via `filter`/chaining; single-match expectations assert `toHaveCount(1)`.
- [ ] Assertions are web-first (`await expect(locator)...`), never `expect(await locator.isVisible())`.
- [ ] Each test sets up its own state; no dependency on test order or another test's artifacts.
- [ ] Test data is unique per test/worker; auth state is per-worker.
- [ ] Non-deterministic third-party calls are mocked (where possible).
- [ ] `@typescript-eslint/no-floating-promises` is on and green.
- [ ] Timeouts are default/justified — not inflated to mask races.
- [ ] Retries are diagnostic (`trace: 'on-first-retry'`); no test relies on retries to pass.
- [ ] Suite passes under `--repeat-each` and under CI-like `--workers=N`.
