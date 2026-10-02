---
verifies: T2.5
supports: [S10, S55]
gates: [BUILD-4]
hint: libs/media/src/tests/verify-provider-ordering-admin-S55.spec.ts
---

# Verify T2.5 — Move the dry-run short-circuit to the attempt boundary so attribution is shape-identical

## Cases

1. `T2.5.c1` · *happy path* — the attempt record produced under dry run carries the same fields, in the same shape, as a live attempt record, differing only by the dry-run marker. (→ S55)
2. `T2.5.c2` · *boundary* — the short-circuit happens after the candidate is chosen and before the provider adapter is entered — assert with a provider stub that fails the test if entered at all. (→ S10)
3. `T2.5.c3` · *failure mode* — `'fail'` produces an attempt record marked failed, and the failover machinery is *not* triggered by it (a synthetic failure is not evidence that a provider is unavailable).
4. `T2.5.c4` · *regression* — `AllProvidersExhausted` and `IncompatibleRequestSchema` semantics are unchanged for live calls.

## Supports

- [S10](../../acceptance/S10.md) — A dry run contacts no provider
- [S55](../../acceptance/S55.md) — A dry run is recorded in the same shape as a real request

## Gates

- BUILD-4

## Weak proofs to reject

- c1: comparing a few chosen fields. Compare the dry-run and live attempt records field by field.
- c3: asserting the failure only. Assert that the failover machinery made no further attempt.
