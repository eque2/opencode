# Stage 3 — Interrogate Existing Tests

Goal: find out whether a test *already* covers this path, and if so, why it didn't catch the bug. This is the step an LLM skips — and it's often where the real lesson is.

## Search

Using the test location and naming convention (from BOND.md or detected in Stage 2), search for tests that exercise the code on the failure path — by file, by the function/module name, by the feature area.

## Three outcomes

1. **No test covers this path.** That's the simplest case — the bug lived in untested code. Note it; Stage 4 writes the first test for this path.

2. **A test covers it and currently passes.** This is the important one. Work out *why it passes despite the bug*, and report it:
   - Does it assert on the wrong thing (tests a weaker property than the one that broke)?
   - Does it use input that dodges the triggering condition?
   - Is it mocking away the exact code that fails?
   - Was it skipped, `.only`'d elsewhere, or quietly disabled?
   - **How did this get shipped?** — a passing test over broken behaviour usually means the test, not just the code, is wrong. Flag whether the existing test needs strengthening as part of this fix.

3. **A test covers it and currently fails.** Good — you may already have your reproduction in test form. Confirm it fails for the *right reason* (matches the Stage 2 signature), and you can fold it into Stage 4 rather than writing a new one.

## Output of this stage

- A verdict (none / passes-wrongly / already-failing) with the diagnosis.
- A note on whether an existing test must be corrected, not just added to.

Proceed to `04-failing-test.md`.
