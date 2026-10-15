---
touches:
  - path: src/clamp.ts
    change: new
    what: "the clamp function"
refs: [EX-D1]
---

# Clamp a number

## Goal

Add a clamp that keeps a number inside a range.

## Approach

Export `clamp(value: number, low: number, high: number): number` from `src/clamp.ts`, as
`Math.min(high, Math.max(low, value))`. One line of code is enough.
