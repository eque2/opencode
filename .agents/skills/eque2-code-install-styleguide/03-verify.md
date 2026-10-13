Language: {communication_language}

# Stage 3: Verify Installation

## Rules

- FORBIDDEN to edit or regenerate files in this stage
- Report all findings including failures

## Sequence

### 1. Confirm Files Exist

```bash
ls -la docs/CLAUDE/code-standards/standards.md
ls -la docs/CLAUDE/code-standards/{detected_tech}.md
ls -la .github/review-rules/{detected_tech}.md
```

All three must exist and be non-empty.

Also check (optional — only if manifest listed a coding-standards file):
```bash
ls -la docs/CLAUDE/code-standards/{detected_tech}-company.md
```

### 2. Run Mechanical Checks

```bash
uv run scripts/is-verify-styleguide.py \
  --dev-standards docs/CLAUDE/code-standards/{detected_tech}.md \
  --review-rules .github/review-rules/{detected_tech}.md \
  -o .is-verify-results.json
```

If a coding-standards file was listed in the manifest, add:
```
  --coding-standards docs/CLAUDE/code-standards/{detected_tech}-company.md
```

Read `.is-verify-results.json`. For any file whose `"passed"` is `false`, surface each name in its `"failures"` array to the user with a brief explanation of what the check requires.

If `"status"` is `"failed"`, stop and report the failures — do not proceed to section 3.

### 3. Confirm Project Context & Git-Tracking

Standards tell the workflows *how* to write code; project context tells them *what the codebase is*. `[IS]` confirms both halves of that context are in place before handing back.

**3a. Confirm the context exists.** Either marker satisfies this: the `bmad-project-context` block in `AGENTS.md` (current), or a legacy `index.md` under the docs location (default `docs/index.md`; if the project documented into `{planning_artifacts}`, check there instead):

```bash
grep -l '<!-- bmad:context -->' AGENTS.md 2>/dev/null || ls -la docs/index.md 2>/dev/null
```

- **Present** → note it in the report and continue.
- **Missing** → this is a strong recommendation, never a hard stop. Surface the consequences and offer to launch the workflow:

  > 📄 You've got coding standards installed now — but I don't see any project context. The doc-dependent workflows ([CS], [DS], [RS], [BF], [ET]) reason far better with what this codebase cannot say for itself — policy, where things are, conventions that differ from defaults, known pitfalls. **I strongly recommend running `bmad-project-context`** — skipping it makes every later workflow slower (re-discovering the same ground each run), lower-quality (specs miss cross-cutting concerns and reference the wrong files), and less reliable on large or unconventional codebases. Want me to run it now?

  **Headless:** do not prompt — log the gap and the recommendation to the session, and continue. Never auto-run `bmad-project-context` unattended.

**3b. Ensure the docs are committable (Git-tracking).** Project documentation is only useful to the next session, teammate, and CI if it's committed — a `.gitignore` rule that excludes the docs path silently defeats it. Check whether the docs path (and the standards you just installed under `docs/CLAUDE/`) would be ignored:

```bash
git check-ignore -v docs/index.md docs/CLAUDE/code-standards/standards.md 2>/dev/null
```

- **No output** → nothing ignores them; they're committable. Continue.
- **A matching `.gitignore` rule is printed** → the docs are being excluded. Fix it so they're tracked: append a negation to the repo's root `.gitignore` (e.g. `!docs/` and `!docs/**`, or a more targeted un-ignore for the specific path the rule matched), preserving existing entries.

  - **Interactive:** show the offending rule and the proposed `.gitignore` edit, and confirm before writing.
  - **Headless:** apply the negation, and log both the offending rule and the fix.

  Do not force-add files or change tracking beyond the `.gitignore` edit — committing the context itself is the owner's (or `bmad-project-context`'s) step.

### 4. Judgement Checks

- [ ] Severity tags appropriately applied
- [ ] Rules properly categorised by concern
- [ ] No linter overlap
- [ ] Code examples syntactically correct
- [ ] Consistent formatting

### 5. Report Results

**All pass:** Show installed paths, line counts, all checks passed.

**If PR created (Step 2b path):** Show PR number/URL.

**Any fail:** Show installed paths, list each failed check with details.

**Always include the context status from section 3:** whether project context was found, the recommendation (and any offer to run `bmad-project-context`) if it was missing, and any `.gitignore` change made to keep it committable.

## Progression Condition

Workflow complete after report.
