# Stage 5 — Fix the Bug (green)

Goal: the minimal, targeted change that makes the Stage 4 test pass — addressing the root cause, not the symptom.

## Fix

- Change the code that the Stage 2 investigation identified as the root cause. Fix the cause, not a downstream symptom — patching where the error surfaces rather than where it originates tends to leave the bug alive under a different input.
- Keep the change as small as the fix honestly allows. Resist drive-by refactors, renames, and unrelated "while I'm here" edits — they widen the blast radius and muddy the review the next workflow will do.
- Match the surrounding code's conventions and idioms.

## Confirm the red turns green

Run the Stage 4 test. It must now pass — and pass *because the behaviour is correct*, not because you weakened the assertion. If you find yourself editing the test to make it pass, stop: either the fix is wrong or the test was. Reconcile before moving on.

## Output of this stage

- The fix applied to the working tree.
- The previously-failing test now passing.

Proceed to `06-verify.md`.
