---
verifies: T2.2
supports: [S18, S19, S21, S25, S39, S40, S41, S51, S57, S59]
gates: []
hint: libs/media/src/tests/verify-provider-ordering-admin-S39.spec.ts
---

# Verify T2.2 — Wire source selection, polling and load semantics

## Cases

1. `T2.2.c1` · *happy path* — configuration selects the database source; the poller loads it on the existing interval.
2. `T2.2.c2` · *boundary* — re-reading an unchanged configuration reports `unchanged` and does not advance the generation counter. (→ S40)
3. `T2.2.c3` · *boundary* — a policy replacement landing mid-request does not change the decision that request already resolved; a request begun afterwards sees the replacement. (→ S39)
4. `T2.2.c4` · *failure mode* — a malformed projection is refused and the readiness surface reports `serving-stale`. (→ S18)
5. `T2.2.c5` · *failure mode* — the store is unreachable for several consecutive polls; the policy in force keeps serving throughout. (→ S21)
6. `T2.2.c6` · *concurrency* — a poll that began before an Apply and completes after it does not reinstate the pre-Apply configuration — the swap refuses a document whose revision is older than the one in force. (→ S57, POA-R2)
7. `T2.2.c7` · *invalid input* — a document refused by the catalogue-binding check leaves the previous policy serving and is reported. (→ S59)
8. `T2.2.c8` · *backwards compatibility* — the GCS-configured deployment path is untouched. (→ S41)

## Supports

- [S18](../../acceptance/S18.md) — A malformed submission is refused and the previous configuration keeps serving
- [S19](../../acceptance/S19.md) — A submission naming an unknown provider is refused, naming every unknown one
- [S21](../../acceptance/S21.md) — When the configuration store cannot be reached the last good configuration keeps serving
- [S25](../../acceptance/S25.md) — A refused configuration never disturbs the one that is serving
- [S39](../../acceptance/S39.md) — A configuration change landing mid-request does not change that request
- [S40](../../acceptance/S40.md) — Re-applying an identical configuration is not treated as a change
- [S41](../../acceptance/S41.md) — The previously-supported configuration sources continue to work
- [S51](../../acceptance/S51.md) — The deployed service reads its configuration from the store
- [S57](../../acceptance/S57.md) — A slow read cannot undo a change that has already been applied
- [S59](../../acceptance/S59.md) — A stored configuration naming a provider that cannot serve the model is refused

## Weak proofs to reject

- c2: asserting only that the outcome says `unchanged`. Assert that the generation counter did not advance.
- c3: swapping the policy before the request starts. The replacement must land after the request has resolved its decision and before it completes.
- c6: running the poll and the Apply one after the other. The poll must begin before the Apply and complete after it, or the test cannot fail.
