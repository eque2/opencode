---
gates: [BUILD-4]
hint: libs/media/src/tests/verify-provider-ordering-admin-S55.spec.ts
ensures:
  c1:
    category: happy-path
    text: "the attempt record produced under dry run carries the same fields, in the same shape, as a live attempt record, differing only by the dry-run marker."
    covers: [S55]
  c2:
    category: boundary
    text: "the short-circuit happens after the candidate is chosen and before the provider adapter is entered — assert with a provider stub that fails the test if entered at all."
    covers: [S10]
  c3:
    category: failure
    text: "`'fail'` produces an attempt record marked failed, and the failover machinery is *not* triggered by it (a synthetic failure is not evidence that a provider is unavailable)."
  c4:
    category: regression
    text: "`AllProvidersExhausted` and `IncompatibleRequestSchema` semantics are unchanged for live calls."
preserves:
  p1:
    text: "`AllProvidersExhausted` and `IncompatibleRequestSchema` semantics for live calls"
    proof: {test: c4}
  p2:
    text: "no provider adapter is entered on a dry run"
    proof: {test: c2}
forbids:
  f1:
    text: "let a synthetic failure trigger failover — otherwise `dryRun: 'fail'` would silently exercise the whole chain and report the wrong provider"
    proof: {test: c3}
rejects:
  c1:
    - "comparing a few chosen fields. Compare the dry-run and live attempt records field by field."
  c3:
    - "asserting the failure only. Assert that the failover machinery made no further attempt."
---

# Verify

Each obligation is proved as its `proof` says; an ensures obligation is proved by a passing test whose title starts with its qualified id, for example `[T2.5.c1]`. A verdict that accepts a proof listed under `rejects` is void.
