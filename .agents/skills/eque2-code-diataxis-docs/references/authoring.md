# Author the Pages

Write each mapped page to its mode's contract (`references/diataxis.md`), in Markdown, at
its planned path under `{docs_root}`. The content language is `{document_output_language}`.

## Page format

```markdown
---
title: How to rotate the signing key
doc-type: how-to
sources: [src/keys/, config/keys.example.yaml]
---

# How to rotate the signing key

> **TL;DR:** Two to four sentences that give the whole takeaway.

…body to the mode's contract…
```

- `doc-type` is one of `tutorial`, `how-to`, `reference`, `explanation`, `contributing`,
  `index`. It also marks the page as owned by this skill.
- `sources` lists the code paths the page documents, relative to the project root. Update
  mode uses it to find stale pages, so keep it precise. Index pages omit it.
- Every page except an index opens with the TL;DR blockquote directly under the H1.

## Quality bar

- **Accurate.** State only what the code or config confirms. Copy commands, flags, defaults,
  and signatures from the source; run a command when it is safe and cheap to confirm it.
  Never invent an option, an output, or a version.
- **Complete for its scope.** A reference page covers every item it claims to cover; a
  how-to covers the real variations, not only the happy path. Say plainly what is optional.
- **One mode per page.** When a page starts to drift, split it and cross-link.
- **Cross-linked.** Link related pages across modes, with Markdown links relative to the
  page's own folder that point at the target's planned path.
- **Reader-facing.** Never name the documentation framework. In pages for outside users, do
  not cite ticket numbers, ADR numbers, scratch files, or `file:line` locations — explain the
  concept in its own terms. `contributing/` pages may point at files and lines.

## Index pages

- `{docs_root}/index.md` (`doc-type: index`): what the project is and who it is for, the
  flagship, then one short section per docs section, described by the reader's need
  ("Start here", "Get a task done", "Look something up", "Understand the design") with links.
- `<section>/index.md` (`doc-type: index`): one line per page — link and a one-line summary.
  Every page must be linked from an index; the validator reports orphans.

Write the index pages after the content pages, from what was actually written.

## Writing in parallel

When subagents are available, batch the map — three to five related pages per batch,
grouped by shared `sources` — and dispatch the batches in parallel. Each subagent prompt
carries: the batch entries (title, doc-type, path, sources, related pages with paths),
`{docs_root}`, `{document_output_language}`, the ownership rule (never overwrite a file
without `doc-type` frontmatter), and the full paths of `references/diataxis.md` and this
file under `{skill-root}` for it to read first. Tell each one to read the sources itself.
Require: "Return ONLY one JSON object per page, one per line —
`{"path": "...", "status": "written" | "skipped", "note": "..."}` — and no other output."

Collect the results, re-dispatch skipped pages once with the note as context, and record any
page still skipped in the decision log. Without subagents, write the pages one section at a
time, in the same order: tutorials, how-to, reference, explanation, contributing.
