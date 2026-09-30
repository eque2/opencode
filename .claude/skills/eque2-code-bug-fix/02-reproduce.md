# Stage 2 — Investigate & Reproduce

Goal: **reproduce the bug locally and capture the exact observed failure.** You do not proceed to writing tests or fixing until you have seen the bug happen (or have an evidenced, explicit reason why local reproduction is impossible).

## Investigate — map the whole bug, not just the first symptom

Shallow investigation is how a fix ends up half-done: you patch the one line the symptom points at and miss the sibling cases that share the same root cause. Go wide before you go deep.

- **Trace to the true origin.** Locate the code the symptom implicates and read it — don't guess. Follow the data backwards from where it fails to where it actually goes wrong; the root cause is usually upstream of the crash site. Build a mental model of how the input reaches the failure.
- **Find every site that shares the root cause.** Once you understand *why* it breaks, search the codebase for the same flawed pattern — sibling call sites, copy-pasted logic, parallel code paths. A missing guard here is usually missing in the two other places that cloned it. List them; they're in scope for a complete fix.
- **Enumerate the triggering inputs.** Map the full class of inputs / states / conditions that hit the bug, not just the one in the report — boundaries, empty/null, the other enum branches, concurrency. A fix that only handles the reported input is a half fix.
- **Define what "complete" looks like** before you touch code: the set of sites to change and the input classes the fix must cover. Stage 6 checks the actual fix against this, and the adversarial review there will hunt for whatever you missed — so be honest and exhaustive here.
- If the test setup wasn't available from BOND.md (generic mode), detect it now: find the test framework (package.json scripts/deps, config files), where tests live, and the file-naming convention. Record what you find — Stage 4 needs it.

## Reproduce

- Reproduce the bug by the smallest available means: a focused script, a REPL/CLI invocation, a one-off test, or by running the existing entrypoint with the triggering input.
- **Capture the exact observed failure** verbatim — the error message, stack trace, wrong return value, or failing assertion. This is your ground truth: Stage 4's test must fail with *this same* signature, and Stage 6 confirms it's gone.

## Confirm it's the right bug

Check the reproduction against the report's symptom and expected-vs-actual. If what you reproduced doesn't match what was reported, you've likely found a *different* bug — say so and reconcile with the user before continuing.

## If you cannot reproduce

Do not fabricate a reproduction and do not skip ahead to a speculative fix. Report what you tried, what you observed, and the most likely reasons (environment, missing data, flakiness, already-fixed). Ask the user for more detail or for the environment where it reproduces. A bug you can't reproduce is a bug you can't prove you fixed.

## Output of this stage

- Confirmed root-cause hypothesis (where and why it breaks), grounded in code you've read.
- The full blast radius: every site that shares the root cause, and the input classes a complete fix must cover.
- The captured failure signature.

Proceed to `03-existing-test.md`.
