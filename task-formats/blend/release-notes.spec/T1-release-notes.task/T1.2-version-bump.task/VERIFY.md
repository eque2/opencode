---
hint: test/verify-release-notes-S3.spec.ts
gates: [BUILD-1, BUILD-2, BUILD-4]
ensures:
  c1:
    category: happy-path
    text: "The S3 rows hold, and the most significant change wins: a breaking commit of any type (including `chore!`) gives major at 1.x and minor below 1.0.0; `feat` gives minor; `fix` and `perf` give patch; `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style` and unknown types give none."
    covers: [S3, SV-1]
  c2:
    category: boundary
    text: "`0.9.9`, `0.3.2`, `0.0.0` and `1.0.0` bump as SV-1 says; a minor bump resets the patch and a major bump resets both; `1.4.2-rc.1+build.5` with a fix gives `1.4.3`, `2.0.0-rc.1` with a breaking change gives `3.0.0`, and with no commits the current version returns exactly as given."
    covers: [S3]
  c3:
    category: invalid-input
    text: "`1.x`, `01.2.3`, `1.2`, `1.2.3-`, `1.2.3-01`, `1.2.3+`, `1.2.3-a..b`, `1.02.3`, `1.2.03`, the empty string and ` 1.2.3` return `{ error }` and never throw."
    covers: [S10]
  c4:
    category: boundary
    text: "Parts beyond `Number.MAX_SAFE_INTEGER` stay exact: `1.4.9007199254740993` with a fix gives `1.4.9007199254740994`."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.2.c1]`.
