---
name: eque2-code-test-validation
description: Score one Playwright *.spec.ts (or a folder/glob of them) against the anti-flakiness best-practice rubric, report per-test findings with severity and line refs, then offer to auto-fix the mechanically-fixable ones under confirmation. Generates no new test. Use when the user selects [TV], says 'validate this test', 'check test quality', 'is this test flaky?', 'lint these specs', or 'validate the tests in <folder>'.
---

# Test Validation Review

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

This skill is a **read, score, and report** gate over existing Playwright tests. It
loads the canonical anti-flakiness rubric, scores each `*.spec.ts` against it, reports
per-test findings (compliant, or findings with severity + line references), then
**offers to auto-fix** the mechanically-fixable anti-patterns under the author's
explicit confirmation. It **never auto-fixes silently** and it **never generates a new
test** — remediation only ever rewrites flagged lines in tests that already exist.

It is the canonical implementation of test-quality scoring for this module:

- **Standalone** — Grace runs it as `[TV]` for on-demand validation of one test or a
  whole folder/batch.
- **Dispatched** — Linus's `[ET]` pipeline invokes it mid-Stage-6 as an internal gate
  (hidden on Linus, exactly as `[XC]` is), after the fidelity gate and inside the same
  ≤3-iteration fix budget.

The standard it scores against is bundled in `references/`:
`validation-rubric.md` (the scoring rubric), `build-time-guidance.md` (the same standard
as authoring rules — what `[ET]` cites at build time), and `constrained-spa-playbook.md`
(iframe / heavyweight-vendor-SPA escape hatches; bounded+documented settles there are
`waived`, not failures).

## Inputs

Strip any leading `@`, then classify the argument by this **precedence** (first match wins),
so an arg that looks like both a file and a glob is never ambiguous:

1. **Contains a glob metacharacter** (`*`, `?`, `[`) → **glob**. Expand to every matching
   `*.spec.ts` / `*.test.ts`. Validate each; emit a per-test report plus a summary.
2. **Resolves to a directory** → **folder**. Recurse for every `*.spec.ts` / `*.test.ts`
   under it. Validate each; emit a per-test report plus a summary.
3. **Otherwise** → **single test file** — a path ending `*.spec.ts` or `*.test.ts`. Validate
   that one file. (A non-spec path is reported as not a test file, not scored.)
4. **No argument** —
   - *Interactive:* offer the most-recently-built/modified spec under the test directory as
     the default target, or let the user pick; confirm before scoring.
   - *Headless:* an argument is **required**. With none, do not prompt — emit the blocked
     contract (`status: blocked`, `reason: "no target spec provided"`) and exit.

The spec glob is **`*.spec.ts` / `*.test.ts`** everywhere — the single-file, folder, and
glob branches accept the same two suffixes, so no file a single-file run would score is
silently dropped by a folder/glob run.

Resolve the test directory from config (`TEST_CODE_DIR`) when present; otherwise infer
from `playwright.config` / the repo's `tests/` location.

## On Activation

Run the standard bootstrap **unless the caller already resolved config + pre-flight this
turn** (dispatched by Grace's `[TV]` or Linus's `[ET]`):

1. **Resolve customization:** `resolve_customization.py --skill {skill-root} --key workflow`.
2. **Load config:** `{project-root}/_bmad/config.yaml` (`eque2-code` section), resolving
   `{communication_language}` and `{TEST_CODE_DIR}`.
3. **Run shared pre-flight:** `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root}`
   (see `eque2-code-setup/references/pre-flight-checks.md`). This skill needs no Xray or
   Jira credentials — it reads local spec files — so a missing test directory is the only
   hard blocker.

**Dispatch detection:** if invoked by `[ET]` (Stage 6) or Grace's `[TV]` and config +
pre-flight already ran this turn, **skip steps 1–3** and start at the Flow below.

## Flow

