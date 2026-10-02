---
hint: libs/media/src/tests/verify-provider-ordering-admin-S7.spec.ts
ensures:
  c1:
    category: happy-path
    text: "a configured pair routes to its first enabled candidate in stored order, reported as `'policy'`."
  c2:
    category: empty
    text: "an absent pair routes by `orderedCandidatesFor`, reported as `'default-precedence'`."
    covers: [S6, S44]
  c3:
    category: boundary
    text: "a pair configured with every provider disabled fails with a typed error naming the pair, distinguishable from the absent case."
    covers: [S7]
  c4:
    category: boundary
    text: "a disabled provider is never a candidate, even when every enabled candidate has failed."
    covers: [S3, S22]
  c5:
    category: invalid-input
    text: "an override naming a disabled provider is refused by the existing `OverrideNotACandidate`, not silently honoured."
  c6:
    category: regression
    text: "candidate order is verbatim and never re-sorted; a policy for a pair remains strictly additive over default precedence for every pair that is merely absent."
preserves:
  p1:
    text: "candidate order is verbatim and never re-sorted"
    proof: {test: c6}
  p2:
    text: "a policy stays strictly additive over default precedence for every pair that is merely absent"
    proof: {test: c6}
  p3:
    text: "the failover gating"
    proof: review
forbids:
  f1:
    text: "read the serve-nothing set from anywhere but the `PolicySnapshot`'s document (T1.6) — any other channel reintroduces POA-R1"
    proof: review
  f2:
    text: "reuse `NoCandidateSatisfiesConstraints` for the serve-nothing case"
    proof: review
  f3:
    text: "touch `routingPolicyHash`"
    proof: review
rejects:
  c3:
    - "asserting only that an error occurred. Assert the error's tag and the pair it names; only that separates serve-nothing from absent."
  c4:
    - "a single failing candidate. Fail every enabled candidate, then assert the disabled provider was never called."
---

# Verify

Each obligation is proved as its `proof` says; an ensures obligation is proved by a passing test whose title starts with its qualified id, for example `[T2.3.c1]`. A verdict that accepts a proof listed under `rejects` is void.
