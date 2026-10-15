---
hint: test/slug.test.ts
ensures:
  c1:
    category: happy-path
    text: "`slugify` gives `hello-world` for `Hello, World!`, `v1-2-0` for ` v1.2.0 `, and an empty string for `!!!`."
    covers: [S1]
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.1.c1]`.
