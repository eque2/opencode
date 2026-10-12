---
touches:
  - path: src/bump.ts
    change: new
    what: "the semantic-version bump rule"
refs: [SV-1, RN-D1, RN-D2]
notHere:
  - what: "parsing commit messages — this task receives commits already shaped `{ type, breaking }`"
    owner: T1.1
---

# Compute the next version

## Goal

From the commits since the last release and the current version, say whether the release is major, minor, patch
or none, and give the next version.

## Approach

Export from `src/bump.ts`:

- `type BumpInput = { type: string; breaking: boolean }` — declared here, so this task does not import the parser
  and can be built at the same time as T1.1.
- `nextVersion(current: string, commits: BumpInput[]): { bump: "major" | "minor" | "patch" | "none"; next: string } | { error: string }`

Rules: a breaking commit of any type gives major, or minor below 1.0.0; `feat` gives minor; `fix` and `perf` give
patch; every other type gives none; the most significant change wins. A bump computes from MAJOR.MINOR.PATCH,
resets the lower parts, and drops pre-release and build metadata; `none` returns the current version exactly as
given. Parse numbers as `BigInt`. An invalid version returns `{ error }`, never a throw.
