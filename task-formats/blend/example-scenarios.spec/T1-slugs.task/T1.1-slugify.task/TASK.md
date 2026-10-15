---
touches:
  - path: src/slug.ts
    change: new
    what: "the slug function"
refs: [EX-D1]
---

# Slug a title

## Goal

Turn a release title into its slug.

## Approach

Export `slugify(title: string): string` from `src/slug.ts`: lower-case the title, replace each run of characters
other than `a`–`z` and `0`–`9` with one `-`, and trim `-` from both ends. One line of code is enough.
