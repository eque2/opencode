Language: {communication_language}
Output Location: {feature_artifacts}/{TICKET-KEY}/

# Stage 2: Fetch Main Ticket

**Progress: Stage 2 of 6** — Next: Related Tickets

Pull the ticket, write `ticket.json`, extract related-ticket keys for Stage 3.

## Sequence

### 1. Construct and Execute API Request

```
GET ${JIRA_URL}/rest/api/3/issue/${TICKET_KEY}?fields=*all&expand=renderedFields,names,schema,changelog
```

Basic Auth with `${JIRA_EMAIL}:${JIRA_API_TOKEN}`. Retry policy: 3 attempts, exponential backoff.

- 429 — **Retry** (rate limit).
- 5xx — **Retry** (server error).
- 401 / 403 — **Blocker** (auth, non-retryable). Abort.
- 404 — **Blocker** (ticket not found, non-retryable). Abort.

### 2. Pre-Fetch Size Check

If response will exceed >50 comments OR >20 subtasks OR >10MB, **surface** the cost and offer: `[Y]` Full / `[L]` Limited / `[N]` Cancel.

### 3. Validate Response

Confirm required fields (`key`, `fields`). Verify the returned `key` matches the request (security — reject mismatches). Confirm response size sane.

### 4. Save Raw JSON

Atomic write (temp file + rename) to `{feature_artifacts}/${TICKET_KEY}/jira/ticket.json`. Verify via file size > 0 and parse-back.

### 4b. Fetch Attachments

`fields.attachment` lists the ticket's attachments (images, PDFs, logs). For each entry:

- Download `attachment.content` with the same Basic Auth, following redirects (`curl -L`).
- Save to `{feature_artifacts}/${TICKET_KEY}/jira/attachments/<filename>`. Use the **basename only** of `attachment.filename` (security — reject path separators); on duplicate names, prefix with the attachment `id`.
- Verify each saved file size matches the metadata `size`.

Size guard: if the total metadata `size` exceeds 25MB, **surface** the cost and offer `[Y]` All / `[I]` Images only / `[S]` Skip. Per-file download failure — **surface** as a warning, record the gap, continue. No attachments — skip silently.

### 5. Discover Related Tickets

Extract from the response:
- **Subtasks:** `fields.subtasks`
- **Parent Epic:** `fields.parent` or `customfield_10014`
- **Blockers / Links:** `fields.issuelinks` — classify by `type.outward` / `type.inward`

Re-validate every discovered key against `^[A-Z]+-\d+$`. Drop anything that fails.

### 6. Discovery Summary

Verdict-first. Counts: subtasks, parent epic, blockers, linked issues.

### 7. Update Progress State

Set `checkpoints.main_ticket = "complete"`. Recompute `.progress.json` checksum.

## Progression Condition

Auto-proceed to `03-related.md`.
