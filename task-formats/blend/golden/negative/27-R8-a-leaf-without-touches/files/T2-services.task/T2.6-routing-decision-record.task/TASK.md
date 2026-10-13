---
after: [T1.1, T2.4]
refs: [POA-R4, POA-D9]
---

# Write the routing-decision record and the generation attribution

## Goal

Make it impossible for a generation to exist without a record of why the provider that served it was chosen.

## Approach

Extend the existing `recordGeneration` input rather than adding a second write path for the generation half — the atomicity guarantee in the `0015` migration docblock depends on there being exactly one. The routing-decision record is a separate, additional write that every call makes, live or dry (POA-R4). Regenerate the DB types after T1.1 with `pnpm nx run db:codegen`.
