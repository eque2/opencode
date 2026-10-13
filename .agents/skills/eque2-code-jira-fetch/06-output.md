Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{TICKET-KEY}/

# Stage 6: Output Generation & Complete

**Progress: Stage 6 of 6** — Final Stage

Render the ticket markdown, validate every output, release the lock, hand control back.

## Sequence

### 1. Load Ticket Data

Read `jira/ticket.json` and `.progress.json`. Pull `JIRA_URL` from progress state.

### 2. Load Markdown Template

Load `assets/templates/ticket-markdown.template.md`.

### 3. Prepare Variables

Extract: key, summary, status, type, priority, assignee, reporter, dates, description (handle ADF), acceptance criteria, custom fields. Apply markdown escaping.

### 4. Extract Related Tickets

Format from sibling folders: parent epic, subtasks, blockers, linked issues. Include Jira links and relative paths to fetched data.

### 4b. Extract Attachments

List files in `jira/attachments/` for `{{attachments}}`: filename, size, relative path (use markdown image syntax for images). Empty or absent folder — "None".

### 5. Extract Figma Information

If `figma/` exists (Stage 5 ran), format the design block from those artifacts.

### 6. Populate Template and Save

Replace every `{{placeholder}}`. Atomic write to `jira/ticket.md`.

### 7. Generate Metadata

Write `.metadata.json`: workflow version, API version, fetch date, ticket key, Figma stats.

### 8. Validate All Outputs

Confirm expected files exist. Confirm every JSON is parseable. Confirm markdown structure is intact. Confirm file sizes are sane. Any failure here — **surface and halt**; do not mark complete on broken output.

### 9. Cleanup

Remove `.lock`. Mark `.progress.json` complete.

### 10. Completion Summary

Verdict-first. Ticket key, output path, fetch stats (subtasks, epic, blockers, linked, attachments, Figma).

### 11. Offer Figma Chain

If `figma.com/` or `fig.ma/` appears in the ticket and Figma was not fetched:
```
[F] Fetch Figma designs — run Figma fetch workflow
[S] Skip — continue without Figma data
```

### 12. Hand Off

```
{TICKET-KEY} — Jira fetch complete

Next commands:
  [FF] Fetch Figma designs
  [CB] Create feature branch
  [CS] Create feature specification
```

## Progression Condition

Workflow complete. User routes to the next command.
