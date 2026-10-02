---
after: [T2.1]
touches:
  - path: libs/media/src/routing-policy-source.ts
    change: update
    what: "extend `routingPolicySourceSpecConfig` so the source is selected by configuration"
  - path: apps/api/src/main.ts
    change: update
    what: "wire the database-backed source"
  - path: libs/media/src/routing-policy.ts
    change: update
    what: "the compare-and-swap refuses a document whose revision is older than the one in force (POA-R2)"
refs: [POA-R2, POA-D7, EFF-32]
---

# Wire source selection, polling and load semantics

## Goal

Make the database the selectable source, and prove the existing load properties still hold when reached through it.

## Approach

**Finding POA-R2:** the Apply path and the background poller are two independent writers of `RoutingPolicyService`. Without a revision comparison in the swap, a poll in flight across an Apply silently reverts the administrator's change for up to one poll interval — after they were told it succeeded. The swap must therefore refuse an older revision, not merely a matching hash.
