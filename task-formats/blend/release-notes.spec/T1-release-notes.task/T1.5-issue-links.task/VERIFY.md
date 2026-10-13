---
hint: test/verify-release-notes-S5.spec.ts
gates: [BUILD-1, BUILD-2, BUILD-3, BUILD-4]
ensures:
  c1:
    category: happy-path
    text: "`PAY-12` becomes `[PAY-12](https://issues.eque2.test/browse/PAY-12)`; every `{key}` in a template is replaced; `nonsense`, `pay-12` and `PAY-` stay plain under the default pattern."
    covers: [S5, RN-A2]
  c2:
    category: invalid-input
    text: "`parseLinkConfig` returns `{ error }` and never throws for malformed JSON, the empty string, `null`, an array, a missing or non-string `issueUrl`, a template without `{key}`, a scheme other than `http` or `https`, and a `keyPattern` that is not a string or not a valid regular expression; a missing `keyPattern` uses the default."
  c3:
    category: security
    text: "A key cannot break the link: the link text escapes `[`, `]`, `(` and `)`, the URL encodes `(` and `)`, and under a permissive pattern `A)B` gives `[A\\)B](https://x.test/A%29B)`; the same key gives the same result every time."
  c4:
    category: happy-path
    text: "The CLI reads the config from the repository top level, also when run from a subfolder; a missing config is silent; an unreadable or invalid config warns on stderr; in every case the refs still appear, as links or as plain text, and the exit code is 0."
    covers: [S5]
forbids:
  f1:
    text: "changing the renderer to add links — links reach it only through `linkify`"
    proof: {unchanged: src/render.ts}
---

# Verify

Each obligation is proved by a passing test whose title starts with its qualified id, for example `[T1.5.c1]`.
