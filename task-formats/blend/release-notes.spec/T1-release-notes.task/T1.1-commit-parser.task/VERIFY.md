---
hint: test/verify-release-notes-S2.spec.ts
gates: [BUILD-1, BUILD-2, BUILD-4]
ensures:
  c1:
    category: happy-path
    text: "A valid header gives its type (lower-cased), optional scope and subject; the subject keeps any later `: `, as in `fix: handle a: b`."
    covers: [S2, CC-1]
  c2:
    category: happy-path
    text: "`!` before the colon, a `BREAKING CHANGE: ` footer and a `BREAKING-CHANGE: ` footer each make the commit breaking with its `breakingNote`; `BREAKING CHANGE #12`, `breaking change: x` and `breaking-change: y` do not."
    covers: [S2, CC-1]
  c3:
    category: happy-path
    text: "`Refs: ` and `Refs #` footers in any case give the keys, split on commas and spaces, de-duplicated in first-seen order."
    covers: [S2]
  c4:
    category: boundary
    text: "A multi-line body is kept whole; a `Note: x` line outside the final paragraph stays in the body; a final paragraph that does not start with a footer token is body; indented lines continue a footer; `!` after the colon is subject text; `\\r\\n` parses like `\\n`."
    covers: [S2]
  c5:
    category: invalid-input
    text: "A message with no type, no space after the colon, an empty subject, a malformed scope (`feat(: x`, `feat(): x`, `feat!(api): x`, `feat (api): x`, `feat(a)(b): x`), a body with no blank line before it, or no text at all returns an invalid commit with a reason and never throws."
    covers: [S7]
rejects:
  c5:
    - "asserting only that no exception was raised. Assert `valid: false` and the exact reason."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.1.c1]`.
