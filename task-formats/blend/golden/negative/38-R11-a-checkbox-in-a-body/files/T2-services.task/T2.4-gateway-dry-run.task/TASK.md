---
after: [T1.4]
touches:
  - path: libs/media/src/media-gateway.ts
    change: update
    what: "`GatewayRoutingContext` gains an optional dry-run field"
refs: [POA-D8]
notHere:
  - what: "the short-circuit itself — this task supplies the mode and the money guarantee"
    owner: T2.5
---

# Add the dry-run mode to the gateway

## Goal

Let a caller ask "who would serve this?" and get a truthful answer without a provider call or a charge.

## Approach

Extend the input of `deriveIdempotencyKey` so the mode is part of the key: a dry run must neither collide with nor poison a live call's idempotency key.

- [x] built
