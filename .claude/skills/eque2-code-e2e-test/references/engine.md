# Engine — block catalog, depth levels, conventions, produced shape

The engine is modelled on the retired `eque2-test` build-test (4 stages) with Strategy 6 (Full Pipeline) as the richest structural template. Depth is set at First Breath (Stage 1), persisted to config, and defaults to **core**.

## Stage ↔ block mapping

| Stage prompt | Strategy-6 blocks | Notes |
|---|---|---|
| `03-prepare.md` | **P** Preflight, **C** Context | creds/BASE_URL/remediation; `test-standards.md` + bundled build-time guidance (`eque2-code-test-validation/references/build-time-guidance.md`) + `playwright.config` + existing patterns |
| `04-explore.md` | **M** POM-first, **X** Explore-first | generate page-object stubs, then confirm every locator against the live DOM and back-fill |
| `05-implement.md` | **L** Layered commitment | write+run in 3 layers — navigation → interactions → assertions; each passes before the next; authored against the build-time guidance |
| `06-verify.md` | **A** Resilience audit, **H** Parallel healer | always-on gates (fidelity + `[TV]` best-practice validation + static + indeterminate) run at both depths; **A/H are full engine only** — A = compliance + locator-uniqueness sweep; H = race 3 ranked alternatives per failing step |
| `07-complete.md` | **R** Result record | status + evidence |

## Depth levels

- **core (default):** `P → C → M → X → L → R` + Verify/fix-≤3×. **Drops A and H.**
- **full:** all eight blocks, including the parallel healer (H).

The verify loop is bounded to **3 fix iterations** in both depths.

## Conventions (enforced — these bend the generated code)

- **Locator priority:** `getByRole` > `getByLabel` > `getByPlaceholder`/`getByText` > `getByTestId`. **Forbidden:** brittle CSS, `nth`/index selection. Auth via `storageState`.
- **Locator uniqueness:** every acted-on locator resolves to one element under strict mode (`count() === 1`); scope to disambiguate, never a blanket `.first()`/`.last()`, never disable strict mode.
- **Waits:** prefer auto-waiting / web-first assertions; a *bounded* `waitForTimeout` is allowed only as a documented recovery escape-hatch paired with a bounded-visibility race — never a blind sleep.
- **Fidelity:** every Xray step → a `test.step()` with a real `expect()` on every VERIFY step; data entry is read-back-asserted. Enforced always-on by the Stage 6 fidelity gate (see `test-standards-defaults.md`).
- **`playwright.config.ts` at project root** (not the test dir).
- **Layout:** `{TEST_CODE_DIR}/tests/*.spec.ts`, `pages/*.ts` (POM), optional `fixtures/`.
- Each Xray step maps **1:1** to a `test.step()` block; assertions come from the step's expected result.
- Constrain generation to the locator priority via a structured prompt — reduces hallucinated selectors.

## Produced test shape

```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Name (CMC-12345)', () => {
  test('test plan description', async ({ page }) => {
    await test.step('Step 1: Navigate to feature', async () => {
      await page.goto('/feature-path');
      await expect(page.getByRole('heading', { name: /feature/i })).toBeVisible();
    });
    // further steps map 1:1 from the Xray specification
  });
});
```

The `describe` title carries the `{ticket_key}` for traceability back to the Xray definition.
