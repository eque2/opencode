---
hint: libs/media/src/tests/verify-provider-ordering-admin-S39.spec.ts
ensures:
  c1:
    category: happy-path
    text: "configuration selects the database source; the poller loads it on the existing interval."
  c2:
    category: boundary
    text: "re-reading an unchanged configuration reports `unchanged` and does not advance the generation counter."
    covers: [S40]
  c3:
    category: boundary
    text: "a policy replacement landing mid-request does not change the decision that request already resolved; a request begun afterwards sees the replacement."
    covers: [S39]
  c4:
    category: failure
    text: "a malformed projection is refused and the readiness surface reports `serving-stale`."
    covers: [S18]
  c5:
    category: failure
    text: "the store is unreachable for several consecutive polls; the policy in force keeps serving throughout."
    covers: [S21]
  c6:
    category: concurrency
    text: "a poll that began before an Apply and completes after it does not reinstate the pre-Apply configuration — the swap refuses a document whose revision is older than the one in force."
    covers: [S57, POA-R2]
  c7:
    category: invalid-input
    text: "a document refused by the catalogue-binding check leaves the previous policy serving and is reported."
    covers: [S59]
  c8:
    category: compatibility
    text: "the GCS-configured deployment path is untouched."
    covers: [S41]
preserves:
  p1:
    text: "the existing environment variables keep selecting the source they select today"
    proof: {test: c99}
  p2:
    text: "`ROUTING_POLICY_DEFAULT_POLL_INTERVAL` and the bounded retry count — this task adds a source, it does not retune the poller"
    proof: review
  p3:
    text: "the `RoutingPolicyLive` composition and `provideMerge` structure in `main.ts`"
    proof: review
  p4:
    text: "a request sees one snapshot for its lifetime"
    proof: {test: c3}
  p5:
    text: "a rejected replacement never disturbs the serving snapshot"
    proof: {test: c7}
rejects:
  c2:
    - "asserting only that the outcome says `unchanged`. Assert that the generation counter did not advance."
  c3:
    - "swapping the policy before the request starts. The replacement must land after the request has resolved its decision and before it completes."
  c6:
    - "running the poll and the Apply one after the other. The poll must begin before the Apply and complete after it, or the test cannot fail."
---

# Verify

Each obligation is proved as its `proof` says; an ensures obligation is proved by a passing test whose title starts with its qualified id, for example `[T2.2.c1]`. A verdict that accepts a proof listed under `rejects` is void.
