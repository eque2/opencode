---
after: [T1.2, T1.3]
touches:
  - path: src/cli.ts
    change: new
    what: "the release-notes command-line entry"
  - path: package.json
    change: update
    what: "adds the `bin` entry `release-notes` → `src/cli.ts`"
refs: [RN-D1, RN-D3, RN-D4]
notHere:
  - what: "issue links — the CLI prints refs as plain text until T1.5 wires links in"
    owner: T1.5
---

# Print release notes for a git range

## Goal

Let a maintainer run `release-notes` in a repository and get the notes and the next version for the commits since
the last release, with exit codes a script can rely on.

## Approach

`src/cli.ts` starts with `#!/usr/bin/env bun`. Usage: `release-notes [--from <ref>] [--to <ref>] [--current <version>]`,
also `--name=value`, and `--help` / `-h`. Steps, in order:

1. Parse the arguments. An unknown option, a missing or empty value, a positional argument, or a value that starts
   with `-` prints usage on stderr and exits 2. `--help` prints usage on stdout and exits 0.
2. Run `git --version` inside `try`; a spawn error prints "git not found" on stderr and exits 4.
3. Require `git rev-parse --is-inside-work-tree` to print `true`, else exit 3 with git's message.
4. Check each explicit ref with `git rev-parse --verify --quiet --end-of-options <ref>^{commit}`; a failure exits 2
   and names the ref.
5. With no HEAD and no explicit refs, print `No changes.` with current version `0.0.0` and exit 0.
6. Range start: `--from`, else the latest stable tag,
   `git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' <to>`; with no tag the range is `<to>` alone.
   `--to` defaults to `HEAD`.
7. Current version: `--current` (a leading `v` stripped); else the range start's version when it is a tag shaped
   `vX.Y.Z`; else the latest stable tag reachable from `--from`; else `0.0.0`.
8. Read commits with `git -c log.showSignature=false log -z --no-color --no-merges --format=%h%n%B --end-of-options <range>`,
   split on NUL, and take each record's first line as the hash.
9. Print `renderNotes(...)`, a blank line, and `Next version: <next> (<bump>)` on stdout. Warn on stderr for a
   shallow clone and for an unparsed commit that carries a `BREAKING CHANGE:` footer; otherwise stderr stays empty.

The end-to-end test (S1) builds a repository with `git commit --allow-empty`: `chore: initial` tagged `v1.4.0`, then,
oldest first, `feat(api)!: drop v1 endpoints` with the footer `BREAKING CHANGE: removed /v1`,
`feat(cli): add --to option`, `feat: add JSON export`, `fix(parser): handle empty body` and `update readme`. Its
expected output, in `test/expected/release-notes.md` with `{h1}`…`{h5}` for the short hashes of those five commits:

```
# Release notes

## Breaking changes

- **api:** drop v1 endpoints — removed /v1 ({h1})

## Features

- add JSON export ({h3})
- **cli:** add --to option ({h2})

## Fixes

- **parser:** handle empty body ({h4})

## Unparsed commits

- update readme ({h5})

Next version: 2.0.0 (major)
```
