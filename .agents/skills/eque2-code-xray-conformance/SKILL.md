---
name: eque2-code-xray-conformance
description: Run the Xray step-conformance review for a single Xray test ID or a folder — fetch the definition fresh, read its stepCount, and report conformant (≥1 step) or non-conformant. Generates no test. Use when the user selects [XC], says 'check conformance', 'is this conformant?', 'check the definitions', or 'are these step-backed?'.
---

# Xray Conformance Review

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Answer one question, honestly and freshly: **does an Xray definition with at least
one step exist for this test?** This is the **step-conformance gate** — the same
check that refuses to build an E2E test when no real definition backs it — exposed
as a standalone, read-and-report step.

This skill is the **canonical implementation** of that gate. Grace runs it directly
as `[XC]`; Linus's `[ET]` (`eque2-code-e2e-test`) invokes it as its pre-generation
gate instead of restating the algorithm. The rule lives in exactly one place: here.

**It generates nothing.** It never writes or scaffolds `*.spec.ts`, never builds a
test, never touches the test suite. It fetches, reads `stepCount`, and reports.

**Hard rule — no direct Xray API calls, ever.** All Xray access goes through
the `xray-cli.ts` verb surface (`sync`, `test`, `tests`, `folders` — i.e.
`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb> [--flag=value ...]`). No bespoke scripts beyond
this CLI, no direct API calls from prompts.

## Inputs

The argument (`XC <arg>` / `--headless:check-conformance <arg>`) identifies the target:

1. **Strip a leading `@`** if present (`XC @PROJ-123` and `XC PROJ-123` route identically).
2. **Classify the remaining string:**
   - Matches `^[A-Z][A-Z0-9_]*-\d+$` → **single Xray test ID** (e.g. `PROJ-123`, `CMC-12345`). Xray tests are Jira issues, so they share the key shape.
   - Otherwise → **Xray folder** (path or name, e.g. `Releases/2026.1`). When ambiguous, resolve against `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` and confirm rather than guessing.
3. **No arg** → interactive folder picker via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders`; headless with no arg is a hard error (never guess a folder).

From `.env` (established by `[SU]`): `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET`
(and `XRAY_BASE_URL` if non-default), plus the project's `XRAY_OUTPUT_DIR` /
`XRAY_TEST_FOLDER` where relevant.

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-xray-conformance <id|folder>`)
or dispatched by Grace or Linus. Unless the activation context already carries
resolved config and a passing pre-flight (the dispatching agent just ran them this turn):

1. **Resolve customisation:** `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. **Load config:** `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}`.
3. **Run shared pre-flight:** `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root}`. This skill needs **Xray credentials** and a **working xray CLI** — confirm `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs --help` resolves and runs successfully; either missing is a blocker. Point the user at `[SU]` (credentials) or `/eque2-code-setup` (CLI install) and stop. Surface this *here*, before any fetch.

## Flow — the canonical gate algorithm

The definition is **always fetched fresh** via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs sync` —
never read from an assumed cached `test-plans/*.json`. The cached JSON is an
*output* of the fetch.

### 1. Resolve the target

Classify the argument (see Inputs) into **single ID** or **folder**.

### 2. Fetch fresh

Refresh the relevant Xray folder so the local copy is current:

```
node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs sync --folderId=<folder> --conflictPolicy=merge
```

- **Folder mode** → sync the named folder.
- **Single-ID mode** → sync the folder the ID belongs to (use `{XRAY_TEST_FOLDER}` if known; otherwise resolve via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs tests --testIds=<id>` → `folderPath`, then sync that folder).

### 3. Read stepCount

```
node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs test --testId=<id>   → read stepCount
```

- **Single-ID mode** → one read for the ID.
- **Folder mode** → read each test in the synced folder.

### 4. Folder-mismatch guard (single automatic retry, single-ID mode)

If a single ID reads `stepCount == 0` or isn't found in the synced folder, guard
against a false negative from a folder mismatch:

```
node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs tests --testIds=<id>
```

If it reports the key under a **different** `folderPath`, `sync` *that* folder
once and re-read `test`. This is a **bounded, automatic single retry** — not
the interactive loop. If the key is genuinely absent or still has zero steps, fall
to the verdict.

### 5. Verdict

For each evaluated test:

- **`stepCount > 0`** → **conformant**. Record the stepCount.
- **`stepCount == 0`** (after the guard) → **non-conformant**:
  - **Headless** → record the skip with reason `"no Xray definition"` and continue (folder mode: move to the next test). No halt.
  - **Interactive** → prompt (modelled on build-test's preconditions HALT):

    > "No Xray definition (≥1 step) found for `{id}`. Does one exist in Jira?
    >  [r] re-fetch from Xray and re-check (you may have just authored it)
    >  [s] skip this test and move on
    >  [c] cancel"

    - `[r]` → re-run steps 2–3. **Bounded: at most 2 manual re-fetches**; after the second `[r]` with still-zero steps, treat it as a confirmed no-definition (non-conformant) rather than looping forever.
    - `[s]` → record non-conformant (skipped), move on.
    - `[c]` → cancel; report what was evaluated so far and stop.

### 6. Report — never generate

- **Single-ID mode** → one line: `{id}` → **conformant** (`stepCount` N) / **non-conformant** (no definition).
- **Folder mode** → a per-test line for every test in the folder, plus summary counts: **conformant / non-conformant / absent**.

This skill **never** generates a test, scaffolds a `*.spec.ts`, or writes to the
test suite. Its only output is the conformance report (and, when dispatched as a
gate, the conformant/non-conformant verdict its caller consumes).

## Output

- **Standalone:** the conformance report above, ending with suggested next steps —
  `[BT] <id>` to build a conformant test, fix-in-Xray for any non-conformant
  definition.
- **As a gate (invoked by `[ET]`):** the conformant/non-conformant verdict for the
  single resolved `{ticket_key}`. The caller owns its own proceed/skip/abort and
  outcome recording.

## Failure modes

- **No Xray credentials / xray CLI not resolving** → stop at pre-flight with the pointer above; never improvise an API call.
- **Folder not found / empty** → say so, show available folders (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders`), let the user re-choose. An empty folder is a clean no-op, not an error.
- **Sync fails mid-run** → report what synced and what did not; safe to re-run (sync refreshes in place).

## Success criteria

The conformance of the requested ID (or every test in the requested folder) has
been determined from a **freshly fetched** definition, reported to the user (or
returned as a verdict to the caller), and **no test was generated.**

## Dispatch

- **Dispatched by Grace (`[XC]`) or Linus (`[ET]`):** config + pre-flight ran this turn — start at the flow's step 1. As a gate, return the verdict; standalone, render the report.
- **Standalone:** the bootstrap above ran. Greet `{user_name}` briefly in `{communication_language}`, then start at step 1.
- **Headless** (`--headless:check-conformance <id|folder>`): no prompts; argument required; non-conformant tests are skipped-and-logged; emit the report as structured output.
