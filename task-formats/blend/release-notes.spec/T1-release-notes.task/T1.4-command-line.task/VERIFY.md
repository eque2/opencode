---
hint: test/verify-release-notes-S1.spec.ts
gates: [BUILD-1, BUILD-2, BUILD-3, BUILD-4]
ensures:
  c1:
    category: happy-path
    text: "On the five pinned S1 commits the tool exits 0, writes nothing to stderr, and prints exactly the expected file with the hashes filled in, ending `Next version: 2.0.0 (major)`."
    covers: [S1]
  c2:
    category: happy-path
    text: "The range and the current version follow the steps: the latest stable tag (skipping `nightly` and pre-release tags); `--from`/`--to` and `--name=value`; `--current` with or without `v` overrides the tag; a SHA `--from`; no tag gives the whole history and `0.0.0`; HEAD on the tag gives `No changes.` and `(none)`; an empty repository gives `No changes.`."
    covers: [S6]
  c3:
    category: invalid-input
    text: "Bad arguments — an unknown option, a missing or empty value, a positional argument, a value starting with `-`, an unknown ref — print nothing on stdout and exit 2; `--help` and `-h` print usage on stdout and exit 0."
    covers: [S8]
  c4:
    category: failure
    text: "In an empty folder, inside `.git` and in a bare repository the tool exits 3 and shows git's message."
    covers: [S9]
  c5:
    category: invalid-input
    text: "`--current 1.x` exits 2."
    covers: [S10]
  c6:
    category: failure
    text: "Spawned as `process.execPath src/cli.ts` with `PATH` set to an empty folder, the tool prints `git not found` and exits 4."
    covers: [S11]
  c7:
    category: boundary
    text: "Merge commits are left out; a message cannot split a log record; a shallow clone and an unparsed breaking footer each give a warning on stderr with exit 0; tests isolate git as RN-D4 says."
    covers: [S1]
  c8:
    category: compatibility
    text: "`src/cli.ts` starts with `#!/usr/bin/env bun`, `package.json` has the `bin` entry, and the delivery test reports skipped, never passed, when `RELEASE_NOTES_REGISTRY` is unset."
    covers: [S13]
preserves:
  p1:
    text: "the seed's `name`, `version`, `files`, scripts and pinned dev dependencies in `package.json`"
    proof: review
forbids:
  f1:
    text: "changing the parser"
    proof: {unchanged: src/commit.ts}
  f2:
    text: "changing the bump rule"
    proof: {unchanged: src/bump.ts}
rejects:
  c1:
    - "writing the expected file from the tool's own output. Write it from the text in TASK.md."
  c6:
    - "mocking the spawn call. Run the real entry with a `PATH` that has no git."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.4.c1]`.
