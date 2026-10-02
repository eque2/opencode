---
gates: [BUILD-2]
hint: libs/media/src/tests/verify-provider-ordering-admin-S25.spec.ts
ensures:
  c1:
    category: happy-path
    text: "the source reads rows, projects, and the policy service accepts the document."
  c2:
    category: empty
    text: "an empty table yields the empty policy and the service serves it — a fresh deployment with nothing configured boots and routes by default precedence."
  c3:
    category: boundary
    text: "the full catalogue projects and loads in one read."
  c4:
    category: failure
    text: "the database is unreachable → the source reports the existing `unreachable` poll outcome; the policy in force is untouched."
    covers: [S21, S25]
  c5:
    category: invalid-input
    text: "rows that project to a document naming an unregistered provider are refused by the existing load-time registry check, and the previous snapshot keeps serving."
  c6:
    category: compatibility
    text: "`Gcs`, `File`, `Inline` and `None` behave exactly as before."
    covers: [S41]
preserves:
  p1:
    text: "every `$match` stays exhaustive: a case missing from a matcher is a type error"
    proof: {gate: BUILD-2}
  p2:
    text: "the poll interval, the retry count and the `unreachable` outcome semantics are untouched"
    proof: review
forbids:
  f1:
    text: "modify `libs/media/src/routing-policy.ts` — the source offers documents through the existing `load`"
    proof: {unchanged: libs/media/src/routing-policy.ts}
rejects:
  c4:
    - "asserting only that an error was reported. Compare the serving snapshot's identity before and after the failed read."
  c5:
    - "a refusal raised by new code in the source. The case is that the existing load-time registry check refuses it."
  c6:
    - "exercising one source. Each of `Gcs`, `File`, `Inline` and `None` needs its own assertion."
---

# Verify

Each obligation is proved as its `proof` says; an ensures obligation is proved by a passing test whose title starts with its qualified id, for example `[T2.1.c1]`. A verdict that accepts a proof listed under `rejects` is void.
