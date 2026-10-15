---
touches:
  - path: src/sum.ts
    change: new
    what: "the sum function"
refs: [EX-D1]
---

# Sum a list of numbers

## Goal

Add a sum of a list of numbers.

## Approach

Export `sum(values: number[]): number` from `src/sum.ts`; the sum of an empty list is `0`. One line of code is
enough. The release gate BUILD-1 proves this task; it never passes, so this task ends budget exhausted.
