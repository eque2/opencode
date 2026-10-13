# Stage 2 — Enforce Coding Standards

Goal: make the diff comply with the project's review rules before it opens as a PR — and *fix* what matters, not just log it. **Correctness/adversarial review is not done here:** [BF] (and [DS]) already review the change with full root-cause/spec context upstream, so this stage is the cheap, non-redundant style net only. The bar: nothing reaches the PR that the team's own review rules (or an automated PR-review bot) would just comment on afterwards.

## Enforce the project's coding standards (styleguide compliance)

This is the gate that stops the PR opening with violations a reviewer — human or the repo's review bot — would only flag *after* the push. The same review-rules an automated PR review reads are already on disk; apply them here and **fix** what they catch.

- **Locate the review rules.** Use the project's review-rules glob: when Linus dispatched this, `{agent.review_rules_glob}` is already resolved in context; standalone, use the `review_rules_glob` configured in `config.yaml`, falling back to the default `{project-root}/.github/review-rules/*.md`. Each file is a Rule-ID'd anti-pattern catalogue with a "PR Review Comment Format" section — the exact input an automated PR-review uses. The glob is configurable, so a repo whose guides live elsewhere (e.g. `.ai/Code Reviews/styleguides/*.md`) points it there.
- **If the glob matches no files, skip this section** — record "no review rules found" for the PR description and move on. Do not fabricate rules, and do not stall trying to install them (bootstrapping `[IS]` is pre-flight's job, and only under Linus).
- **Match rules to the diff.** Load the review-rules file(s) for the stack(s) the diff actually touches; if it's clearly one stack, load just that file. If many would apply, prefer the ones whose `Applies To:` matches changed files and note any you skip for size.
- **Review the diff against the applicable rules**, systematically — file by file. Scope each rule to the **lines this PR adds or changes** (plus the enclosing function/class for block-level rules) — the same lines a PR-review bot can anchor a comment to. Don't chase pre-existing violations on untouched lines; those are a separate cleanup PR. Cite each finding's Rule-ID.
- **Fix every in-scope violation before the PR opens**, in a single pass — apply the corrections to the working tree; don't re-loop the rules against your own corrections. Two exceptions, both of which you surface to the user (with the Rule-ID) rather than deciding alone: a rule that's genuinely wrong for this change, or a rule whose fix would balloon the PR's scope (e.g. a repo-wide rename). Record the outcome in the PR description.
- **Suppression:** `--yolo` skips this pass.

## Strip what shouldn't ship

A quick scope pass — hygiene, not a correctness review:

- Pull out unrelated changes that crept in (a PR should do one thing), debug leftovers (stray prints/logs), and anything secret-shaped (keys, tokens, `.env` values).
- If you happen to spot a likely correctness bug here, that's a signal the change never went through [BF]/[DS] review — surface it to the user rather than silently shipping. But don't turn this stage into a full review; that lives upstream.

## Output of this stage

- A diff with **every applicable review-rule violation fixed** and obvious out-of-scope / secret / debug content stripped. Note any review-rule you deliberately didn't apply (with its Rule-ID and why) for the PR description.

Proceed to `03-verify.md`.
