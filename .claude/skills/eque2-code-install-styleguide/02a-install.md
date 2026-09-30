Language: {communication_language}

# Stage 2a: Install from Central Repository

## Rules

- FORBIDDEN to modify fetched content
- No user interaction needed — fully autonomous

## Sequence

### 1. Create Target Directories

```bash
mkdir -p docs/CLAUDE/code-standards/
mkdir -p .github/review-rules/
```

### 2. Fetch standards.md (tech-agnostic, always installed)

```bash
gh api repos/eque2/eque2-code/contents/styleguides/standards.md \
  --jq '.content' | base64 -d > docs/CLAUDE/code-standards/standards.md
```

If fetch fails: report error and halt.

### 3. Fetch dev-standards.md

```bash
gh api repos/eque2/eque2-code/contents/styleguides/{detected_tech}/dev-standards.md \
  --jq '.content' | base64 -d > docs/CLAUDE/code-standards/{detected_tech}.md
```

If fetch fails: report error and halt.

### 4. Fetch review-rules.md

```bash
gh api repos/eque2/eque2-code/contents/styleguides/{detected_tech}/review-rules.md \
  --jq '.content' | base64 -d > .github/review-rules/{detected_tech}.md
```

If fetch fails: report error and halt.

### 5. Fetch coding-standards.md (company-bespoke, optional)

Check manifest: if `coding-standards` is non-null for `{detected_tech}`:

```bash
gh api repos/eque2/eque2-code/contents/styleguides/{detected_tech}/coding-standards.md \
  --jq '.content' | base64 -d > docs/CLAUDE/code-standards/{detected_tech}-company.md
```

If fetch returns 404 or manifest entry is null: skip silently (file not yet authored).
If fetch fails for any other reason: warn but continue.

### 6. Auto-Proceed

"Installation complete. Proceeding to verification..."

## Progression Condition

Auto-proceed to `03-verify.md`.
