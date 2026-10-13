---
hint: test/verify-release-notes-S4.spec.ts
gates: [BUILD-1, BUILD-2, BUILD-4]
ensures:
  c1:
    category: happy-path
    text: "The output follows the exact format: the H1, the headings in fixed order with the blank-line layout, empty groups left out, the line shape with the scope in bold and the `(hash)`, the breaking note, one trailing newline, and `No changes.` for no commits."
    covers: [S4]
  c2:
    category: happy-path
    text: "Breaking commits of any type appear only under Breaking changes; non-listed and unknown types go under Other; input order holds within a group."
    covers: [S4]
  c3:
    category: invalid-input
    text: "Invalid commits are listed last under Unparsed commits as their first non-blank line without `\\r`, or `(empty message)`; input with only invalid commits shows no `No changes.`, and input with none has no Unparsed heading."
    covers: [S4]
  c4:
    category: security
    text: "Commit text cannot inject a link, HTML or a table cell: the nine characters are escaped; refs are escaped without `linkify` and inserted as they are with it; a commit with no refs has no suffix."
  c5:
    category: happy-path
    text: "Every input hash appears exactly once, counted at the `(hash)` token that ends each line before any refs suffix, even when a subject quotes another hash."
    covers: [S12]
rejects:
  c1:
    - "comparing against output produced by the code under test. Write the expected text in the test from the format in TASK.md."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.3.c1]`.
