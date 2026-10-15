---
after: [T1.1]
touches:
  - path: src/mean.ts
    change: new
    what: "the mean function"
refs: [EX-D1]
---

# Mean of a list of numbers

## Goal

Add the mean of a list of numbers, built on the sum from T1.1.

## Approach

Export `mean(values: number[]): number` from `src/mean.ts`, as `sum(values) / values.length` with `sum` from
`./sum`; the mean of an empty list is `0`. One line of code is enough.
