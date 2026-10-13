---
name: eque2-code-check-doc-snippets
description: Compiles and lints every code block in the repo's Markdown, then reports or splices in fixes. Use when the user says 'check doc snippets', 'check the code in the docs', 'do the README examples compile', 'run CD', or '/eque2-code-check-doc-snippets'.
---

# Check Doc Snippets [CD]

## Overview

This skill lifts every fenced code block out of the repository's Markdown
files into a scratch harness, supplies the imports, declarations, and
wrappers a fragment leaves out, and runs the repository's own compiler and
linter over it. Act as a docs engineer who treats a code sample as code: a
snippet that does not compile teaches the reader a wrong API. Produces a
report of every failure at its Markdown `file:line`; with `--fix`, it also
corrects each failing snippet in place.

Args:

- `--fix` — splice corrected snippets back into the `.md` files. Never commits.
- `--headless` / `-H` — no questions; report mode unless `--fix` is also given.
- Paths or globs narrow the scan; `--exclude <glob>` (repeatable) drops more.

It edits nothing outside a fenced block. No agent menu dispatches it.

## Conventions

- Bare paths (e.g. `scripts/doc-snippets.py`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.

## On Activation

Load config from `{project-root}/_bmad/config.yaml` and
`{project-root}/_bmad/config.user.yaml` (root and `eque2-code` section). If
config is missing, mention that `eque2-code-setup` can configure the module,
and default `{output_folder}` to `{project-root}/_bmad-output`. Bind
`{report_path}` = `{output_folder}/snippet-checks/<YYYY-MM-DD-HHMM>.md`.

## Extract

Run `python3 {skill-root}/scripts/doc-snippets.py extract --root {project-root} [paths] [--exclude <glob>]...`
(`--help` documents the harness contract). It prints a summary; the full
record is `{project-root}/.snippet-check/manifest.json`, and each checkable
block is a harness at `.snippet-check/<ext>/<id>.<ext>`. Note these paths for
the checkers; do not read the harness files in the parent.

- The harness lives inside the repo on purpose: the repo's tsconfig, linter
  config, and `node_modules` must resolve exactly as they do for real code.
- BMad install trees are excluded by default. Pass `--exclude` for any other
  generated or vendored copy the repo holds (a distribution tree, a docs
  build), since a fix there is overwritten.
- In a monorepo, run once per package with `--root <package>`.

Interactive: show the counts per language and per status (`skip-marker`,
`empty`, `unmapped`), name the toolchain found for each language, and ask
whether anything else must be excluded before checking.

## Check

Dispatch one subagent per harness language folder; split a folder past ~60
blocks into batches by source directory. Without subagents, run the same
brief inline, one language at a time. Give each subagent the folder, the
manifest path, the mode (`report` or `fix`), and this brief:

> Check the doc-snippet harnesses in `<folder>` (records in `<manifest>`,
> matched by `id`).
>
> 1. Find this repo's compiler or type-checker and linter for the language,
>    with the repo's own config. Point them at the folder — for example, a
>    `tsconfig.json` in the folder that `extends` the repo's and includes only
>    the harnesses. No toolchain at all: every block is `unchecked`.
> 2. Skip a block when its `prose` or its body marks it as wrong on purpose,
>    pseudo-code, a placeholder template, a shell transcript with prompts and
>    output, or a diff. Record the reason.
> 3. Make each other harness self-sufficient: add imports, declarations, and
>    wrappers above the `snippet-check:body-start` line and below the
>    `snippet-check:body-end` line. Never edit the markers. A TS/JS harness
>    must be a module (`export {}`), or names in one snippet collide with
>    another. A missing import the reader would plainly have is harness work,
>    not a doc failure.
> 4. Run the tools. Judge each diagnostic by one test: would a reader who
>    pastes the snippet into this repo hit it? A wrong API, a type error, a
>    syntax error, or a banned or deprecated call fails. A diagnostic the
>    harness causes (indent inside a wrapper, unused prelude import, filename
>    rules) and an unused name in an illustrative fragment do not.
> 5. Fix mode only: edit the body between the markers until it passes, at
>    most 3 attempts per block. Keep the change minimal and the snippet's
>    teaching intent; never move harness imports into the body.
> 6. Never set a command timeout above 180000 ms; kill a command silent for
>    120 s and mark its blocks `unchecked`.
>
> Return ONLY a JSON array, one entry per block:
> `[{"id":"0007","at":"<file>:<fence_line>","status":"pass|fail|fixed|skip|unchecked","reason":"<one line>","diagnostics":[{"md_line":57,"message":"<tool text>"}]}]`.
> Body line k of a block is Markdown line `fence_line + k`.

## Splice

Fix mode only. Run `python3 {skill-root}/scripts/doc-snippets.py splice --root {project-root}`.
It writes each changed body back into its `.md` file at the original
indentation, after it confirms the file still holds the extracted text. A
conflict leaves that block untouched; list it in the report as `fail`. Show
`git diff --stat -- '*.md'` afterwards.

## Report

Write `{report_path}`: totals per status and language; every `fail` with
`file:line`, language, diagnostic, and a one-line cause; every `fixed` with
what changed; every `skip` with its reason; each `unchecked` language with
why, plus the `marker_skips` list and the `unmapped` count from Extract. Close the report with the opt-out for a block that is wrong on purpose:
`<!-- snippet-check: skip <reason> -->` on the line above its fence.

Then run `python3 {skill-root}/scripts/doc-snippets.py clean --root {project-root}`.

Interactive: lead with the counts and the report path. Offer a `--fix` run
when failures exist.

Headless: emit JSON only —
`{"status":"complete","report":"<path>","failed":N,"fixed":N,"unchecked":N}`.
When no Markdown holds a code block, or a script exits 2, return
`{"status":"blocked","reason":"<one line>"}`.
