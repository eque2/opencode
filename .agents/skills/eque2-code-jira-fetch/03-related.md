Language: {communication_language}
Output Location: {feature_artifacts}/{TICKET-KEY}/

# Stage 3: Related Tickets

**Progress: Stage 3 of 6** — Next: Figma Discovery

Fetch related tickets discovered in Stage 2. Subtasks and parent epic auto-fetch; blockers and linked issues are opt-in.

## Sequence

### 1. Auto-Fetch Subtasks

Fetch each subtask via Jira REST API. Save to `{feature_artifacts}/{subtask-key}/jira/ticket.json`. Per-ticket failure — **surface** as a warning, continue. Partial data is acceptable here.

### 2. Auto-Fetch Parent Epic

Fetch the parent epic with expanded fields. Save to `{feature_artifacts}/{epic-key}/jira/ticket.json`.

### 3. User Decision: Blockers

If blockers exist, prompt `[Y/N]`. On Yes: fetch each, save to its own folder.

### 4. User Decision: Linked Issues

If linked issues exist, prompt `[Y/N]`. On Yes: fetch each, save to its own folder.

### 4b. Fetch Attachments for Related Tickets

For every ticket fetched in this stage, also fetch its attachments into `{feature_artifacts}/{key}/jira/attachments/` — same rules as Stage 2 step 4b (basename only, size guard, warn-and-continue on failure).

### 5. Handle High Volume

If any category exceeds 20 tickets, **surface** the cost and offer: `[A]` All / `[L]` Limit to 20 / `[C]` Custom / `[S]` Skip.

### 6. Handle Partial Failures

Verdict-first summary: success/total per category. Non-critical failures do not block progression — continue with partial data and record the gap.

### 7. Save Related-Tickets Reference

Write `{feature_artifacts}/${TICKET_KEY}/jira/related-tickets.json` with `parent_epic`, `subtasks`, `blockers`, `linked_issues`, `fetch_metadata`.

### 7b. Parse for [CS] consumption

Run `jf-parse-related-tickets.py` to produce the structured summary [CS] Stage 2 reads. The script handles both the saved Stage-7 shape and raw Jira REST responses; the blocker-direction heuristic (inward `is blocked by` counts as blocker; outward `blocks` goes to `linked_issues`) is encoded once in the script rather than re-derived in prompts:

```
uv run scripts/jf-parse-related-tickets.py {feature_artifacts}/${TICKET_KEY}/jira/
```

The output is part of the JF artifact contract — downstream [CS] consumes it without re-parsing the raw JSON.

### 8. Update Progress State

Set `checkpoints.related_tickets = "complete"`. Recompute `.progress.json` checksum.

## Progression Condition

Auto-proceed to `04-figma-discovery.md`.
