---
name: eque2-code-diataxis-docs
description: Generates Diataxis documentation for a codebase as Markdown. Use when the user says 'generate Diataxis docs', 'write Diataxis documentation', 'update the Diataxis docs', or 'validate the docs against Diataxis'.
---

# Diataxis Docs

## Overview

This skill writes documentation for a codebase in the four Diataxis modes — tutorials, how-to guides, reference, and explanation — as Markdown inside the repository. Act as a senior technical writer who reads code: the code is the ground truth, every page serves exactly one reader need, and every page is accurate enough to trust without checking. It maps the codebase, agrees a page plan with the user, writes the pages (in parallel when subagents are available), and checks the set with a validator script. The default scope is **exhaustive**; `--curated` writes a ranked shortlist of the highest-value pages instead and records the rest as deferred.

Args:

- **Intent** — `create` (default), `update` (refresh pages after code changes, or extend a curated set), or `validate` (grade existing docs; change nothing). Infer it from the phrasing.
- `--curated[=N]` — write only the N highest-value pages (default 10). Without it, the scope is exhaustive.
- `--out <dir>` — the docs root. Default: `project_knowledge` from config, else `{project-root}/docs`.
- `--headless` / `-H` — no prompts; every assumption goes to the decision log.

## Conventions

- Bare paths (e.g. `references/diataxis.md`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.

## On Activation

Load `{project-root}/_bmad/config.yaml` and `{project-root}/_bmad/config.user.yaml` if present (root level and the `bmm` section): `user_name`, `communication_language`, `document_output_language`, `project_knowledge`. Bind `{docs_root}` from `--out`, else `project_knowledge`, else `{project-root}/docs`.

`{docs_root}/.decision-log.md` is the run memory. Create it if absent; every run appends a dated heading that names the intent, the scope, and the commit it documented (`git rev-parse HEAD`). Under that heading go the audience call, the exclusions and why, the approved page map (written and deferred pages), and every user override. Update and validate read it before anything else.

**Open the floor** (interactive only): before scanning, ask in one exchange who reads these docs and what for, which areas matter most, what to leave out, and whether existing docs should anchor the set. Then a soft "anything else?".

**Ownership rule.** A page this skill owns carries `doc-type` frontmatter. Never overwrite, move, or delete a file without it — existing docs are source material, not targets (`bmad-document-project`, for one, already writes a `docs/index.md`). On a path collision, ask the user: overwrite, adopt the file, or choose another path. Headless stops with `blocked` and names the file.

## Create

1. Read `references/diataxis.md`. It is the lens for every later decision.
2. Build the page map per `references/map-the-codebase.md`.
3. **Approve the plan** (interactive). Show the map grouped by section: every page for exhaustive; the ranked shortlist plus the next five deferred candidates for curated. Get one approval, apply the user's edits, and record the approved map in the decision log.
4. Write the pages per `references/authoring.md`.
5. Run **Check and finish**.

## Update

Read the decision log: the last documented commit, the scope, the deferred pages. Find stale pages with `git diff --name-only <last-commit> HEAD`, matched against each page's `sources`. Re-sweep for public surface the map does not cover yet (new commands, modules, config, endpoints). Then:

- Rewrite stale pages. Change what the code change invalidates and keep the rest — pages may carry hand edits.
- New surface gets new pages (exhaustive) or goes into the deferred list with a rank (curated).
- `update --exhaustive` on a curated set writes all its deferred pages.

When a change contradicts a logged decision, say so before applying it, then log the override. Run **Check and finish**.

## Validate

Read the decision log. Run the validator (below) when the set carries `doc-type` frontmatter; skip it for docs this skill did not write. Then judge what a script cannot:

- **Mode drift** — a tutorial that stops to explain, a how-to that teaches, a reference that instructs.
- **Accuracy** — spot-check each page's claims against its `sources` and the current code.
- **Coverage** — public surface with no page; how-tos missing for tasks readers clearly do.

Report the findings ranked by reader impact: page, defect, fix. Change nothing unless the user asks. Record the findings in the decision log.

## Check and finish

```bash
python3 {skill-root}/scripts/validate_docs.py {docs_root} --project-root {project-root}
```

It prints a JSON report (`--help` lists every check): errors for missing frontmatter, a page in the wrong section folder, a missing TL;DR, broken relative links, and pages no index links to; warnings for `sources` paths that no longer exist and for the framework's name in reader content. Fix every error and re-run. After three failed attempts on the same error, stop and show it to the user. Treat warnings as judgment calls: fix a stale `sources` path; a framework mention is fine on a page that documents a documentation tool.

Finish with a decision-log audit: every entry is either reflected in the docs or explicitly set aside, and the user sees that accounting. Report the landing page path and the page count per section. For a curated run, list the deferred pages and say that `update --exhaustive` writes them.

## Headless

Skip the open floor and the plan approval. Take the full map (exhaustive) or the ranked shortlist (curated) as approved, and log every assumption — audience, exclusions, ranking. Emit JSON only:

```json
{ "status": "complete", "intent": "create", "scope": "exhaustive", "docs_root": "<path>", "pages": 42, "decision_log": "<path>" }
```

Validate adds `"findings": <count>`. On failure: `"status": "blocked"`, a one-line `"reason"`, and the paths that exist.
