Language: {communication_language}
Output Location: in-memory (writes to `{spec_file}` frontmatter)

# Stage 2 — Load and analyse core artifacts

**Progress: 2 of 10** — Next: Investigate codebase

**Produces:** in-memory context for Stage 3 (ticket details, planning-doc highlights, previous-feature intelligence, git intelligence). No new file written; `{spec_file}` `stepsCompleted` advances.

## Verdict First

Three intelligence sources merged into one in-memory context envelope:

1. **The requirement** — Jira ticket or user prose
2. **The planning docs** — PRD, architecture, UX, epics (via `discover-inputs.md`)
3. **The neighbourhood** — last 3 feature folders, last 5 commits

Exit with a context envelope dense enough that Stage 3 can dive straight into UPDATE-file analysis.

## Critical discipline

🔬 EXHAUSTIVE — do NOT skim. This stage's failure mode is "I'll figure it out from the ticket" → review-cycle disasters. Read everything that might be relevant.

## Sources

### Re-spec primer (when present)

If `{feature_root}/.re-spec-primer.md` exists, this run is downstream of an `[RS]` invocation. The primer carries forward context from the archived prior spec — prior verification intent, file touches, tech-stack confirmations, adversarial/edge-case findings that landed.

Load `.re-spec-primer.md` FIRST. The primer is a hint, not a substitute:

- Carry the prior verification intent into your current understanding, but reconcile it with the (possibly updated) Jira ticket — the ticket wins where they disagree.
- Carry prior file touches forward as a starting point for Stage 3's UPDATE-file analysis — but re-read the actual files; they may have drifted since the archive.
- Carry prior catches forward into your understanding of likely blind spots — but don't skip Party Mode / edge-case-hunter on this run because the primer mentions them; the new spec may have new failure modes.

After consuming the primer, rename it to `.re-spec-primer.applied.md` so a future re-spec doesn't double-apply it. (Don't delete it — the archive is durable; the renamed file is the audit trail.)

### Jira mode

Load:
- `{feature_root}/jira/ticket.md` — full body
- `{feature_root}/jira/ticket.json` — for structured fields not in ticket.md
- `{feature_root}/jira/related-tickets.json` — parent epic, blockers, linked issues, subtasks

Extract: user story, acceptance criteria, technical hints in comments, linked epic context, blocker context.

### Spec mode (interactive only)

Elicit from the user: problem statement, scope (in/out), verification intent. Same fields the ticket extraction produces — just sourced from conversation.

### Planning docs — via `discover-inputs.md`

Load planning docs via the FULL_LOAD / SELECTIVE_LOAD / INDEX_GUIDED protocol in `discover-inputs.md`. Input groups:

- `prd` — `{project-root}/docs/**/*prd*.md` and sharded `{project-root}/docs/**/prd/*.md`
- `architecture` — `{project-root}/docs/**/*architecture*.md` and sharded
- `ux` — `{project-root}/docs/**/*ux*.md` and sharded
- `epics` — `{project-root}/docs/**/*epic*.md` and sharded

Default strategy per group: SELECTIVE_LOAD (only what's relevant to this feature).

### Previous-feature intelligence

List `{feature_artifacts}/*/` directories sorted most-recent-first. For up to 3:

- Read `tasks.md` (file patterns, test approaches established)
- Read `context.md` (tech-stack confirmations, test directory)
- Note patterns the dev agent established that should propagate forward
- Note review/adversarial findings recorded in the spec — those are blind spots to watch for

### Git intelligence

```
git log --oneline -n 5
```

For each commit: which files were modified, what libraries added/removed, what conventions established.

## Output

In-memory context envelope, structured as:

```
{
  "requirement": {...},
  "planning": {"prd": "...", "architecture": "...", "ux": "...", "epics": "..."},
  "previous_features": [{...}, {...}, {...}],
  "git_recent": [{...}, ...],
}
```

Carry this forward to Stage 3. Do not write `context.md` yet — that's Stage 3.

Update `{spec_file}` frontmatter: `stepsCompleted: [1, 2]`.

## Exit

Stage complete when the context envelope is built. Advance to `03-investigate.md`.

## Interactive checkpoint

In `--interactive` mode only:

```
Stage 2 complete — artifacts loaded.
[a] Advanced Elicitation / [c] Continue / [p] Party Mode
```

Default mode auto-continues.
