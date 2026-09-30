Language: {communication_language}
Output Language: {document_output_language}
Output Location: appended to `{feature_artifacts}/{FEATURE-ID}/context.md`

# Stage 4 — Web research

**Progress: 4 of 10** — Next: Coverage Model

**Produces:** "Web Research" section appended to `context.md`.

## Verdict First

Prevent outdated implementations. For each version-sensitive dependency identified in Stage 3, confirm the latest stable version, breaking changes since the version in `package.json`, and any security patches that affect the feature.

## Targets

From `{context_file}`, identify libraries / frameworks / APIs that are version-sensitive — anything with a release cadence faster than annual, or anything in the architecture's "watch list".

## Per-target research

For each:

- Latest stable version
- Breaking changes since the version in `package.json`
- Security vulnerabilities or required patches
- Performance improvements or deprecations
- Best practices for the current version

Use web search. Cite sources. If a source can't be reached, surface that as a finding for the spec rather than guessing.

## Output

Append to `{context_file}` under a "Web Research" section. For each target:

```
- **Library:** <name>
- **Current project version:** <from package.json>
- **Latest stable:** <version>
- **Breaking changes:** <bullets, or "none">
- **Security:** <any CVEs or required patches>
- **Recommended pin:** <version to use in this feature>
- **Sources:** <URLs>
```

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3, 4]`.

## Exit

Stage complete when the Web Research section is appended. Advance to `05-coverage-model.md`.

## Interactive checkpoint

```
Stage 4 complete — web research folded into context.
[a] Advanced Elicitation / [c] Continue / [p] Party Mode
```

Default mode auto-continues.

## Failure modes

- **Surface:** a target has unreachable docs / sources. Surface as a finding ("library X's docs are unreachable; using package.json version as authoritative") rather than fabricating recommendations.
