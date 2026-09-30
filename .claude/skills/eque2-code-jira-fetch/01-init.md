Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{TICKET-KEY}/

# Stage 1: Initialize & Validate

**Progress: Stage 1 of 6** — Next: Fetch Main Ticket

Verify credentials, MCP, filesystem, and resume state. Hand off to Stage 2 only when prerequisites are confirmed.

## Absolute Rules

- Never call `mcp__atlassian__*` as a workaround for missing env vars.
- Never substitute an alternative access method when env vars are missing.
- `JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_URL` missing — **Blocker. Abort.**

## Sequence

### 1. Welcome & State Intent

State what this workflow does: fetch Jira data (JSON + Markdown), chain to Figma fetch if links detected. Output lands at `{feature_artifacts}/{TICKET-KEY}/jira/`.

### 2. Prompt for Jira Ticket Key

Must match `^[A-Z]+-\d+$`. Max 3 attempts. Store as `TICKET_KEY`. After 3 invalid attempts — **Abort.**

### 3. Validate Environment Variables

**Required:** `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
**Optional:** `FIGMA_TOKEN` (Figma fetch consumes it later)

Verify format: token (base64 chars, length 24-64), email (valid form), URL (HTTPS, `*.atlassian.net`).

Failure — **Blocker.** Display setup instructions from `data/error-messages.md`. Abort.

### 4. Test Jira Authentication

```bash
curl -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" -H "Accept: application/json" "${JIRA_URL}/rest/api/3/myself"
```

Non-200 — **Blocker.** Display auth error from `data/error-messages.md`. Abort.

### 5. Confirm Jira MCP Availability

Verify `jira_get_issue` is present in available MCP tools. Missing — **Blocker.** Display MCP error. Abort.

### 6. Validate Filesystem

Write-test `{feature_artifacts}/{TICKET-KEY}/.test-write`. Confirm 100MB free. Reject path traversal.

### 7. Check for Resume

If `.progress.json` exists, prompt `[R]esume / [F]resh`. Honour the choice.

### 8. Create Output Folders

```bash
mkdir -p {feature_artifacts}/${TICKET_KEY}/jira
```

### 9. Initialize Lock + Progress State

Write `.lock` (PID, timestamp, UUID) and `.progress.json` (checkpoints, SHA-256 checksum).

### 10. Display Summary

Lead with verdict: prerequisites OK. List validated items. Auto-proceed.

## Progression Condition

Auto-proceed to `02-fetch-main.md`.
