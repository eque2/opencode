# Error Messages

Reusable error message templates for jira-ticket-fetch workflow.

## Critical Errors (FAIL Workflow)

### Missing Environment Variables

```
CRITICAL: Environment variables not configured

Missing: {VARIABLE_NAMES}

Setup instructions:
1. Create .env file in project root
2. Add the following variables:
   JIRA_URL=https://eque2.atlassian.net
   JIRA_EMAIL=your.email@company.com
   JIRA_API_TOKEN=your_token_here

3. Get your API token: https://id.atlassian.com/manage-profile/security/api-tokens

Workflow cannot proceed without valid credentials.
```

### Invalid Jira MCP

```
CRITICAL: Jira MCP not available

The workflow requires Jira MCP for validation checks.

Installation:
  uvx mcp-atlassian

Configuration:
  Add to MCP config with environment variables:
  - JIRA_URL
  - JIRA_USERNAME
  - JIRA_API_TOKEN

Verify installation: Check for 'jira_get_issue' tool availability

Workflow cannot proceed without Jira MCP.
```

### Authentication Failed

```
CRITICAL: Jira authentication failed

Error: {ERROR_MESSAGE}

Common causes:
1. Invalid API token (check JIRA_API_TOKEN)
2. Expired token (regenerate at https://id.atlassian.com/manage-profile/security/api-tokens)
3. Wrong email (check JIRA_EMAIL matches Atlassian account)
4. Insufficient permissions (token needs 'Browse Projects' and 'View Issues')

Test authentication:
  curl -u "your.email@company.com:YOUR_TOKEN" \
    https://eque2.atlassian.net/rest/api/3/myself

Workflow cannot proceed without valid authentication.
```

### Ticket Not Found

```
CRITICAL: Jira ticket not found

Ticket key: {TICKET_KEY}
Error: {ERROR_MESSAGE}

Possible causes:
1. Ticket doesn't exist (check spelling: PROJ-123)
2. Ticket deleted or archived
3. No permission to view ticket
4. Wrong Jira instance (check JIRA_URL)

Workflow cannot proceed. Verify ticket key and try again.
```

## High Impact Errors (User Decision)

### Figma MCP Unavailable

```
Figma MCP not available

Found {COUNT} Figma link(s) in ticket, but Figma MCP is not installed.

Options:
  [R]etry - Check MCP again (if you just installed it)
  [S]kip  - Continue without Figma data
  [A]bort - Stop workflow

Installation (if needed):
  1. Add Figma MCP: claude mcp add figma https://mcp.figma.com/mcp --transport http
  2. Authenticate: Run /mcp in the CLI and follow prompts to sign in to Figma

What would you like to do? [R/S/A]
```

### Rate Limit Warning

```
High API usage detected

Found {COUNT} Figma links = {API_CALLS} API calls

Your Figma plan limits:
  Starter: 6 calls/month
  Professional: 10-15 calls/minute

This operation may exceed your rate limit.

Options:
  [Y] Continue anyway
  [N] Cancel operation
  [L] Limit to first {LIMIT} links

Continue? [Y/N/L]
```

## Medium Impact Errors (Continue with Warning)

### Related Ticket Fetch Failed

```
Could not fetch related ticket

Ticket: {TICKET_KEY}
Error: {ERROR_MESSAGE}

Possible causes:
- Ticket deleted
- No permission to view
- Network timeout

Continuing with partial data. Check summary report at end.
```

### Empty Figma Response

```
Figma file has no frames

URL: {FIGMA_URL}

The file exists but contains no design frames.
Saving empty design-context.json for reference.

Continuing with next link...
```

## Low Impact Warnings (Log Only)

### Large Ticket Detected

```
Large ticket detected: {SIZE}MB

Estimated fetch time: {ESTIMATE}

This is normal for tickets with:
- 50+ comments
- 20+ subtasks
- Extensive changelog

Continue? [Y/N]
```

### Unicode Fallback

```
Applied unicode fallback

Removed {COUNT} control characters from description.
Content preserved with unicode escaping.

Check ticket.md for details.
```

## Validation Errors

### Output Validation Failed

```
Output validation failed

File: {FILE_PATH}
Error: {VALIDATION_ERROR}

Expected: {EXPECTED}
Actual: {ACTUAL}

This indicates a workflow bug. Please report:
- Ticket key: {TICKET_KEY}
- Validation error above
- Check {FILE_PATH} for details

Workflow marked as incomplete.
```

### Symlink Detected

```
SECURITY: Symlink detected in output path

Path: {PATH}

For security, workflow cannot write to symlinked directories.

Resolution:
1. Remove symlink: rm {PATH}
2. Use real directory path
3. Re-run workflow

Workflow aborted for security.
```

## Recovery Messages

### Resume Detected

```
Incomplete fetch detected

Found progress file from previous run:
- Started: {START_TIME}
- Last checkpoint: {LAST_CHECKPOINT}
- Completed: {COMPLETED_OPERATIONS}

Options:
  [R]esume - Continue from last checkpoint
  [F]resh  - Start over (discards progress)

Choose: [R/F]
```

### Network Failure Recovery

```
Network failure detected

Saved progress to .progress.json
Completed: {COMPLETED_OPERATIONS}
Pending: {PENDING_OPERATIONS}

Run workflow again to resume from checkpoint.
```

## Success Messages

### Workflow Complete

```
{TICKET_KEY} fetched successfully

Output location: {OUTPUT_PATH}

Summary:
  Main ticket: Fetched
  Subtasks: {SUBTASK_COUNT}
  Parent epic: {EPIC_STATUS}
  Blockers: {BLOCKER_COUNT}
  Linked issues: {LINKED_COUNT}
  Figma designs: {FIGMA_COUNT}

Files created:
  - jira/ticket.json (complete data)
  - jira/ticket.md (human-readable)
  {ADDITIONAL_FILES}

Ready for create-spec workflow.
```
