# Stage 6 — Code Review, Verify & Hand Off (then STOP)

Goal: prove the fix is real, **complete**, and didn't break anything else, write the handoff artifact, and stop — without committing or pushing.

## Code-review the fix first (auto)

A fix that passes its own test can still be half a fix — the test only proves the case you already thought of. Before you trust it, run a **full, context-rich code review** whose job is to find what you missed. This is the review [PR] used to run, moved here where the root-cause context lives — so it can hunt for an incomplete fix instead of reviewing the diff blind. It runs **automatically** in default mode; suppress only with `--no-adversarial` or `--yolo`.

First, give the review the context so it isn't reviewing blind. Write `{feature_artifacts}/bugfix-{slug}/.review-context.md` from your Stage 2 findings — the root cause, every site that shares it, and the input-classes a *complete* fix must cover — so the review can audit the diff against "what done looks like", not just "is this line correct":

```markdown
# Complete-fix scope — {slug}

## Root cause
{root cause from Stage 2}

## Sites a complete fix must cover
{every site that shares the root cause}

## Input-classes a complete fix must handle
{boundaries, null/empty, other enum branches, concurrency, … from Stage 2}
```

Then invoke the full review, pointing it at that file as the acceptance spec:

```
SKILL: bmad-code-review
RUN AS: an automated sub-review — provide the inputs below up front so its context
        cascade resolves without prompting, and auto-confirm its checkpoints (this
        is a programmatic step, not a human-driven review).
DIFF: the working-tree changes of this fix (`git diff HEAD`).
SPEC FILE (→ review_mode "full"): {feature_artifacts}/bugfix-{slug}/.review-context.md
FOCUS: this is a bug fix — above all, hunt for an INCOMPLETE fix. The Acceptance
        Auditor checks the diff against the complete-fix scope in the spec file:
        does it fix the root cause or only a downstream symptom? Did it patch one
        site and leave sibling sites that share the root cause live? Are there
        input-classes the spec names that it still mishandles?
RETURN: the skill's triaged findings (decision_needed / patch / defer / dismiss),
        each with the affected file and a concrete fix.
```

If `bmad-code-review` is not installed in this project, fall back to a single adversarial pass — invoke `bmad-review` with `lenses=adversarial` on the fix diff with the same root-cause/scope context and the same INCOMPLETE-fix focus.

On findings:

- **Apply `decision_needed` and `patch` findings** — running automated, there's no human to resolve a `decision_needed`, so treat it as must-fix. These are the half-fix gaps and real bugs: extend the fix to cover them, and add or widen a test for each newly-covered case so it can't silently regress. `defer`/`dismiss` and subjective nits: skip unless trivial.
- Applying findings changes code, so the whole-suite gate below now also covers the additions — that's the point.
- Cap at **3 apply-and-recheck iterations** (subagent circuit breaker). If the review times out or stalls, log it as skipped and proceed — the suite gate is the authoritative backstop — but record in the handoff that the code review did not complete.

## Check the fix against the project's coding standards

The fix — including anything the adversarial review just added — still has to satisfy the team's review rules, the same ones `[PR]` Stage 2 and an automated PR-review enforce. Catch violations here so the fix reaches `[PR]` already clean.

- **Locate the review rules.** Under Linus, `{agent.review_rules_glob}` is already resolved; standalone, use the `review_rules_glob` from `config.yaml`, falling back to the default `{project-root}/.github/review-rules/*.md`. Rule-ID'd anti-pattern catalogues; configurable for repos whose guides live elsewhere.
- **If no files match, skip** — record "no review rules found" in the handoff and continue. Don't fabricate rules or stall on installing them.
- **Review every file this fix changed** (the Stage 5 fix *plus* any adversarial-review additions) against the matching rules — systematically, scoped to the lines this fix adds or changes plus their enclosing function/class. Cite Rule-IDs.
- **Fix every in-scope violation before writing the handoff**, in a single pass. Don't widen the diff to pre-existing violations on untouched lines — that breaks Stage 5's minimal-fix discipline; leave them for a cleanup PR. If a rule is genuinely wrong for the fix, surface it to the user instead of silently complying.
- These are code changes, so the suite gate below re-runs over them.
- **Suppression:** `--yolo` skips this pass; `--no-adversarial` does not (it governs only the code review above).

## Gate on the whole suite, not just the new test

- Run the **full test suite** (the project's standard command), not only the test you wrote. The new test passing proves the bug is fixed; the *suite* passing proves you didn't break something else. A green new test over a red suite is not done.
- If the full suite is impractically large or slow, run the affected package/area in full plus the new test, and say explicitly what you ran and what you deliberately did not — never let a partial run read as a full pass.
- If anything else now fails: that's collateral from your fix. Treat it as in-scope — diagnose and resolve it, or if it's pre-existing and unrelated, prove that (e.g. it fails on the base revision too) and record it. Do not declare done over a red suite.

## Write the handoff artifact

Write `{feature_artifacts}/bugfix-{slug}/bug-fix.md`:

```markdown
# Bug fix — {slug}

## Report
{symptom / repro / expected-vs-actual; ticket key if any}

## Reproduction
{how it was reproduced; the captured failure signature}

## Root cause
{where and why it broke}

## Why existing tests missed it
{Stage 3 verdict — none / passed-wrongly + diagnosis / already-failing; any test corrected}

## Fix
{files changed and the gist of the change — including every site touched, not just the symptom site}

## Code review
{what bmad-code-review caught and what you applied — or "no gaps found" / "skipped: {reason}"}

## Coding standards
{review-rules checked and in-scope violations fixed (cite Rule-IDs) — or "no review rules found" / "clean"}

## Verification
- New/updated test: {name} — failed for the right reason before, passes after
- Full suite: {command run} — {result}; {anything deliberately not run}
```

## Stop here — do not commit or push

This workflow ends at a verified fix. **Do not** `git add`, `git commit`, or `git push` — review and push are a separate workflow that consumes the handoff artifact above. Close with a short summary: the bug, the root cause, the fix, the verification result, and the path to `bug-fix.md`. If the user explicitly asks you to commit anyway, that's their call to make in the moment — but this workflow does not do it on its own.

## Session close (if running as Linus)

If the sanctum was loaded, follow Linus's memory discipline: note anything worth keeping (a recurring bug class, a weak test pattern, a fragile area) to MEMORY.md, and append a brief session-log line.
