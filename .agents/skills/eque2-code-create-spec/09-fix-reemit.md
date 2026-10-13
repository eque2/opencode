Language: {communication_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 9 — Apply fixes and re-emit

**Progress: 9 of 10** — Next: State generation and schema validation

**Produces:** materialised deferred fixes. Final pre-state mechanical pass.

## Verdict First

No-op in default mode when Stage 8's auto-invocations applied findings inline. This stage exists to materialise deferred fixes from interactive mode, do one final mechanical re-check, and gate Stage 10's expensive state generation.

## Apply deferred fixes

If interactive mode and any Stage 8 findings were deferred awaiting user confirmation, apply them now.

## Re-emit affected files

For any file modified after its initial write in Stages 3-7, bump `last_updated` in `metadata.json` (if present at this point — usually it isn't yet; created in Stage 10).

## Final mechanical readiness check

```
uv run scripts/cs-readiness-check.py {feature_root}
```

Halt if any check fails. Stage 10 must not run on a spec that doesn't pass readiness — state generation is expensive and committing the failure mode silently is the worst outcome.

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9]`.

## Exit

Stage complete when readiness check passes. Advance to `10-state-gen.md`.

## Failure modes

- **Blocker:** readiness check fails after Stage 8 supposedly passed it. Treat as a regression. Re-run Stage 8's mechanical loop from a clean state; if it fails again, surface to user.
