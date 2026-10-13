Language: {communication_language}

# Stage 2: Xray Definition Gate (the HARD STOP)

`[ET]` builds a test only when an Xray definition with **≥1 step** exists for the
change. **The gate algorithm lives in exactly one place** — the
`eque2-code-xray-conformance` skill (`[XC]`). This stage owns the `[ET]`-specific
context (feature-folder + `{ticket_key}` resolution, the Jira-mode precondition,
and the Stage-7 outcome recording); it **delegates** the fetch-fresh → `stepCount`
→ re-fetch-loop mechanics to that skill rather than restating them. The fetch
reuses the `xray-cli.ts` verbs; see `references/xray-fetch.md`.

## Sequence

### 1. Resolve the change's key (concrete recipe)

From the input (see SKILL.md Inputs), resolve the feature folder and `{ticket_key}` — do not improvise:

1. **Spec folder path given** → that is `{feature_root}`.
2. **Feature slug given** → `{feature_root} = {feature_artifacts}/{slug}`.
3. **Jira key given** → `{feature_root}` is the feature folder whose `jira/.metadata.json` (or spec frontmatter `ticket_key`) equals the key; if none exists, treat the key as `{ticket_key}` directly and skip folder-derived context.
4. **No arg** → pick the most recently modified feature folder under `{feature_artifacts}` that has a `state/` or completed `[DS]` marker; if more than one is plausible, ask (interactive) / fail with a clear reason (headless).

Read `{ticket_key}` from, in order: spec frontmatter `ticket_key` → `{feature_root}/jira/.metadata.json` → `{feature_root}/jira/ticket.json` `key`. It must match `^[A-Z][A-Z0-9_]*-\d+$`.

### 2. Precondition — Jira-sourced spec only

`[ET]` applies only to a Jira-sourced spec: `{feature_root}/jira/` present **and** a resolved `{ticket_key}` matching the regex.

- **Not Jira mode** (`ticket_key` null / no `jira/`) → no Xray definition to gate on. State it in one line and exit cleanly (Stage 7 skip, reason "non-Jira spec — nothing to gate on"). Write nothing. No developer-prompt fallback for the key.

### 3. Xray credentials present?

Confirm `XRAY_CLIENT_ID` + `XRAY_CLIENT_SECRET` (and `XRAY_BASE_URL` if non-default) are in `.env` — the fetch fails without them. If missing: **interactive** → tell the user the gate can't run and ask them to add the creds (then retry) or skip; **headless** → skip this test (Stage 7 skip, reason "Xray credentials missing"). Surface this *here*, before delegating.

### 4. Run the conformance gate (delegate to `[XC]`)

Invoke the **`eque2-code-xray-conformance`** skill on the single resolved `{ticket_key}` (the Skill tool — your persona and loaded config carry through; config + pre-flight already ran this turn, so the skill skips its own bootstrap). It performs the canonical algorithm: **fetch fresh** (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs sync`), **read `stepCount`** (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs test`), the automatic **folder-mismatch guard**, and — when zero steps remain — the bounded interactive `[r]/[s]/[c]` prompt (headless: skip-and-log). Do **not** re-implement any of that here.

Consume its verdict for `{ticket_key}`:

- **conformant** (`stepCount > 0`) → proceed to Stage 3 (`03-prepare.md`), carrying the fetched definition (read from `test-plans/{folderPath}/{ticket_key}.json`, which the skill's sync just refreshed).
- **non-conformant** (confirmed no definition, or the developer chose `[s]`) → fall to step 5.
- **cancelled** (`[c]`) → no test, no further stages; nothing recorded beyond the cancellation.

### 5. HARD STOP record

On a confirmed non-conformant verdict, record the `ABORT` (reason "no Xray definition" / "0 Xray step definitions in test plan") in the Stage 7 handoff artifact (see `06-verify.md` / `07-complete.md` — outcome recording is a handoff file, not a state-machine verb), then hand to Stage 7. Headless non-conformant is the same skip recorded in the Stage 7 handoff (reason "no Xray definition").

## Progression

conformant → `03-prepare.md`. Otherwise → Stage 7 (`07-complete.md`) on the skip/abort path.
