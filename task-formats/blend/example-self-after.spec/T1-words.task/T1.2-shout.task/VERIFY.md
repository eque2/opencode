---
hint: test/shout.test.ts
gates: [BUILD-1]
ensures:
  c1:
    category: happy-path
    text: "`shout('hi')` is `'HI!'`."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.2.c1]`.
