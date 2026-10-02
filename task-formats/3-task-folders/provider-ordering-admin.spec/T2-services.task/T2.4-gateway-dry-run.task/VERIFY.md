---
verifies: T2.4
supports: [S8, S9, S10, S42, S53]
gates: []
hint: libs/media/src/tests/verify-provider-ordering-admin-S8.spec.ts
---

# Verify T2.4 — Add the dry-run mode to the gateway

## Cases

1. `T2.4.c1` · *happy path* — `'succeed'` resolves routing, records attribution, returns a synthetic success naming the provider. (→ S8)
2. `T2.4.c2` · *happy path* — `'fail'` returns the synthetic typed failure, attribution still recorded. (→ S9)
3. `T2.4.c3` · *empty / null* — no dry-run mode supplied → the call behaves exactly as before, including being charged. (→ S42)
4. `T2.4.c4` · *boundary* — a dry run on a pair with one candidate, and on a pair configured to serve nothing (the routing failure surfaces; the dry run does not mask it).
5. `T2.4.c5` · *failure mode* — no provider is contacted under either mode. (→ S10)
6. `T2.4.c6` · *money* — the wallet balance is unchanged and no charge row is created. (→ S53)
7. `T2.4.c7` · *security boundary* — the dry-run idempotency key cannot collide with a live call's, so a dry run can never satisfy or poison a real request's idempotency.

## Supports

- [S8](../../acceptance/S8.md) — A dry run that is asked to succeed reports the provider it would have used
- [S9](../../acceptance/S9.md) — A dry run that is asked to fail produces a failure without contacting anyone
- [S10](../../acceptance/S10.md) — A dry run contacts no provider
- [S42](../../acceptance/S42.md) — A caller who says nothing about dry runs is unaffected
- [S53](../../acceptance/S53.md) — A dry run costs nothing

## Weak proofs to reject

- c5: asserting the returned value only. Use a provider stub that fails the test if it is entered.
- c6: checking the response. Read the wallet balance and the charge rows before and after.
- c7: checking that a key exists. Derive both keys for the same request and assert they differ.
