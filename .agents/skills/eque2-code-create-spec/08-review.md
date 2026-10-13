Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 8 — Review and validate readiness

**Progress: 8 of 10** — Next: Apply fixes and re-emit

**Produces:** spec validated against Ready-for-Build standard. Findings applied. `{spec_file}` `stepsCompleted` advances.

## Verdict First

Mechanical validation against the 8 Ready-for-Build criteria, plus two judgment-driven review passes. Failures from this stage gate Stage 9 / Stage 10.

## Mechanical readiness check — delegate to script

```
uv run scripts/cs-readiness-check.py {feature_root}
```

Returns JSON: `{status: "ok"|"failed", checks: [...], failures: [...]}`. The script runs the 8 criteria below mechanically — no LLM tokens spent re-checking trivia.

| # | Criterion | Mechanical check |
|---|---|---|
| 1 | **Scenarios First** | `scenarios.gherkin` exists; mtime / stepsCompleted history shows it was written before `tasks.md` |
| 2 | **Tasks Support Scenarios** | Every task has `Supports:` field; every referenced scenario ID exists in `scenarios.gherkin` |
| 3 | **Testable** | Every task has `Tests:` field with file + pattern |
| 4 | **Actionable** | Every task has File path + action verb |
| 5 | **Logical** | Phase IDs are sequential strings; within-phase ordering documented |
| 6 | **Complete** | No "TBD", no `{...}` placeholders, no empty sections |
| 7 | **Self-Contained** | Every reference resolves (file paths, scenario IDs, task IDs) |
| 8 | **Verifiable** | BUILD-1..4 present; BUILD-5 present iff Figma referenced |

If the script reports failures: read each failure, fix the affected file, re-run the script. Cap at 3 fix-and-re-run iterations.

## Auto-invocation — Adversarial Review (default mode)

Suppressed when `--no-adversarial`, `--yolo`, or `--interactive`.

```
SKILL: bmad-review (lenses=adversarial)
PROMPT: Cynical/red-team review of the full spec for feature {FEATURE-ID}:
        spec.md, context.md, coverage.md, scenarios.gherkin, tasks.md. Attack
        the assumptions, find the gaps a hostile reviewer would find. Findings
        auto-applied.
RETURN FORMAT: critical / enhancement / nice-to-have triage, one bullet per
        finding, each with affected file and recommended fix. Cap response at
        2000 tokens.
```

On findings:

- **Apply ALL findings** — critical, enhancement, and nice-to-have. No triage-based dropping. If a finding is genuinely orthogonal and requires separate work (a distinct CAP, ticket, or workstream), **HALT and ask the user** whether to carve it out; only proceed once the user has explicitly approved. Silent deferral is prohibited.
- Re-run `cs-readiness-check.py`.
- Re-emit affected files. Append summary to session log.

## Auto-invocation — Fresh-context Checklist (default mode)

Suppressed when `--no-checklist`, `--yolo`, or `--interactive`.

```
SKILL: load `./checklist.md` in a fresh context
PROMPT: Apply as Ready-for-Build validator to feature {FEATURE-ID}'s spec.
        Findings auto-applied.
RETURN FORMAT: list of misses with severity (critical/enhancement/optimization).
```

On findings:

- Apply each miss as a fix to the affected file
- Re-run `cs-readiness-check.py`

## Catches surfaced

If adversarial-general or checklist applied fixes, record via `cs-append-catches.py`. One invocation per skill (so adversarial-general and checklist are two separate entries).

```
uv run scripts/cs-append-catches.py {feature_root} --skill bmad-review --stage 8 --entry '{"applied": [{"file": "...", "severity": "...", "summary": "..."}], "rationale": "<one-line per applied fix>"}'

uv run scripts/cs-append-catches.py {feature_root} --skill fresh-context-checklist --stage 8 --entry '{"applied": [{"file": "...", "severity": "...", "summary": "..."}], "rationale": "<one-line per applied fix>"}'
```

See `references/catches-schema.md` for the entry shape. Skip when nothing was applied.

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]`.

## Exit

Stage complete when `cs-readiness-check.py` returns `status: ok` and (default mode) the two auto-invocations have run and their fixes applied. Advance to `09-fix-reemit.md`.

## Interactive checkpoint

```
Stage 8 complete — spec validated against Ready-for-Build standard.
[a] Advanced Elicitation / [r] Adversarial Review / [e] Edge-case Hunter / [c] Continue / [p] Party Mode
```

Default mode auto-continues.

## Failure modes

- **Blocker:** `cs-readiness-check.py` fails 3 iterations in a row. Surface the unresolved criterion with structured JSON. Workflow halts.
- **Retry candidate:** adversarial-general or checklist times out. Kill, log as skipped, continue — the mechanical check is the authoritative gate.
- **Surface:** adversarial findings introduce scope that should have been Stage 2 (e.g. "you missed a whole user role"). Apply, re-run from earlier stage if needed.
