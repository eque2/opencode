---
touches:
  - path: src/commit.ts
    change: new
    what: "the conventional-commit parser and its types"
refs: [CC-1, RN-D1, RN-D2]
---

# Parse a conventional-commit message

## Goal

Turn one commit message into a parsed commit, or into an invalid commit with a reason, without ever throwing.

## Approach

Export these from `src/commit.ts`:

- `type ParsedCommit = { valid: true; hash: string; type: string; scope?: string; subject: string; body?: string; breaking: boolean; breakingNote?: string; refs: string[] }`
- `type InvalidCommit = { valid: false; hash: string; raw: string; reason: string }`
- `parseCommit(hash: string, message: string): ParsedCommit | InvalidCommit`

Rules:

- Normalise `\r\n` to `\n`. An empty or whitespace-only message is invalid: "empty message".
- The header must match
  `^(?<type>[A-Za-z][A-Za-z0-9-]*)(?:\((?<scope>[A-Za-z0-9][A-Za-z0-9._/-]*)\))?(?<bang>!)?: (?<subject>\S.*)$`.
  The type is lower-cased. A header that does not match is invalid with a reason.
- A second line must be blank, or the message is invalid: "body must follow a blank line".
- The footer block is the final paragraph, and only when its first line matches
  `^(BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)`. Indented lines continue the previous footer.
  Everything between the header and the footer block is the body, kept whole.
- Breaking: `!` before the colon, or a `BREAKING CHANGE: ` or `BREAKING-CHANGE: ` footer (upper case, colon and
  space). `breakingNote` is the footer's text, or the subject when only `!` marks the change.
- `Refs` footers (token case-insensitive, `: ` or ` #`) give keys, split on commas and spaces, de-duplicated in
  first-seen order.
