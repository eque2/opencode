---
verifies: T2.1
supports: [S21, S25, S36, S41]
gates: [BUILD-2]
hint: libs/media/src/tests/verify-provider-ordering-admin-S25.spec.ts
---

# Verify T2.1 — Add the `Database` routing-policy source variant

## Cases

1. `T2.1.c1` · *happy path* — the source reads rows, projects, and the policy service accepts the document.
2. `T2.1.c2` · *empty / null* — an empty table yields the empty policy and the service serves it — a fresh deployment with nothing configured boots and routes by default precedence.
3. `T2.1.c3` · *boundary* — the full catalogue projects and loads in one read.
4. `T2.1.c4` · *failure mode* — the database is unreachable → the source reports the existing `unreachable` poll outcome; the policy in force is untouched. (→ S21, S25)
5. `T2.1.c5` · *invalid input* — rows that project to a document naming an unregistered provider are refused by the existing load-time registry check, and the previous snapshot keeps serving.
6. `T2.1.c6` · *backwards compatibility* — `Gcs`, `File`, `Inline` and `None` behave exactly as before. (→ S41)

## Supports

- [S21](../../acceptance/S21.md) — When the configuration store cannot be reached the last good configuration keeps serving
- [S25](../../acceptance/S25.md) — A refused configuration never disturbs the one that is serving
- [S36](../../acceptance/S36.md) — An operator can see where the live configuration came from and whether the latest read worked
- [S41](../../acceptance/S41.md) — The previously-supported configuration sources continue to work

## Gates

- BUILD-2

## Weak proofs to reject

- c4: asserting only that an error was reported. Compare the serving snapshot's identity before and after the failed read.
- c5: a refusal raised by new code in the source. The case is that the existing load-time registry check refuses it.
- c6: exercising one source. Each of `Gcs`, `File`, `Inline` and `None` needs its own assertion.