### Step 1 — Resolve the target(s)
Classify the argument by the **Inputs** precedence (glob → folder → single file → no-arg).
Expand a folder/glob to the concrete list of `*.spec.ts` / `*.test.ts` files. If the list is
empty, report that and stop (offer the available test directory).

### Step 2 — Load the rubric
Read `references/validation-rubric.md`. Keep `references/constrained-spa-playbook.md` in
mind for any spec that legitimately drives an iframe/vendor SPA — bounded+documented
settles and documented `force` fallbacks there are `waived`, not failures.

### Step 3 — Score each spec
For each file, walk every rubric row in order. For each match record: `[severity] rule #N —
<one-line> — file:line`. Mark a finding `waived` when its line carries an inline
justification (`// flaky-ok: <reason>` or an equivalent documented reason). When one line
matches more than one rule, the **most-conservative** auto-fix verdict wins (a line a manual
rule would hold is never auto-fixed under a `yes` rule — see the rubric's precedence note).
Determine the per-test verdict:
- **compliant** — zero un-waived **blocker** findings (warnings may remain, listed).
- **non-compliant** — one or more un-waived **blocker** findings.

### Step 4 — Report (always)
- **Single file:** the verdict, then each finding with severity + line ref + the fix.
- **Folder/batch:** one block per spec, then a summary line — `N compliant · M
  non-compliant` — and the top recurring anti-patterns across the set.
Report-only and stop here when run **headless** or when the user later declines a fix.

### Step 5 — Offer auto-fix (report + offer; never silent)
If any finding is **auto-fix: yes** in the rubric, offer to apply those deterministic
rewrites under **explicit confirmation**. **auto-fix: manual** findings (real expected
values, isolation redesign, per-worker auth, locator-ladder rewrites) are listed with
guidance only — never auto-applied. On confirmation, apply the rewrites, then **re-score**
the affected files and report the new verdict. A test that cannot be made compliant
(only manual findings remain) is **surfaced, not forced green**.

## Output

- **Standalone (Grace `[TV]`):** the per-test report + the auto-fix offer; after any
  fixes, the re-scored verdict and a suggested next step (`[US]` to sync, or re-run a
  specific spec).
- **As a gate (dispatched by `[ET]`):** a structured verdict per validated spec —
  `compliant` / `non-compliant` with the blocker list. The caller (`[ET]` Stage 6) owns
  the proceed / fix-and-retry / surface decision within its ≤3-iteration budget. Remediate
  mechanically-fixable findings inline **only when `[ET]` passes an explicit
  fixes-confirmed signal**; otherwise return the findings and let the caller's fix loop
  apply them. Never assume confirmation was inherited.

## Failure modes

- **No test directory / no matching specs** → report it, show the resolved test
  directory, let the user re-choose (or, headless, log-and-exit).
- **A spec fails to parse** → report it as an un-scorable file and continue with the rest;
  never fabricate a verdict.
- **Pre-flight blocker (test dir missing)** → stop at pre-flight with the remediation.

## Success criteria

Every requested spec is scored against the bundled rubric; a per-test report (or a
structured verdict to the caller) is produced; mechanically-fixable findings are offered for
remediation under explicit confirmation (report-only when headless or declined); **no new
test is generated** and nothing is fixed silently.

## Dispatch

- **Grace (`[TV]`):** config + pre-flight ran this turn → start at Flow step 1. Render the
  full report and the auto-fix offer.
- **Linus (`[ET]`, Stage 6):** invoked as an internal gate after the fidelity gate. Config
  + pre-flight already ran this turn → start at step 1. Return the structured verdict;
  findings feed `[ET]`'s existing ≤3-iteration fix loop.
- **Standalone (`/eque2-code-test-validation <arg>`):** bootstrap runs. Greet briefly in
  `{communication_language}`, then step 1.
- **Headless (`--headless:validate-tests <file|folder|glob>`):** no prompts; argument
  required; report-only (no auto-fix); emit structured output (per-spec verdict + finding
  counts).
