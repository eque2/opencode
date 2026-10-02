---
after: [T1.4, T2.4]
touches:
  - path: libs/media/src/candidate-execution.ts
    change: update
    what: "the short-circuit sits after the candidate is chosen and before the provider adapter is entered, where the attempt record is still produced"
refs: [POA-A3.b, POA-D9]
---

# Move the dry-run short-circuit to the attempt boundary so attribution is shape-identical

## Goal

Make a dry run produce the *same* attribution record a live call produces — which is the entire reason a dry run can be used as proof.

## Approach

Placing the short-circuit here rather than higher in the gateway is what buys the shape-identity (POA-A3.b); the "no adapter entered" property is preserved and separately asserted.
