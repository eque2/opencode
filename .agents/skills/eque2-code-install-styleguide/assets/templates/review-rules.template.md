<!-- TEMPLATE: review-rules.md -->
<!-- Purpose: Code review rules — includes anti-patterns for violation identification -->
<!-- Audience: AI code review (review-task workflow) -->
<!-- Line target: 400-800 lines -->
<!-- REQUIRED: Frontmatter with Tech/Source/Last Updated -->
<!-- REQUIRED: PR Review Comment Format section at the top -->
<!-- REQUIRED: Rule IDs for structured violation reporting -->
<!-- REQUIRED: Full "Why?" explanations (helps write informative review comments) -->
<!-- REQUIRED: Both correct and incorrect examples per rule -->
<!-- REQUIRED: Cross-reference linter rules — omit rules already enforced by project linters -->
<!-- Categories: Same categories as dev-standards.md for consistency -->

# {Tech} Review Rules

**Name:** {Tech}
**Source:** {official style guide URL}
**Last Updated:** {date}

> Rules already enforced by the project's linters ({list linters}) are not
> restated here.

## Review Comment Format

When reporting violations from this style guide, use this format:

```
**[{Rule-ID}: {Rule Name}]** {SEVERITY}
**Issue:** Brief description of what's wrong
**Why this matters:** Explanation from the style guide
**Suggested fix:**
  {corrected code}
**Reference:** {link to official guide section}
```

---

## Naming Conventions

### {Rule-ID}: {Brief Title}

**Reference:** {URL}
**Do:** {correct approach}
**Avoid:** {anti-pattern}
**Why?** {full explanation}

**(AVOID) Example:**
```{lang}
{anti-pattern code}
```

**Correct Example:**
```{lang}
{correct pattern code}
```

## File Structure

### {Rule-ID}: {Brief Title}

**Reference:** {URL}
**Do:** {correct approach}
**Avoid:** {anti-pattern}
**Why?** {full explanation}

**(AVOID) Example:**
```{lang}
{anti-pattern code}
```

**Correct Example:**
```{lang}
{correct pattern code}
```

## Components

### {Rule-ID}: {Brief Title}

**Reference:** {URL}
**Do:** {correct approach}
**Avoid:** {anti-pattern}
**Why?** {full explanation}

**(AVOID) Example:**
```{lang}
{anti-pattern code}
```

**Correct Example:**
```{lang}
{correct pattern code}
```

## Services

### {Rule-ID}: {Brief Title}

**Reference:** {URL}
**Do:** {correct approach}
**Avoid:** {anti-pattern}
**Why?** {full explanation}

**(AVOID) Example:**
```{lang}
{anti-pattern code}
```

**Correct Example:**
```{lang}
{correct pattern code}
```

## Templates

### {Rule-ID}: {Brief Title}

**Reference:** {URL}
**Do:** {correct approach}
**Avoid:** {anti-pattern}
**Why?** {full explanation}

**(AVOID) Example:**
```{lang}
{anti-pattern code}
```

**Correct Example:**
```{lang}
{correct pattern code}
```
