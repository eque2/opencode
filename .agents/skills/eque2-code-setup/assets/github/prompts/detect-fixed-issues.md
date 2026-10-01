You are analyzing PR #{PR_NUMBER} to detect which existing review comments have been fixed.

**YOUR ONLY JOB:** Analyze existing review comments and determine which issues have been fixed in the current code.

**OUTPUT FORMAT:** You MUST create a file called `fixed-issues.json` with this exact structure:

```json
{
  "fixed": [
    {
      "comment_id": 2515905629,
      "thread_id": "PRRT_kwDOP7eHYM5hkG4c",
      "file": "src/app/test_violation.component.ts",
      "line": 4,
      "issue": "Component selector uses camelCase",
      "resolution": "Selector changed to kebab-case (app-test-violation)"
    }
  ],
  "still_broken": [
    {
      "comment_id": 2515862018,
      "file": "src/app/test_violation.component.ts",
      "issue": "Missing component prefix"
    }
  ]
}
```

## Step 1: Fetch ALL existing review comments

```bash
gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments --jq '[.[] | {id: .id, path: .path, line: .line, body: .body}]' > all-comments.json
```

## Step 2: For EACH comment, check if the issue is CURRENTLY FIXED

For every comment in all-comments.json:

1. Use Read tool to examine the current code at the file:line mentioned in the comment
2. Determine if the issue described in the comment still exists in the CURRENT state of the code
3. If the issue is FIXED (code is correct now): Add to "fixed" array with full details
4. If the issue is STILL BROKEN: Add to "still_broken" array

**IMPORTANT:** Check ALL comments regardless of when they were fixed. If an issue was fixed in a previous commit but auto_resolve was disabled, this run should resolve it now.

## Step 3: Fetch thread IDs for fixed issues

For each fixed issue, get the thread ID:

```bash
gh api graphql -f query='{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {PR_NUMBER}) {
      reviewThreads(first: 100) {
        nodes {
          id
          comments(first: 1) {
            nodes {
              databaseId
            }
          }
        }
      }
    }
  }
}'
```

Match comment IDs to thread IDs and include in the fixed-issues.json output.

## Step 4: Write the JSON file

Use the Write tool to create `fixed-issues.json` with the complete analysis.

**CRITICAL REQUIREMENTS:**

- Check EVERY existing comment (use Read tool for each file)
- Output must be valid JSON
- Include thread_id for every fixed issue
- DO NOT attempt to resolve threads yourself (another job will do that)
- DO NOT review new code or post new comments
