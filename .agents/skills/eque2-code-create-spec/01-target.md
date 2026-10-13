Language: {communication_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 1 — Determine target feature

**Progress: 1 of 10** — Next: Load and analyse artifacts

**Produces:** initialised `{feature_root}/spec.md` (frontmatter only), resume detection.

## Verdict First

This stage decides three things and exits:
- **What feature ID** are we spec'ing?
- **What mode** (Jira input vs spec input)?
- **Resume or restart** if work already exists?

## Resolve `{FEATURE-ID}`

Run `cs-detect-resume.py` (see `scripts/`) — it scans `{feature_artifacts}/`, parses any existing `spec.md` frontmatters, and recommends a target. Inputs:

```
uv run scripts/cs-detect-resume.py {feature_artifacts} [<TICKET-KEY-or-slug>]
```

Returns JSON: `{recommendation: "resume"|"restart"|"new", feature_id, ticket_key, stepsCompleted}`.

If the user fast-invoked with an arg, classify it per `references/workflow-dispatch.md` ("Fast-Invoke Arg Disambiguation"):

- **Jira key** (matches `^[A-Z][A-Z0-9_]*-\d+$`) — pass `<KEY>` as the second arg to `cs-detect-resume.py`. Set `{ticket_key} = <KEY>`. Proceed in Jira mode.
- **File path** (anything else, optionally prefixed with `@`) — strip the leading `@` if present, resolve the path, read its contents as the prose brief. Synthesise `{FEATURE-ID}` from the file basename (slugified) or accept an explicit `--feature-id` flag. Pass the synthesised ID to `cs-detect-resume.py`. Set `{prose_input} = <file contents>`. Proceed in Spec mode.

If no arg was supplied, pass nothing and let the script decide (single-jira-folder auto-detect or empty list → ask the user in interactive mode, exit `unresolved` in default mode).

## Act on the recommendation

- **`new`** — create `{feature_root}/`, initialise `spec.md` from `template.md` with `stepsCompleted: [1]`, advance to Stage 2.
- **`resume`** — read the existing `stepsCompleted` and jump straight to `max(stepsCompleted) + 1`'s stage file. Do not re-emit Stages already complete.
- **`restart`** — only in interactive mode after explicit user choice. Archive existing folder to `{FEATURE-ID}.archived-{timestamp}/`, then proceed as `new`.

## Set mode

- **Jira mode** — `{feature_root}/jira/` exists (output of [JF]), or fast-invoked with a Jira key. Set `{ticket_key} = {FEATURE-ID}`. Default when a ticket is available.
- **Spec mode** — no `jira/` folder; user supplies prose. Runs headless or interactive equally:
  - **Fast-invoke with a file path** (`CS @brief.md` / `CS brief.md`) — read the file as the prose brief; treat its content as the problem statement, scope, and verification intent already captured. No further elicitation.
  - **Interactive entry with no arg** — elicit problem statement, scope, verification intent conversationally, then proceed.

## Detect ticket type (Jira mode only)

If in Jira mode and `{feature_root}/jira/ticket.json` exists, read `issuetype.name` from that file:

- **Bug / Defect / Hotfix** → set `{ticket_type} = bug`. This activates bug-fix mode: Stage 5 uses root-cause + regression coverage instead of BUILD/UX/PERF; Stage 4 skips Figma discovery.
- **Feature / Story / Task / Epic** or any other value → set `{ticket_type} = feature`. Standard pipeline.

If no `jira/ticket.json` exists (Spec mode), set `{ticket_type} = feature`.

## Frontmatter on init

Initialise `{spec_file}` from `template.md` with:

- `title` — feature title (placeholder, refined in Stage 2)
- `specSlug: {FEATURE-ID}`
- `ticketType: {ticket_type}`
- `stepsCompleted: [1]`
- `coverage_validated: false`
- `edge_cases_researched: false`
- `status: in-progress`

## Exit

Stage complete when `{spec_file}` exists with frontmatter and `{FEATURE-ID}` is resolved. Advance to `02-load-artifacts.md`.

## Failure modes

- **Blocker:** ambiguous `{FEATURE-ID}` (multiple candidates, none specified) in headless mode → exit with structured JSON `{"status": "failed", "stage": "target", "reason": "ambiguous_feature_id"}`.
- **Blocker:** user fast-invoked with key but `{feature_root}/jira/` missing — depends on context. If [JF] hasn't run yet, advise the user to run `[JF] <KEY>` first; in headless `:create-spec` mode, chain into [JF] automatically.
