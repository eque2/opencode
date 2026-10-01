Language: {communication_language}

# Stage 1: Detect Technology Stack

## Rules

- FORBIDDEN to install or generate any files in this stage
- FORBIDDEN to skip the user checkpoint **in interactive mode**
- In headless mode (`--headless` / `-H`): auto-select `[C] Continue` at the checkpoint — do NOT halt for user input

## Sequence

### 1. Check Prerequisites

```bash
gh auth status
```

If `gh` not available or not authenticated: error and STOP.

### 2. Detect Technology Stack (Local)

Run the detection script from the workflow's `scripts/` directory:

```bash
uv run scripts/is-detect-stack.py {project-root} -o .is-stack-detection.json
```

Then read `.is-stack-detection.json`. The fields `tech`, `version`, `linters`, and `guides_installed` carry all information needed for subsequent steps — no manual file-checking is required.

### 3. Fetch Central Manifest (Remote)

```bash
gh api repos/eque2/eque2-code/contents/styleguides/manifest.yaml --jq '.content' | base64 -d
```

If 404: no manifest yet (normal for first use), set `manifest_has_tech = false`.
If timeout/auth error: check repo reachability with `gh repo view eque2/eque2-code --json name`.

### 4. Check Already-Installed Guides

If `docs/CLAUDE/code-standards/standards.md` exists: offer `[R]` Reinstall / `[X]` Exit.

### 5. Present Consolidated Findings

Show: detected tech/version, framework config, existing linters, existing style guides, central repo status, manifest match.

### 6. User Checkpoint

**If match in manifest:**
```
[C] Continue — install from central repository
[O] Other — specify different technology
```

**If NOT in manifest:**
```
[C] Continue — generate from scratch
[O] Other — specify different technology
```

**Headless mode:** auto-select `[C] Continue` silently. Do not halt.

**Interactive mode:** HALT and wait for user selection.

### 7. Branch to Next Stage

- Manifest match: proceed to `02a-install.md`
- No match: proceed to `02b-generate.md`

## Progression Condition

Proceed when user selects [C] Continue. Branch based on manifest availability.
