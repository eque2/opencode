#!/bin/bash
set -e

# Fetch Jira ticket information for one or more tickets
# Usage: fetch-jira-tickets.sh "TICKET1,TICKET2,..."
# Required environment variables:
#   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN

# Validate GITHUB_OUTPUT is set
if [ -z "$GITHUB_OUTPUT" ]; then
  echo "Error: GITHUB_OUTPUT environment variable is not set"
  exit 1
fi

# Validate required environment variables
if [ -z "$JIRA_BASE_URL" ] || [ -z "$JIRA_EMAIL" ] || [ -z "$JIRA_API_TOKEN" ]; then
  echo "Error: Required environment variables are not set"
  echo "Required: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN"
  exit 1
fi

TICKETS="${1}"
IFS=',' read -ra TICKET_ARRAY <<< "$TICKETS"

JIRA_INFO=""
HAS_ERROR=false

for TICKET in "${TICKET_ARRAY[@]}"; do
  echo "Fetching Jira ticket: $TICKET"

  # Fetch from Jira REST API
  RESPONSE=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$JIRA_BASE_URL/rest/api/3/issue/$TICKET?fields=summary,description,status,assignee" 2>&1)

  # Check if response is valid JSON and contains errors
  if [ -z "$RESPONSE" ]; then
    echo "Failed to fetch Jira ticket $TICKET: Empty response"
    HAS_ERROR=true
    printf -v JIRA_INFO '%s\n## Jira Ticket: %s\n\nError: Empty response from Jira API\n' "$JIRA_INFO" "$TICKET"
  elif echo "$RESPONSE" | jq -e . >/dev/null 2>&1; then
    # Valid JSON - check for error messages
    if echo "$RESPONSE" | jq -e '.errorMessages' >/dev/null 2>&1; then
      ERROR_MSG=$(echo "$RESPONSE" | jq -r '.errorMessages[0] // "Unknown error"' 2>/dev/null || echo "Failed to parse error")
      echo "Failed to fetch Jira ticket $TICKET: $ERROR_MSG"
      HAS_ERROR=true
      printf -v JIRA_INFO '%s\n## Jira Ticket: %s\n\nError: %s\n' "$JIRA_INFO" "$TICKET" "$ERROR_MSG"
    else
      # Extract fields
      SUMMARY=$(echo "$RESPONSE" | jq -r '.fields.summary // "N/A"' 2>/dev/null || echo "N/A")

      # Extract plain text from Atlassian Document Format (ADF)
      # ADF is a complex JSON structure - we need to extract text content only
      DESCRIPTION=$(echo "$RESPONSE" | jq -r '
        .fields.description // empty |
        if type == "object" then
          .. | .text? // empty
        elif type == "string" then
          .
        else
          empty
        end
      ' 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' || echo "No description")

      # Fallback to "No description" if empty
      if [ -z "$DESCRIPTION" ] || [ "$DESCRIPTION" = " " ]; then
        DESCRIPTION="No description"
      fi

      STATUS=$(echo "$RESPONSE" | jq -r '.fields.status.name // "Unknown"' 2>/dev/null || echo "Unknown")

      echo "summary=$SUMMARY" >> "$GITHUB_OUTPUT"
      echo "status=$STATUS" >> "$GITHUB_OUTPUT"

      printf -v JIRA_INFO '%s\n## Jira Ticket: %s\n\nSummary: %s\nStatus: %s\n\nDescription/Acceptance Criteria:\n%s\n' "$JIRA_INFO" "$TICKET" "$SUMMARY" "$STATUS" "$DESCRIPTION"
    fi
  else
    # Invalid JSON
    echo "Failed to fetch Jira ticket $TICKET: Invalid JSON response"
    HAS_ERROR=true
    printf -v JIRA_INFO '%s\n## Jira Ticket: %s\n\nError: Invalid JSON response: %s\n' "$JIRA_INFO" "$TICKET" "$RESPONSE"
  fi
done

if [ "$HAS_ERROR" = true ]; then
  echo "jira_error=true" >> "$GITHUB_OUTPUT"
fi

# Use dynamic delimiter to prevent command injection
DELIMITER="EOF_JIRA_$(date +%s%N)"
echo "jira_context<<$DELIMITER" >> "$GITHUB_OUTPUT"
printf '%s' "$JIRA_INFO" >> "$GITHUB_OUTPUT"
echo "" >> "$GITHUB_OUTPUT"
echo "$DELIMITER" >> "$GITHUB_OUTPUT"

# A failed fetch fails the step, so the Jira verification job cannot pass without its tickets.
if [ "$HAS_ERROR" = true ]; then
  echo "Error: one or more Jira tickets could not be fetched"
  exit 1
fi
