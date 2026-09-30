# Playbook: Testing Heavyweight Third-Party / Iframe SPAs You Don't Control

> For suites that must drive a **vendor SPA** — embedded in an iframe, with
> virtualised grids, custom comboboxes, and modal overlays — where you **cannot add
> `data-testid`s, cannot mock the network, and cannot change the markup**. Repo-agnostic.
>
> This is the *constrained* counterpart to `build-time-guidance.md`. When the ideal
> patterns (test-ids, network mocking) are unavailable, these disciplined escape hatches
> keep tests deterministic. They are **mitigations for an unfixable constraint, not
> licence to abandon the golden rules.** When validating a test that legitimately drives
> such a target, a bounded+documented settle or a documented `force` fallback is reported
> as `waived`, not as a failure.

---

## The constraint

A typical target: a heavyweight enterprise SPA (CRM/ERP/finance platform) rendered
inside an `<iframe>`, served live (no mock layer), with:

- No control over markup → can't inject `data-testid`.
- Virtualised data grids → logical cells have hidden template/shadow duplicates.
- Custom widgets (comboboxes, lookups) that don't behave like native controls.
- Long-poll / websocket connections → `networkidle` never settles.
- Modal overlays and loading veils that intercept pointer events.

The ideal Playwright patterns assume you can mock and add test-ids. Here you mostly
can't. So you lean on **role/label locators**, **disciplined fallbacks**, and
**bounded waits** — and you ringfence the messy bits.

---

## The 7 patterns

### 1. Centralise all fragile interactions in one shared helper module

Put open-lookup, select-option, click-when-enabled, dismiss-dialogs, etc. behind a
single audited module. Tests call helpers, never bespoke per-test sequences.

- **Why:** one source of truth; a single fix propagates to the whole suite; reviewers
  audit one file, not hundreds of call sites.
- **Rule:** new test code imports these helpers — it does not reinvent interaction
  logic inline.

### 2. Bound every wait so a frozen UI fails fast

Wrap `isVisible()`-style probes and dialog-dismissal loops in a small
**bounded-timeout** helper (e.g. 3 s) rather than letting them inherit the full
multi-minute test budget.

```ts
// Conceptual — bound a probe so a hung frame fails in seconds, not minutes.
async function boundedIsVisible(locator: Locator, ms = 3000): Promise<boolean> {
  try { return await locator.isVisible({ timeout: ms }); }
  catch { return false; }
}
```

- **Why:** a hung iframe should cost you 3 seconds, not 30 minutes of the test timeout.
  Fail-fast turns "stuck forever" into "fast, legible failure."

### 3. Layer interaction strategies: real pointer → keyboard → force (in that order)

```
1. Try the genuine actionable click (full actionability checks).
2. If an overlay intercepts → fall back to a keyboard path
   (e.g. focus the field + the app's keyboard shortcut to open a lookup).
3. Only as a last, documented resort → force-click.
```

- **Why:** the real-pointer path exercises what a user does and respects actionability.
  Keyboard paths are overlay-immune. `force` bypasses the "receives events" check, so
  it's the final fallback, never the default.

### 4. Scope locators out of repeating grid rows

In virtualised grids a bare match (or `.first()`) can land on a hidden template/shadow cell.

```js
// Anchor to the specific row by content, then descend:
frame.getByRole('row').filter({ hasText: 'C00010' })
  .getByRole('gridcell', { name: 'Project No.' });

// Or intersect with a structural constraint that excludes repeating rows:
frame.getByRole('combobox', { name: 'Project No.', exact: true })
  .and(frame.locator('xpath=//*[not(ancestor::*[@role="row"])]'));
```

### 5. Document every escape hatch with a reason

When a bounded `waitForTimeout(1000)` settle is genuinely justified (e.g. the iframe
needs a beat to repaint), annotate it with a remediation ID / comment explaining *why*.

- **Why:** a documented escape hatch isn't mistaken for sloppiness, isn't "cleaned up"
  into a regression, and carries its own justification for the next reader/reviewer.

### 6. Branch on widget type when an API is unreliable

Some custom widgets break standard APIs (e.g. `selectOption()` can hang permanently on
a custom combobox while working on a native `<select>`). Detect the widget type and branch:

```ts
// Conceptual: native <select> is safe for selectOption(); custom combobox needs type+Enter.
const tag = await combo.evaluate(el => el.tagName.toLowerCase());
if (tag === 'select') {
  await combo.selectOption({ label: value });
} else {
  await combo.click();          // open
  await combo.fill(value);      // type the label
  await combo.press('Enter');   // commit
}
```

### 7. Add an opt-in forensic diagnostics fixture

A fixture (off by default, enabled by an env flag) that captures page crashes,
`pageerror`, `requestfailed`, frame-detach events, and a periodic heartbeat to a
per-test log.

- **Why:** turns "browser has been closed" / silent-hang mysteries into evidence,
  without slowing normal runs.

---

## What does NOT change under the constraint

These golden rules still hold — the iframe constraint is no excuse:

- **No blanket `waitForTimeout` sprinkling.** Bounded, documented settles only; prefer
  web-first assertions wherever the target exposes a stable role/label.
- **Test isolation is non-negotiable.** Unique data per test, per-worker identity, no
  inter-test file/data coupling. If a suite is pinned to `workers: 1` purely because
  tests share a file or seed record, that coupling — not the framework, not the vendor
  SPA — is the debt to repay.
- **Prefer role/label locators** wherever the SPA exposes them; reserve XPath for
  genuinely structural scoping (like rule 4).
- **`force: true` is the last resort**, always after real-pointer and keyboard attempts.

---

## Migration order (when hardening an existing constrained suite)

1. Centralise interactions into the shared helper module (rule 1).
2. Bound all waits (rule 2) — kills the worst "30-minute hang" failures first.
3. Replace positional locators with content-scoped ones (rule 4).
4. Layer the pointer→keyboard→force fallbacks (rule 3).
5. Repay isolation debt (unique data, per-worker auth) so `workers: 1` is no longer forced.
6. Add the diagnostics fixture (rule 7) for the residual mysteries.
