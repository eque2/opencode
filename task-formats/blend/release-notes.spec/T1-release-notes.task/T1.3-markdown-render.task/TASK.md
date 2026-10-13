---
after: [T1.1]
touches:
  - path: src/render.ts
    change: new
    what: "the Markdown renderer for grouped release notes"
refs: [RN-D1, RN-D2]
---

# Render the release notes as Markdown

## Goal

Turn parsed and invalid commits into release notes in one exact Markdown format that a test can compare byte for
byte.

## Approach

Export `renderNotes(commits: (ParsedCommit | InvalidCommit)[], options?: { linkify?: (key: string) => string }): string`
from `src/render.ts`; import the types from `./commit`.

The format:

- `# Release notes`, a blank line, then each non-empty group as `## <Heading>`, a blank line and its lines, with a
  blank line between groups. Headings in order: Breaking changes, Features, Fixes, Performance, Other, Unparsed
  commits. The text ends with one `\n`. With no commits at all: `# Release notes`, a blank line, `No changes.`.
- A line is `- **<scope>:** <subject> (<hash>)`, or `- <subject> (<hash>)` without a scope. A breaking commit of
  any type goes only under Breaking changes, and shows ` — <breakingNote>` after the subject when the note differs.
- An invalid commit is `- <first non-blank line, without \r> (<hash>)`, or `(empty message)` when it has none.
- Refs follow the hash as ` — refs A, B`: without `linkify` the renderer escapes them; with `linkify` it inserts
  `linkify(key)` as it is. No refs, no suffix.
- Escape `\`, `*`, `_`, `` ` ``, `[`, `]`, `<`, `>` and `|` with a backslash in scope, subject, note and unparsed
  text. Within a group, keep the input order.
