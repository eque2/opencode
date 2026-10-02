---
id: T2.6
title: "Write the routing-decision record and the generation attribution"
parent: T2
after: [T1.1, T2.4]
touches:
  - path: libs/db/src/lib/extensions/versions.extensions.ts
    change: update
refs: [POA-R4, POA-D9]
---

# T2.6 — Write the routing-decision record and the generation attribution

## Goal

Make it impossible for a generation to exist without a record of why the provider that served it was chosen.

## Approach

Extend the existing `recordGeneration` input rather than adding a second write path for the generation half — the atomicity guarantee in the `0015` migration docblock depends on there being exactly one. The routing-decision record is a separate, additional write that every call makes, live or dry (POA-R4). Regenerate the DB types after T1.1 with `pnpm nx run db:codegen`.

## Preserve

- exactly one write path for the generation half
- existing `recordGeneration` callers compile unchanged

## Must not

- hand-edit the generated `libs/db/src/lib/{types.ts,schemas/,repositories/}`

## Change detail

- `libs/db/src/lib/extensions/versions.extensions.ts`: extend the existing `recordGeneration` input, and add the routing-decision write that every call makes, live or dry
