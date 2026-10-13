Language: {communication_language}

# Stage 4: Report and Exit

## Rules

- Do NOT update state via MCP — `review-task` handles state for the parent task.
- Write findings to journal.
- Be honest — report exactly what was found, fixed, and remaining.
- Remaining structural discrepancies must be called out prominently.

## Sequence

### 1. Write journal entry

Create or append to `{spec_folder}/journal/figma-review.md`:

```markdown
---
timestamp: {ISO timestamp}
event: figma-compliance-review
task_id: {task_id}
---

## Figma Compliance Review — {task_id}

**Task:** {task_description}
**Figma source:** {figma_data_path}
**Viewport:** {artboardWidth}x{artboardHeight}
**Fix cycles completed:** {1 or 2}

### Screenshots

- **Figma design:** `{figmaScreenshotPath}`
- **Implementation (final):** `{implementationScreenshotPath}`

Visual match assessment: {qualitative note}

### Summary

| Metric | Structural (Layer 2) | Property (Layer 3) | Total |
|--------|---------------------|-------------------|-------|
| Found | {count} | {count} | {count} |
| Fixed | {count} | {count} | {count} |
| Remaining | {count} | {count} | {count} |

Tokens created: {count} | Tokens reused: {count}

### Structural Verification Results (Layer 2)

{Bounding box, containment, sibling order, child count checks}

### Discrepancies Fixed

{Structural and property fixes with details}

### Remaining Issues

{Remaining items with reasons why they couldn't be fixed}

### Tokens Created

{token_name: value in file_path}

### Files Modified

{list}
```

### 2. Determine exit status

- All fixed OR only minor property discrepancies remain: `FIGMA_REVIEW_COMPLETE`
- Structural discrepancies remain: `FIGMA_REVIEW_COMPLETE -- WARNING: {n} structural discrepancy(ies) remain unfixed`
- Critical failure: `FIGMA_REVIEW_FAILED: {reason}`

### 3. Output exit status

Output the exact status string. Workflow complete — return to `review-task`.
