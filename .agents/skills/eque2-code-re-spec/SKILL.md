---
name: eque2-code-re-spec
description: Re-opens an already-completed feature spec when requirements shift. Archives the prior artifacts, copies forward what's still relevant, hands off to [CS] with primed context.
---

# Re-Spec

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Verdict First

Reality changed. A feature you already spec'd needs a new spec. This workflow archives the old artifacts, copies forward the bits still worth keeping, and hands off to `[CS]` with the prior spec as warm context — not from scratch, but not stale either.

## When to Run This

The `[CS]` Stage 1 resume detector recommends `restart` when it finds a spec with `status: ready-for-build` for a feature the user is re-invoking. The user shouldn't have to manually archive folders and re-prime context — that's this workflow's job.

Use this when:

- Acceptance criteria on the Jira ticket changed materially after the spec shipped
- A dev pass revealed the spec missed a major dimension and re-spec is cleaner than patching
- The feature was reshaped (split, merged, renamed) and the existing spec no longer fits

Don't use this when:

- The spec is `in-progress` — use `[CS]` resume instead
- You want a small clarification on a finalised spec — use `[CS] --amend <FEATURE-ID>` instead. Amend mode appends an "Amendment N: {date}" section to the existing spec.md rather than archiving and starting fresh. Use amend when the change is additive and confined; use `[RS]` when the change is structural.

## Invocation

- Dispatch menu: `[RS] <FEATURE-ID>`
- Fast-invoke: `RS PROJ-123`
- Headless: not currently surfaced — re-spec implies new context that wants human attention

## Inputs

- `{FEATURE-ID}` — the feature key (existing spec must exist at `{feature_artifacts}/{FEATURE-ID}/`)
- Implicit: the prior `{feature_root}/spec.md`, `context.md`, `coverage.md`, `scenarios.gherkin`, `tasks.md`, `state/`

## What This Workflow Does

### 1. Confirm intent

Read `{feature_artifacts}/{FEATURE-ID}/spec.md` frontmatter. Surface:

```
{FEATURE-ID} — "{title}"
Current status: {status}
Last stepsCompleted: {stepsCompleted}
Created: {created}

This will archive the existing spec to {FEATURE-ID}.archived-{ISO-timestamp}/ and start a fresh spec with prior context carried forward.

Confirm? Y/N
```

**Confirmation rules — destructive default is gated:**

- **`status: ready-for-build`** (the destructive case): **always require explicit confirmation**, even in default mode. This is the typo-`RS`-for-`CS` footgun guard. Default mode prompts `Y/N`; without `Y` the workflow halts. The only way to skip is `--yes` flag passed explicitly to `RS` (signals scripted invocation that has already confirmed elsewhere).
- **`status: in-progress`** — halt with the message in Failure Modes below. `[RS]` is not for in-progress specs; use `[CS]` resume.
- **`--interactive` mode** — always prompt, regardless of status.

In default mode without `--yes`, if the user types anything other than `Y`/`y` (or sends EOF in cron contexts), halt with `{"status": "halted", "reason": "no_confirm"}` and do not touch any files.

### 2. Archive — atomic sequence

`[RS]` writes a `.re-spec-in-progress` marker into the parent directory BEFORE any destructive operation, so a crash mid-flight leaves a clear signal that the feature is in a transitional state and not safe to operate on.

Sequence — execute in this exact order:

1. Compute `{ARCHIVE-TIMESTAMP}` = current ISO-8601 timestamp.
2. Write `{feature_artifacts}/.re-spec-in-progress` containing JSON: `{"feature_id": "<KEY>", "started_at": "<ISO>", "archive_to": "<KEY>.archived-<TS>"}`.
3. Rename `{feature_artifacts}/{FEATURE-ID}/` to `{feature_artifacts}/{FEATURE-ID}.archived-{ARCHIVE-TIMESTAMP}/`.
4. Create the new `{feature_artifacts}/{FEATURE-ID}/` directory (per the dir-creation contract in step 3).
5. Write the primer.
6. Remove `{feature_artifacts}/.re-spec-in-progress`.

**Crash recovery:** if any subsequent activation finds `.re-spec-in-progress` present in `{feature_artifacts}/`, treat the named feature as in a failed re-spec state. Surface to the user: "Found in-progress re-spec for {KEY}. Inspect the archive at <path> and either rename it back manually or run `RS {KEY} --recover` to retry from clean state." Do not silently overwrite.

Archives are durable and human-inspectable. Do not delete anything — future-Linus may read them for cross-feature intelligence.

### 3. Re-prime context

**Directory creation contract:** `[RS]` creates the new `{feature_artifacts}/{FEATURE-ID}/` directory itself, before writing the primer. `[CS]` Stage 1 will see the directory already exists with `.re-spec-primer.md` inside and proceed without trying to re-create it. This is the explicit hand-off — do NOT wait for `[CS]` to create the dir; the primer needs a home.

Carry forward into the primer at `{feature_root}/.re-spec-primer.md`:

- **Prior verification intent** — copy from the archived `spec.md`
- **Prior file touches** — UPDATE/NEW table from the archived `context.md`
- **Tech-stack confirmations** — from the archived `context.md`
- **Adversarial/edge-case findings that landed** — from the archived `.catches.json`
- **What changed** — elicit from the user in interactive mode; in default mode, look for a `RS-NOTES.md` file at the feature root or in the Jira ticket comments since the original spec date

The primer is a hint to `[CS]` Stage 2 — it short-circuits redundant research while leaving Stage 3's UPDATE-file reads intact (the source files may have drifted; re-reading is non-optional).

### 4. Hand off to `[CS]`

Invoke the **`eque2-code-create-spec`** skill (via the Skill tool) with the activation context:

- `{FEATURE-ID}` = the same key
- `{input_mode}` = Jira (`jira/` was preserved; if it's stale, `[JF]` should be re-invoked first — surface this if the Jira ticket's `updated` timestamp is newer than the archive timestamp)
- Note: Stage 2 will see `.re-spec-primer.md` and incorporate it

### 5. Tag the new spec

In `{feature_root}/spec.md` frontmatter, add:

- `re_spec_of: "{FEATURE-ID}.archived-{ISO-timestamp}"`

So a future reader can find what came before.

## Output

Same as `[CS]` — a validated, executable build spec. The archived prior spec stays accessible for reference.

## Failure Modes

- **Blocker:** prior spec doesn't exist at `{feature_artifacts}/{FEATURE-ID}/`. Surface: "No spec found for {FEATURE-ID}. Did you mean to run `[CS]`?"
- **Blocker:** prior spec is `in-progress` rather than `ready-for-build`. Surface: "Spec is in-progress (last stage: {N}). Use `[CS]` to resume rather than re-spec." Halt.
- **Surface:** Jira ticket's `updated` timestamp is newer than archive timestamp. Recommend running `[JF] {KEY}` to refresh the ticket folder before re-spec'ing.

## On Activation

This skill runs directly (`/eque2-code-re-spec PROJ-123`) or dispatched by Linus. Unless the activation context already carries resolved config and a passing pre-flight (Linus just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}` and `{feature_artifacts}`.
3. Run shared pre-flight: `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root} --project-docs-glob '{workflow.project_docs_glob}'` (see `eque2-code-setup/references/pre-flight-checks.md`); halt on blockers. If `project_docs` is failing, apply the **Project Documentation Gate** — strongly recommend running `bmad-project-context` first and offer to launch it before re-speccing.

In `--interactive` mode: confirm intent, then run steps 2-5 above. In default mode: run all five.

After hand-off, this workflow exits — `[CS]` owns the rest.
