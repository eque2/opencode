---
after: [T1.3, T1.4, T9]
touches:
  - path: src/links.ts
    change: new
    what: "the issue-link config parser and link builders"
  - path: src/cli.ts
    change: update
    what: "reads the repository's config and passes a `linkify` to the renderer"
refs: [RN-A2, RN-D1, RN-D2]
---

# Link issue references

## Goal

Turn each `Refs:` key in the notes into a link to the team's issue tracker, using the key pattern and URL template
agreed with the tracker owners, without ever losing a ref.

## Approach

`src/links.ts` is pure. Export:

- `parseLinkConfig(text: string): { issueUrl: string; keyPattern: RegExp } | { error: string }` — JSON with a
  required `issueUrl` (`http` or `https`, containing `{key}`) and an optional `keyPattern` (default RN-A2, anchored,
  compiled without the `g` flag). Anything else returns `{ error }`, never a throw.
- `makeLinkify(config): (key: string) => string` — a matching key becomes `[<key>](<url>)` with every `{key}`
  replaced; the link text escapes `[`, `]`, `(` and `)`, and the URL encodes `(` and `)` as well as what
  `encodeURIComponent` encodes. A key that does not match stays plain, escaped as the renderer escapes.
- `plainLinkify(key: string): string` — the key, escaped as the renderer escapes.

`src/cli.ts` reads `<git rev-parse --show-toplevel>/release-notes.config.json`. Missing: `plainLinkify`, silently.
Unreadable or invalid: a warning on stderr that names the problem, then `plainLinkify`. Valid: `makeLinkify`. The
package ships no default config. Tests use the reserved `.test` domain, for example
`{"issueUrl": "https://issues.eque2.test/browse/{key}", "keyPattern": "^[A-Z][A-Z0-9]+-\\d+$"}`.
