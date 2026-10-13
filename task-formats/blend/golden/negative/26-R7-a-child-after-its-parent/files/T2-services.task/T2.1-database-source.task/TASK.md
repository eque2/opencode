---
after: [T1.2, T1.3, T2]
touches:
  - path: libs/media/src/routing-policy-source.ts
    change: update
    what: "a `Database` case on `RoutingPolicySourceSpec`; `specUri` renders it as `db://routing-config`"
refs: [POA-D3]
---

# Add the `Database` routing-policy source variant

## Goal

Let the live policy come from the table without teaching the policy service anything new.

## Approach

Extend **every** `$match` — the exhaustive matcher failing to compile is the intended safety net, not an obstacle. The source offers documents through the existing `load`, so the "a rejected replacement never removes the working policy" property is inherited rather than re-implemented.
