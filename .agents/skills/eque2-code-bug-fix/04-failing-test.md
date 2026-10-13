# Stage 4 — Write the Failing Test (red)

Goal: a test that reproduces the bug and **fails for the right reason** — before any fix exists.

## Write it

- Place it where the project keeps its tests, following the detected naming convention. Reuse the existing test harness and helpers; match the surrounding style.
- Assert on the **behaviour the report says is wrong** — the expected-vs-actual from Stage 1, against the input that triggered the bug in Stage 2. Keep it minimal and focused on this one defect.
- If Stage 3 found an existing test that passed wrongly, prefer *fixing that test* to assert the correct property, rather than adding a redundant one — or add the new case alongside if they cover genuinely different things.

## Run it and verify the failure mode

Run the test. It **must fail**, and it must fail **for the right reason**:

- The failure must match the signature captured in Stage 2 (same error / same wrong value / the assertion that encodes the bug).
- A test that errors for an unrelated reason — a typo, a missing import, wrong setup — gives false confidence. Fix the test until it fails *because of the bug*, not because of itself.

State explicitly: "Red confirmed — fails because `<reason>`, matching the reproduction."

## Do not fix yet

The fix is Stage 5. The point of this stage is a trustworthy red. If you fix and test in one motion you lose the proof that the test actually catches the bug.

## Output of this stage

- A committed-to-the-working-tree failing test, with its failure output captured.

Proceed to `05-fix.md`.
