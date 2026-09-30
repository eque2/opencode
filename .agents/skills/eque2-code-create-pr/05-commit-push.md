# Stage 5 — Commit & Push

Goal: a clean, ticket-linked commit on the feature branch, pushed to the remote.

## Commit

- Stage the intended changes (`git add` the reviewed files — not blindly `git add -A` if Stage 2 stripped things out).
- Write a clear commit message following the repo's convention (inferred from recent history or Linus's recorded format): a concise subject describing *what changed and why*, the ticket key linked per convention, and a body for any non-obvious context.
- If the team squashes, a single well-formed commit is fine; if they keep history, group logically. Don't fabricate a multi-commit history that didn't happen.

## Push

- Push the feature branch and set upstream: `git push -u origin <feature-branch>`.
- If the branch already exists upstream and you rebased, you may need `--force-with-lease` (never plain `--force`) — and only on a branch that's yours, never on the base.

## Output of this stage

- The feature branch committed and pushed, ready for a PR.

Proceed to `06-open-pr.md`.
