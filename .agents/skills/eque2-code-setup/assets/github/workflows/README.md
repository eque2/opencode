# AI PR review

Installed by `/eque2-code-setup`. Every pull request (opened, synchronised,
reopened) runs `pr-review.yml`, which:

1. Resolves earlier review threads that later commits fixed (`AUTO_RESOLVE_ON_FIXED`).
2. Reviews every changed file with Claude Code, posting inline comments and a
   summary comment.
3. Optionally checks the PR against its Jira ticket (`ENABLE_JIRA_INTEGRATION`,
   private repos only).

## Trust boundary

The workflow runs on `pull_request_target`, so GitHub loads `pr-review.yml`,
the reusable workflows, the scripts, the prompts and the local actions from the
**base branch**, never from the PR. The PR's own code is checked out into
`pr-source/` without credentials and is only read, never run. A PR therefore
cannot change the code that holds `CLAUDE_CODE_OAUTH_TOKEN`.

Two consequences:

- A change to these files takes effect only after it is merged. The PR that
  first adds them is not reviewed.
- Reviews run for PRs from branches in this repository, and for fork PRs only
  when the author is an owner, member or collaborator.

## Review rules

The review applies every rule file in `.github/review-rules/`. Generate them
with eque2-code's Install Styleguide skill — run `[IS]` (or
`/eque2-code-install-styleguide`) and commit the result. Without rule files
the review still runs, but only as a general quality and security review.

`/eque2-code-review` applies the same rules locally before you push.

## Secrets

| Secret | Needed for |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Always. Create it with `claude setup-token`. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Only when `ENABLE_JIRA_INTEGRATION` is `'true'`. |

## Settings

Edit the `env:` block at the top of `pr-review.yml`:

- `ENABLE_JIRA_INTEGRATION` — `'false'` by default.
- `AUTO_RESOLVE_ON_FIXED` — `'true'` by default.

Re-running `/eque2-code-setup` never overwrites a file here that you have
changed; it reports the file instead. Delete a file to take the shipped
version again.
