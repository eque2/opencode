---
hint: test/clamp.test.ts
ensures:
  c1:
    category: happy-path
    text: "`clamp(5, 0, 3)` is `3`, `clamp(-1, 0, 3)` is `0`, and `clamp(2, 0, 3)` is `2`."
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.3.c1]`.
