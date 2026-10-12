---
hint: libs/media/src/tests/verify-provider-ordering-admin-S8.spec.ts
ensures:
  c1:
    category: happy-path
    text: "`'succeed'` resolves routing, records attribution, returns a synthetic success naming the provider."
    covers: [S8]
  c2:
    category: happy-path
    text: "`'fail'` returns the synthetic typed failure, attribution still recorded."
    covers: [S9]
  c3:
    category: empty
    text: "no dry-run mode supplied → the call behaves exactly as before, including being charged."
    covers: [S42]
  c4:
    category: boundary
    text: "a dry run on a pair with one candidate, and on a pair configured to serve nothing (the routing failure surfaces; the dry run does not mask it)."
  c5:
    category: failure
    text: "no provider is contacted under either mode."
    covers: [S10]
  c6:
    category: money
    text: "the wallet balance is unchanged and no charge row is created."
    covers: [S53]
  c7:
    category: security
    text: "the dry-run idempotency key cannot collide with a live call's, so a dry run can never satisfy or poison a real request's idempotency."
preserves:
  p1:
    text: "the estimate-drift / re-confirmation gate"
    proof: review
  p2:
    text: "`deriveIdempotencyKey` — extended, not replaced"
    proof: {test: c7}
  p3:
    text: "`admitPinnedProviderId`"
    proof: review
rejects:
  c5: "asserting the returned value only. Use a provider stub that fails the test if it is entered."
  c6:
    - "checking the response. Read the wallet balance and the charge rows before and after."
  c7:
    - "checking that a key exists. Derive both keys for the same request and assert they differ."
policy:
  judges:
    test: [runner, verifier, human]
---

# Verify

Each obligation is proved as its `proof` says; an ensures obligation is proved by a passing test whose title starts with its qualified id, for example `[T2.4.c1]`. A verdict that accepts a proof listed under `rejects` is void.
