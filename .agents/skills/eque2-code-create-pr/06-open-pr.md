# Stage 6 — Open the PR (then STOP)

Goal: open a well-described pull request against the base branch — and stop there. No merge.

## Open it

- Create the PR with `gh pr create --base <base> --head <feature-branch>`.
- Write a description that gives the reviewer what they need:
  - **Summary** — what this PR does, in one or two lines.
  - **What & why** — the change and the reason for it (root cause if it's a fix; pull from the handoff artifact / `bug-fix.md` when present).
  - **Test evidence** — what was run and the result (the green suite from Stage 3; the failing-then-passing test if this came from [BF]).
  - **Ticket link** — link the Jira key per the repo's convention.
  - **Follow-ups** — any non-blocking findings noted in Stage 2.
- End the PR body with the repo's standard trailer if it has one.

## Move the ticket to "In Review" (Jira flow only — ask first)

Run this **only when a ticket was identified in Stage 1** (from the Jira-key arg, the handoff artifact, or the branch name) and the Atlassian MCP is available — that's the "Jira flow". Skip it when there's no ticket. Do it **after** the PR is open, and never transition silently.

1. **Resolve the target status.** Read BOND.md's "Their Jira Workflow" → *"In review" status*. If the sanctum isn't loaded or that field is unset, you have no recorded target — go to the discovery prompt in step 3.
2. **Read the ticket's state.** Call `getTransitionsForJiraIssue` for the key to get the current status and the transitions actually available from it.
3. **Ask before moving:**
   - Recorded target found **and** offered as a transition: _"PR is open. Want me to move `PROJ-123` from **{current}** to **{in-review}**? (y/n)"_
   - No recorded target, or it isn't an available transition from the current status: _"PR is open. `PROJ-123` is in **{current}**. Available moves: {list}. Move it on (which?), or leave it?"_ — and if they pick one, offer to remember it in BOND.md's "In review" status for next time.
   - **No transitions available at all** (e.g. the ticket is closed/terminal): say so in one line — _"`PROJ-123` is **{current}** with no available transitions — leaving it as is; the PR is open."_ — and skip. Never render an empty "Available moves:" list.
   - Already sitting in the in-review status: skip silently.
4. **On confirmation**, apply it with `transitionJiraIssue`. On decline or skip, leave the ticket as it is.
5. **Never let this block shipping.** The PR is already open and that's the deliverable. If the MCP is unavailable or the transition is rejected, surface a one-line note and carry on.

## Stop — do not merge

- **Do not** `gh pr merge`, do not enable auto-merge. This workflow ends at an open PR; merging is the reviewer's / CI's decision. If the user explicitly asks you to merge, that's their call to make in the moment — but the workflow does not do it on its own.
- Report the PR URL and a one-line summary of what's now up for review (note the ticket status if you moved it).

## Session close (if running as Linus)

If the sanctum was loaded, follow Linus's memory discipline: note anything worth keeping (a review pattern that recurs, a fragile area, a convention you had to infer) to MEMORY.md, and append a brief session-log line.
