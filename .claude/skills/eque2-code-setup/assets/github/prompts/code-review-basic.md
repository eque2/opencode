Review this pull request for code quality and post inline review comments via the GitHub reviews API.
{STYLEGUIDE_SECTION}

## Review Instructions

1. Fetch existing PR review comments to avoid duplicates:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments > existing-comments.json
   ```

2. Examine the PR changes using `git diff` and read the styleguide files (if any) to understand standards.

3. Walk the diff and collect every NEW issue (not already covered by an entry in `existing-comments.json`) into an in-memory list. **Do not post anything yet.** Each entry must capture: `path`, `line` (integer, must be a line in the diff), `body` (the full issue detail).

4. Build the review payload `review-payload.json`:

   ```json
   {
     "event": "COMMENT",
     "body": "",
     "comments": [
       {"path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "Issue 1 detail..."},
       {"path": "src/bar.ts", "line": 17, "side": "RIGHT", "body": "Issue 2 detail..."}
     ]
   }
   ```

   Every entry uses `side: "RIGHT"`. Single-line only — do not use `start_line` or `start_side`.

   **JSON validity is your responsibility.** Issue bodies often contain newlines, double quotes, backticks, and code fences. Construct the payload programmatically (e.g. via `jq -n` or by writing a script that builds the array) so all `body` strings are properly JSON-escaped. Do NOT hand-write the JSON by string interpolation — that produces invalid JSON whenever a body has a quote or newline. Validate locally with `jq empty review-payload.json` before submitting; abort if it fails.

   Preserve the order of findings in your in-memory list when adding to `comments[]` — the API returns inline comments in submission order, which lets you match them by index in step 7.

5. **Skip when empty:** if `comments` would be an empty array (zero new findings, or every finding deduped against `existing-comments.json`), DO NOT post the review. Skip directly to step 8 and post a summary stating no new issues.

6. Submit the review in ONE call:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/reviews --input review-payload.json > review-response.json
   ```

   Example response shape (illustrative — your actual `id` and `submitted_at` will differ; never hardcode these in the summary):

   ```json
   {
     "id": <integer>,
     "state": "COMMENTED",
     "submitted_at": "<ISO-8601 timestamp>"
   }
   ```

   If the call returns non-2xx, abort the workflow run. Do NOT fall back to per-comment posting. Do NOT post a summary in the failure case — the workflow should fail loudly so the failure is visible in CI status.

   Validate the response before continuing: confirm `review-response.json` is valid JSON and the top-level `.id` is a positive integer. If it isn't (e.g. response is an error envelope `{"message": "..."}`), abort.

7. Fetch each inline comment's `id` for the summary's anchor links. The create-review response does NOT include the inline comments — fetch them separately:

   ```bash
   REVIEW_ID=$(jq -er '.id | numbers' review-response.json) || { echo "Invalid review response"; exit 1; }
   gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/reviews/$REVIEW_ID/comments > review-comments.json
   ```

   Match comments to findings **by submission index**: the Nth entry in `review-comments.json` corresponds to the Nth entry you placed in `comments[]`. This handles the case where two findings share the same path and line (path+line is not a unique key). Use each entry's `id` to build the `#discussion_r<id>` anchor for the corresponding finding.

8. Post ONE summary comment on the PR conversation (see "Summary Comment Requirements" below). Skip this step's reference to `review-comments.json` if step 5's skip-when-empty rule applied — there is nothing to anchor to and the summary states "No new issues found".

## CRITICAL: Single Review Submission Requirements

YOU MUST POST EVERY INLINE FINDING IN A SINGLE REVIEW SUBMISSION. This is NON-NEGOTIABLE.

**NEVER call `gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments` to post a single comment.** That endpoint creates a standalone review per call, which generates a separate notification email per finding. ALL inline findings MUST be batched into the `comments[]` array of ONE call to `gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/reviews`.

For each individual finding:

1. Add ONE entry to the `comments[]` array — `{path, line, side: "RIGHT", body}`.
2. The `body` must contain the FULL details of the issue at that line.
3. Check the styleguide files for a "PR Review Comment Format" section and apply that formatting to each `body`.
4. Each entry in `comments[]` becomes its own review thread, anchored to its `line` — same UX as today, just submitted in one call.

DO NOT:

- Call `gh api .../pulls/{PR_NUMBER}/comments` for a single comment, ever.
- Submit multiple `.../reviews` calls per workflow run — batch ALL findings into ONE.
- Combine multiple findings into a single `body` — one entry per issue.
- Skip the review submission if you have findings (only skip when `comments[]` would be empty).

## CRITICAL: Summary Comment Requirements

The summary comment is ONLY for categorization and navigation. It MUST NOT contain issue details.

MANDATORY FORMAT for summary comment:

1. Categorize issues by severity (Critical, High, Medium, Low).
2. For each issue, provide ONLY:
   - ONE line description (max 80 characters)
   - A clickable link to the inline comment where the full details are
3. Do NOT repeat any details from the inline comments.
4. Do NOT explain the issues in the summary.
5. Links must use format: `[Brief description](#discussion_r<comment_id>)`
6. Extract `comment_id` from `review-comments.json` (step 7 above) — match the Nth finding to the Nth entry in `review-comments.json` by index, since path+line may not be unique.

Summary comment format:

```
gh pr comment {PR_NUMBER} --body "<!-- ai-workflow:code-review-summary -->
# Code Review Summary

## Critical Issues
- [Brief issue title](#discussion_r123456)
- [Another brief title](#discussion_r123457)

## High Priority Issues
- [Issue title](#discussion_r123458)

## Medium Priority Issues
- [Issue title](#discussion_r123459)

## Low Priority Issues
- [Issue title](#discussion_r123460)

## Overall Assessment
[2-3 sentences maximum - high level only, NO details]
```

If the review submission was skipped (no new findings), the summary should state "No new issues found" and omit the severity sections.

IMPORTANT: You MUST include the HTML comment marker `<!-- ai-workflow:code-review-summary -->` as the first line. This marker is invisible to users but required for workflow operation.

Focus on: Code quality, security, performance, testing, documentation, and styleguide compliance.

ABSOLUTE REQUIREMENTS - FAILURE TO FOLLOW THESE WILL RESULT IN INCORRECT OUTPUT:

1. ALL inline findings batched into ONE `gh api .../pulls/{PR_NUMBER}/reviews` call. Never per-comment posting.
2. Each finding becomes its own entry in `comments[]` with `{path, line, side: "RIGHT", body}` — body holds the full detail.
3. Skip the review submission entirely when `comments[]` would be empty; only post the summary.
4. Summary contains ONLY brief titles (max 1 line) + links to inline comments — no details, no explanations, no code examples.
5. All details belong in the inline comments' `body` field, NOT the summary.
6. Summary anchor IDs come from `review-comments.json`, fetched after the review is submitted.
