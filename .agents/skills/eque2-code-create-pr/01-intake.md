# Stage 1 — Intake & Branch Safety

Goal: know exactly what's shipping, what the base branch is, and that you are on a feature branch — before anything is committed.

## Confirm what's shipping

- Run `git status` and `git diff` (and `git diff --staged`) to see the actual changes. Don't assume — read the diff.
- If the arg was a handoff artifact (e.g. `bug-fix.md`), read it: its summary, root cause, and test evidence seed the PR description in Stage 6.
- Identify the ticket to link: from the arg (Jira key), the handoff artifact, or the branch name. If none is discoverable, ask — or proceed without one if the user confirms there's no ticket.

## Determine the base branch

- Detect the repo's default/base branch from the repo itself: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`, falling back to `git symbolic-ref refs/remotes/origin/HEAD`. If the project uses a non-default integration branch (e.g. `develop`), prefer Linus's recorded convention; if it's ambiguous, ask the user which branch this PR targets.

## Ensure you're on a feature branch

- **Never commit onto the base branch.** Check the current branch (`git branch --show-current`).
- If you're on the base branch (or a detached HEAD): create a feature branch and move the changes onto it. Name it from the ticket and a short slug (e.g. `proj-123-fix-null-crash`), following any naming convention the repo's recent branches show.
- If you're already on a feature branch: keep it. Confirm it's the intended one.

## Output of this stage

- The diff understood, the ticket identified, the base branch resolved, and a confirmed feature branch checked out.

Proceed to `02-review.md`.
