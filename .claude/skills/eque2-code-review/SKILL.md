---
name: eque2-code-review
description: Reviews local changes against the repo's styleguide review rules. Use when the user selects [RV], says 'review my changes', 'run the code review locally', or 'review against the styleguides'.
---

# Code Review [RV]

## Overview

Reviews the current branch's changes locally against the repository's own review rules — the same styleguides the GitHub PR-review Action applies — and produces a findings report. Act as a senior reviewer who knows these styleguides rule by rule. Args: `--base <ref>` (default: the default branch), `--headless` / `-H`.

**Why this exists:** devs found the GitHub Action review better than local reviews. The difference is that the Action reviews **every changed file against every applicable styleguide rule, skipping nothing**, and writes each finding in the styleguide's own "PR Review Comment Format". Generic local reviews never load the styleguides. This workflow reproduces the Action's review locally. It knows nothing about pull requests: it never posts, fetches, or resolves PR comments, and it never edits code.

## Conventions

- Bare paths (e.g. `scripts/collect-review-context.py`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.

## On Activation

Load `{project-root}/_bmad/config.yaml` and `{project-root}/_bmad/config.user.yaml` (root and `eque2-code` section) for `{communication_language}` and `{output_folder}` (default `{project-root}/_bmad-output`). If config is missing, continue on defaults and add one line to the report header (and, interactively, to the summary) suggesting `eque2-code-setup`.

## Collect

Run `python3 {skill-root}/scripts/collect-review-context.py --project-root {project-root} [--base <ref>]` (see `--help`). It returns the branch, the base ref and merge-base, every changed file (committed, staged, unstaged, untracked; `D` = deleted), and every rule file from `.ai/Code Reviews/styleguides/` and `.github/review-rules/` with its headers.

Stop and report when:
- `status` is `error` — show the reason.
- `rules` is empty — say no review rules are installed and suggest `[IS]` (`eque2-code-install-styleguide`).
- no non-deleted changed files — say there is nothing to review.

Decide which rule files apply to which changed files. Headers are often missing (`applies_to` is null in real guides), so judge from the rule's `name` (e.g. "Angular 17" → Angular sources, templates, styles) and the file types. When a rule plausibly covers a file, include it — the Action's bar is "do not skip files". A file no rule's technology covers (CI YAML, prose Markdown) goes to the general reviewer only; a run where no rule matches any file is still a valid review. Note the rule paths for the reviewers; the orchestrator does not read the styleguides (in the sequential fallback, read each one only while acting as its reviewer).

## Review

Fan out in parallel, one subagent per applicable rule file, plus one **general** subagent. When a rule file applies to more than ~15 files, split those files across several subagents for that rule. Without subagents, run the same reviews one after another.

Each rule subagent gets: the rule file path, its file list, the merge-base, and this brief:

> Read the whole styleguide at `<rule path>`. Get each file's changes with `git diff <merge-base> -- <file>` — this compares against the working tree, so it covers committed, staged, and unstaged edits together (untracked files, status `?`: read the whole file). Check EVERY listed file against EVERY applicable rule — do not skip files. Report only problems in changed lines. Write each finding's `body` in the styleguide's "PR Review Comment Format" section if it has one; otherwise use **Issue / Why this matters / Suggested fix**. Return ONLY a JSON array, no other output: `[{"path": str, "line": int (a changed line in the new file), "severity": "critical"|"high"|"medium"|"low", "rule": str (rule id or name), "title": str (≤80 chars), "body": str}]`. Return `[]` when clean.

The general subagent gets every changed file and the same return contract, with `rule` set to `"general"` and bodies in **Issue / Why this matters / Suggested fix**. Its focus replaces the styleguide: code quality, security, performance, testing, and documentation — the Action's "Focus on" line. It skips pure style points the styleguides cover.

Merge the arrays. Drop exact duplicates (same path, line, and issue); keep distinct issues on the same line as separate findings.

## Report

Write `{output_folder}/code-reviews/review-<branch>-<YYYY-MM-DD-HHMM>.md` in `{communication_language}` (branch `/` → `-`):
- Header: branch, base ref, merge-base, date, files reviewed, rule files applied and which files each covered (or "none matched — general review only").
- `## Findings` — each finding as `### <severity>: <title>`, then `` `path:line` `` · rule, then the full `body`, in severity order.
- `## Overall Assessment` — 2–3 sentences, high level only.

Then show the summary in the terminal, like the Action's summary comment: one header line (branch vs base, files reviewed, rule files applied), then Critical / High / Medium / Low sections (omit empty ones), one line per finding — `title` + `path:line` — with no detail, then the report path. With zero findings, say "No issues found" and still write the report.

**Headless:** write the same report, then emit only:
`{"status": "complete"|"blocked", "report": "<path or null>", "counts": {"critical": n, "high": n, "medium": n, "low": n}, "reason": "<only when blocked>"}`
The stop conditions in Collect return `blocked`.
