---
hint: libs/db/src/lib/extensions/tests/verify-provider-ordering-admin-S27.spec.ts
ensures:
  c1:
    category: happy-path
    text: "a recorded generation carries provider, routing source and policy hash, written in the same atomic step as the asset insert and wallet decrement."
    covers: [S27]
  c2:
    category: empty
    text: "a caller that supplies none of the new fields still records successfully, and the absent fields are stored as absent, not invented."
    covers: [S43]
  c3:
    category: boundary
    text: "a dry-run call writes a routing-decision record carrying the attribution and the dry-run marker, performs **no** wallet decrement, and writes **no** generation-history row — it has no asset to reference."
    covers: [S58, POA-R4]
  c4:
    category: boundary
    text: "the routing-decision record is readable afterwards without reference to any artefact, which is what makes a dry run usable as proof of what a live request would do."
  c5:
    category: failure
    text: "if the attribution write fails, the whole record fails — there is no partial state in which the generation exists without it."
  c6:
    category: regression
    text: "existing callers compile unchanged (the new fields are optional)."
preserves:
  p1:
    text: "exactly one write path for the generation half"
    proof: review
  p2:
    text: "existing `recordGeneration` callers compile unchanged"
    proof: {test: c6}
forbids:
  f1:
    text: "hand-edit the generated `libs/db/src/lib/{types.ts,schemas/,repositories/}`"
    proof: review
rejects:
  c3:
    - "asserting that a routing-decision row exists. Also assert there is no generation-history row and no wallet decrement."
  c5:
    - "a happy-path write. Make the attribution write fail and assert that no generation, asset or wallet change remains."
---

# Verify

Each obligation is proved as its `proof` says; an ensures obligation is proved by a passing test whose title starts with its qualified id, for example `[T2.6.c1]`. A verdict that accepts a proof listed under `rejects` is void.
