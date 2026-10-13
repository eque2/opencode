Language: {communication_language}
Output Language: {document_output_language}

# Stage 2b: Generate from Scratch

## Rules

- Research FIRST, generate second — never generate without researching
- FORBIDDEN to include anti-patterns in dev-standards.md
- FORBIDDEN to omit PR Review Comment Format from review-rules.md
- FORBIDDEN to restate rules already enforced by project linters
- FORBIDDEN to read target project source files, components, or business-domain code for rule content — official documentation only
- FORBIDDEN to name project-specific libraries, state managers, UI kits, or routers as canonical choices (e.g. do NOT write "this project uses X" or mandate a specific library by name)

## Sequence

### 1. Load Templates

Read `assets/templates/dev-standards.template.md` and `assets/templates/review-rules.template.md`. Understand required structure before researching.

### 2. Research Official Style Guide

Web search:
- `"{detected_tech} official style guide"`
- `"{detected_tech} coding conventions best practices"`
- `"{detected_tech} {detected_version} style guide"`

Prefer official docs (angular.dev, react.dev, go.dev). Avoid blog posts, opinion pieces.

### 3. Extract and Categorise Rules

From research: extract all rules, categorise by concern, assign severity (`[CRITICAL]`, `[IMPORTANT]`, `[RECOMMENDED]`), assign rule IDs.

### 4. Cross-Reference with Project Linters

Review `{linter_configs}` from Stage 1. Use linter configs ONLY to identify rules already enforced — omit those from the generated files. Do NOT use linter configs as a source of rule content or to infer library/framework choices.

### 5. Create Directories and Generate Files

```bash
mkdir -p docs/CLAUDE/code-standards/
mkdir -p .github/review-rules/
```

**dev-standards.md** (200-400 lines): Positive patterns ONLY. No anti-patterns. No PR comment format.

**review-rules.md** (400-800 lines): Both correct AND incorrect examples. PR Review Comment Format section at top (REQUIRED).

### 6. Contribute Back to Central Repository

If `central_repo_reachable = true`:
1. Clone/find `eque2/eque2-code` as sibling
2. Create branch `feat/styleguide-{detected_tech}`
3. Copy files to `styleguides/{detected_tech}/`
4. Update/create `styleguides/manifest.yaml`
5. Commit and create PR via `gh pr create`
6. Return to original directory

If unreachable: report and skip.

### 7. Auto-Proceed

"Generation complete. Proceeding to verification..."

## Progression Condition

Auto-proceed to `03-verify.md`.
