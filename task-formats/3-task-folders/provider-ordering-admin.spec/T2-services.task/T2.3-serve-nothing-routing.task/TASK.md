---
id: T2.3
title: "Update the router so a pair configured to serve nothing is not treated as unconfigured"
parent: T2
after: [T1.3, T1.6]
touches:
  - path: libs/media/src/provider-router.ts
    change: update
refs: [POA-R1, POA-D4, POA-D7, EFF-10]
---

# T2.3 — Update the router so a pair configured to serve nothing is not treated as unconfigured

## Goal

Make a deliberately-emptied pair fail loudly instead of silently reverting to the built-in default.

## Approach

This is the one genuine semantic change to `provider-router.ts`. Today an absent entry and a serve-nothing entry are indistinguishable; after this they must not be. Add a tagged failure alongside the existing `NoCandidateSatisfiesConstraints` rather than reusing it — the operator response differs completely ("your constraints excluded everything" versus "you switched everything off").

## Preserve

- candidate order is verbatim and never re-sorted
- a policy stays strictly additive over default precedence for every pair that is merely absent
- the failover gating

## Must not

- read the serve-nothing set from anywhere but the `PolicySnapshot`'s document (T1.6) — any other channel reintroduces POA-R1
- reuse `NoCandidateSatisfiesConstraints` for the serve-nothing case
- touch `routingPolicyHash`

## Change detail

- `libs/media/src/provider-router.ts`: a pair configured with zero enabled providers fails with a new typed error instead of falling through to default precedence
