# Stage 4 — Sync with the Base Branch

Goal: bring the feature branch up to date with the latest base so the PR opens cleanly, without conflicts waiting for the reviewer.

## Fetch and integrate

- Fetch the latest base: `git fetch origin <base>`.
- Integrate it into the feature branch. Choose **rebase vs merge** by the repo's convention:
  - Infer from recent history — a linear history with no merge commits implies rebase; merge commits on feature branches imply merge.
  - If Linus's recorded git conventions specify one, follow that.
  - If it's genuinely ambiguous, ask the user once which they prefer.
- `git rebase origin/<base>` **or** `git merge origin/<base>` accordingly.

## Resolve conflicts

- If there are conflicts, resolve them carefully — understand both sides, don't blindly take one. After resolving, re-run the affected tests (a conflict resolution can silently break behaviour that Stage 3 verified).
- If conflicts are extensive or risky, surface them to the user rather than guessing.

## Output of this stage

- A feature branch that is up to date with the base and still green.

Proceed to `05-commit-push.md`.
