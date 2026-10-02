---
verifies: T2.6
supports: [S27, S43, S58]
gates: []
hint: libs/db/src/lib/extensions/tests/verify-provider-ordering-admin-S27.spec.ts
---

# Verify T2.6 — Write the routing-decision record and the generation attribution

## Cases

1. `T2.6.c1` · *happy path* — a recorded generation carries provider, routing source and policy hash, written in the same atomic step as the asset insert and wallet decrement. (→ S27)
2. `T2.6.c2` · *empty / null* — a caller that supplies none of the new fields still records successfully, and the absent fields are stored as absent, not invented. (→ S43)
3. `T2.6.c3` · *boundary* — a dry-run call writes a routing-decision record carrying the attribution and the dry-run marker, performs **no** wallet decrement, and writes **no** generation-history row — it has no asset to reference. (→ S58, POA-R4)
4. `T2.6.c4` · *boundary* — the routing-decision record is readable afterwards without reference to any artefact, which is what makes a dry run usable as proof of what a live request would do.
5. `T2.6.c5` · *failure mode* — if the attribution write fails, the whole record fails — there is no partial state in which the generation exists without it.
6. `T2.6.c6` · *regression* — existing callers compile unchanged (the new fields are optional).

## Supports

- [S27](../../acceptance/S27.md) — What served a request is recorded together with the request's outcome
- [S43](../../acceptance/S43.md) — A caller that records a generation without the new detail still succeeds
- [S58](../../acceptance/S58.md) — A request that produces nothing still records which provider it would have used

## Weak proofs to reject

- c3: asserting that a routing-decision row exists. Also assert there is no generation-history row and no wallet decrement.
- c5: a happy-path write. Make the attribution write fail and assert that no generation, asset or wallet change remains.
