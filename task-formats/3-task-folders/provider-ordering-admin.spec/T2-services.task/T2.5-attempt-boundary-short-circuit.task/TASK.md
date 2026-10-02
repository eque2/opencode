---
id: T2.5
title: "Move the dry-run short-circuit to the attempt boundary so attribution is shape-identical"
parent: T2
after: [T1.4, T2.4]
touches:
  - path: libs/media/src/candidate-execution.ts
    change: update
refs: [POA-A3.b, POA-D9]
---

# T2.5 — Move the dry-run short-circuit to the attempt boundary so attribution is shape-identical

## Goal

Make a dry run produce the *same* attribution record a live call produces — which is the entire reason a dry run can be used as proof.

## Approach

Placing the short-circuit here rather than higher in the gateway is what buys the shape-identity (POA-A3.b); the "no adapter entered" property is preserved and separately asserted.

## Preserve

- `AllProvidersExhausted` and `IncompatibleRequestSchema` semantics for live calls
- no provider adapter is entered on a dry run

## Must not

- let a synthetic failure trigger failover — otherwise `dryRun: 'fail'` would silently exercise the whole chain and report the wrong provider

## Change detail

- `libs/media/src/candidate-execution.ts`: the short-circuit sits after the candidate is chosen and before the provider adapter is entered, where the attempt record is still produced
