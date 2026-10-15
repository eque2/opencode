---
hint: test/upper.test.ts
gates: [BUILD-1]
ensures:
  c1:
    category: happy-path
    text: "`upper('abc')` is `'ABC'`, and `upper('')` is `''`."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.1.c1]`.
